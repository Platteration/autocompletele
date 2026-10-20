// Keyword rules: when the words a person writes include a rule's keywords, the
// assistant offers to insert something predetermined (a text, a saved shortcut
// or a document set). A rule with action "warn" shows a message instead, for
// example "contract" without the legal disclaimer, or a card number in a
// message, and may offer a fix. Detection looks at the recent text of the
// current field and fires each rule once per field session.
"use strict";

const { containsCardNumber, luhn, baseName } = require("./capture-policy.js");

const DEFAULTS = Object.freeze({ windowChars: 500 });
const MATCH = Object.freeze(["any", "all"]);
const INSERT_KINDS = Object.freeze(["text", "shorthand", "document"]);
const ACTIONS = Object.freeze(["offer", "warn"]);

// Built-in detectors. Each takes (text, rule, context) and answers whether the
// thing it looks for is present. Formats with a check digit are verified, so
// an order number or a phone number does not pass as an identity number.

function mod97(digits) {
  let remainder = 0;
  for (let i = 0; i < digits.length; i += 7) {
    remainder = Number(String(remainder) + digits.slice(i, i + 7)) % 97;
  }
  return remainder;
}

/**
 * International bank account number, either compact (GB82WEST12345698765432) or
 * printed in groups of four (GB82 WEST 1234 5698 7654 32), with mod-97 over
 * the rearranged number. Country code, two check digits, 15 to 34 characters.
 */
function containsIban(text) {
  const tokens = String(text == null ? "" : text).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const valid = (compact) => {
    if (compact.length < 15 || compact.length > 34) return false;
    const rearranged = compact.slice(4) + compact.slice(0, 4);
    const digits = rearranged.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
    return mod97(digits) === 1;
  };
  for (let i = 0; i < tokens.length; i++) {
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]*$/.test(tokens[i])) continue;
    if (tokens[i].length > 4) {
      if (valid(tokens[i])) return true;
      continue;
    }
    let candidate = tokens[i];
    for (let j = i + 1; j < tokens.length; j++) {
      if (/^[A-Z0-9]{4}$/.test(tokens[j])) {
        candidate += tokens[j];
        continue;
      }
      if (/^[A-Z0-9]{1,3}$/.test(tokens[j])) candidate += tokens[j];
      break;
    }
    if (valid(candidate)) return true;
  }
  return false;
}

const UK_NI_BAD_PREFIX = new Set(["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"]);
/** UK National Insurance number: two letters, six digits, suffix A to D. */
function containsUkNi(text) {
  const source = String(text == null ? "" : text).toUpperCase();
  for (const match of source.matchAll(/(?<![A-Z0-9])([A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]) ?(\d{2}) ?(\d{2}) ?(\d{2}) ?([A-D])(?![A-Z0-9])/g)) {
    if (!UK_NI_BAD_PREFIX.has(match[1])) return true;
  }
  return false;
}

/** US Social Security number in its written form, with the ranges never issued excluded. */
function containsUsSsn(text) {
  const source = String(text == null ? "" : text);
  for (const match of source.matchAll(/(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)/g)) {
    const area = Number(match[1]);
    if (area === 0 || area === 666 || area >= 900) continue;
    if (Number(match[2]) === 0 || Number(match[3]) === 0) continue;
    return true;
  }
  return false;
}

/** Swedish personnummer: YYMMDD-NNNC, Luhn over the ten digits, with a valid month and day. */
function containsSePersonnummer(text) {
  const source = String(text == null ? "" : text);
  for (const match of source.matchAll(/(?<!\d)(?:\d{2})?(\d{2})(\d{2})(\d{2})[-+]?(\d{4})(?!\d)/g)) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (luhn(match[1] + match[2] + match[3] + match[4])) return true;
  }
  return false;
}

/** Dutch citizen service number: nine digits passing the 11-proof. */
function containsNlBsn(text) {
  const source = String(text == null ? "" : text);
  for (const match of source.matchAll(/(?<![\d.-])(\d{9})(?![\d.-])/g)) {
    const digits = match[1];
    if (/^0+$/.test(digits)) continue;
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += Number(digits[i]) * (9 - i);
    sum -= Number(digits[8]);
    if (sum % 11 === 0) return true;
  }
  return false;
}

/** An e-mail address whose domain is not one of the rule's allowed domains (or a subdomain of one). */
function containsExternalEmail(text, rule) {
  const allowed = ((rule && rule.params && rule.params.allowedDomains) || []).map((d) => String(d).toLowerCase());
  if (!allowed.length) return false;
  const source = String(text == null ? "" : text);
  for (const match of source.matchAll(/[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})(?![\w.-])/gi)) {
    const domain = match[1].toLowerCase();
    if (!allowed.some((d) => domain === d || domain.endsWith("." + d))) return true;
  }
  return false;
}

/** True while nothing has been attached in this field (pair with keywords such as "attached"). */
function missingAttachment(text, rule, context) {
  return !(context && Number(context.attachments) > 0);
}

const DETECTORS = Object.freeze({
  "card-number": containsCardNumber,
  iban: containsIban,
  "uk-ni": containsUkNi,
  "us-ssn": containsUsSsn,
  "se-personnummer": containsSePersonnummer,
  "nl-bsn": containsNlBsn,
  "external-email-domain": containsExternalEmail,
  "missing-attachment": missingAttachment,
});

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeInsert(raw, warnings, id) {
  const source = raw && typeof raw === "object" ? raw : { kind: "text", text: raw };
  const kind = INSERT_KINDS.includes(source.kind) ? source.kind : "text";
  if (kind === "text") {
    const text = String(source.text == null ? "" : source.text);
    if (!text) {
      warnings.push("keyword rule " + id + " ignored: empty text");
      return null;
    }
    return { kind, text };
  }
  if (kind === "shorthand") {
    const trigger = asText(source.trigger);
    if (!trigger) {
      warnings.push("keyword rule " + id + " ignored: no shorthand trigger");
      return null;
    }
    return { kind, trigger };
  }
  const shortcut = asText(source.shortcut);
  if (!shortcut) {
    warnings.push("keyword rule " + id + " ignored: no document shortcut");
    return null;
  }
  return { kind, shortcut };
}

/** Validate rules; unusable ones are dropped with a warning. */
function normalizeRules(list) {
  const warnings = [];
  const rules = [];
  const ids = new Set();
  (Array.isArray(list) ? list : []).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      warnings.push("keyword rule " + index + " ignored: not an object");
      return;
    }
    let id = asText(raw.id) || "keyword-" + index;
    while (ids.has(id)) id += "-dup";
    const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [raw.keywords]).map(asText).filter(Boolean);
    const detect = (Array.isArray(raw.detect) ? raw.detect : [raw.detect]).map(asText).filter(Boolean);
    const unknown = detect.filter((name) => !Object.hasOwn(DETECTORS, name));
    if (unknown.length) {
      warnings.push("keyword rule " + id + " ignored: unknown detector " + unknown.join(", ") + " (known: " + Object.keys(DETECTORS).join(", ") + ")");
      return;
    }
    const params = raw.params && typeof raw.params === "object" && !Array.isArray(raw.params) ? Object.assign({}, raw.params) : {};
    if (detect.includes("external-email-domain")) {
      params.allowedDomains = (Array.isArray(params.allowedDomains) ? params.allowedDomains : [params.allowedDomains]).map(asText).filter(Boolean).map((d) => d.toLowerCase());
      if (!params.allowedDomains.length) {
        warnings.push("keyword rule " + id + " ignored: external-email-domain needs params.allowedDomains");
        return;
      }
    }
    // Restrict a rule to some applications (process names, as the capture rules use them).
    const apps = (Array.isArray(raw.apps) ? raw.apps : [raw.apps]).map(baseName).filter(Boolean);
    if (!keywords.length && !detect.length) {
      warnings.push("keyword rule " + id + " ignored: no keywords");
      return;
    }
    const action = raw.action === undefined ? "offer" : raw.action;
    if (!ACTIONS.includes(action)) {
      warnings.push("keyword rule " + id + " ignored: action must be offer or warn");
      return;
    }
    const message = asText(raw.message);
    if (action === "warn" && !message) {
      warnings.push("keyword rule " + id + " ignored: a warning needs a message");
      return;
    }
    // An offer needs something to insert; for a warning the insert is an optional fix.
    const insert = action === "warn" && raw.insert == null ? null : normalizeInsert(raw.insert, warnings, id);
    if (!insert && action === "offer") return;
    if (action === "warn" && raw.insert != null && !insert) return;
    ids.add(id);
    rules.push({
      id,
      label: asText(raw.label) || keywords.concat(detect).join(", "),
      action,
      message,
      keywords,
      detect,
      unless: (Array.isArray(raw.unless) ? raw.unless : [raw.unless]).map(asText).filter(Boolean),
      params,
      apps,
      match: MATCH.includes(raw.match) ? raw.match : "any",
      caseSensitive: raw.caseSensitive === true,
      insert,
    });
  });
  return { rules, warnings };
}

function keywordPattern(keyword, caseSensitive) {
  // Word boundaries that work for accented and non-Latin letters too.
  return new RegExp("(?<![\\p{L}\\p{N}_])" + escapeRegExp(keyword) + "(?![\\p{L}\\p{N}_])", caseSensitive ? "u" : "iu");
}

/** Session state: which rules were already offered in this field. */
function createState() {
  const offered = new Set();
  return {
    offered,
    reset() { offered.clear(); },
    dismiss(id) { offered.add(id); },
  };
}

function squash(value) {
  return String(value).replace(/\s+/g, " ").toLowerCase();
}

/**
 * Find rules whose conditions hold: keywords in the recent text (if the rule
 * has keywords), a detector firing on the recent text (if it has detectors),
 * and none of its `unless` phrases in the field text the engine holds (the
 * last 4,000 characters typed or inserted since the field got the focus).
 * @returns {Array<{rule:object, matched:string[]}>}
 */
function detect(text, rules, state, options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const list = Array.isArray(rules) ? rules : rules && Array.isArray(rules.rules) ? rules.rules : [];
  const source = String(text == null ? "" : text);
  const recent = source.length > settings.windowChars ? source.slice(-settings.windowChars) : source;
  const context = settings.context && typeof settings.context === "object" ? settings.context : {};
  const app = baseName(context.app);
  let whole = null;
  const hits = [];
  for (const rule of list) {
    if (state && state.offered && state.offered.has(rule.id)) continue;
    if (rule.apps && rule.apps.length && !rule.apps.includes(app)) continue;
    const keywords = rule.keywords || [];
    const matched = keywords.filter((keyword) => keywordPattern(keyword, rule.caseSensitive).test(recent));
    if (keywords.length && !(rule.match === "all" ? matched.length === keywords.length : matched.length > 0)) continue;
    const detected = (rule.detect || []).filter((name) => DETECTORS[name](recent, rule, context));
    if ((rule.detect || []).length && !detected.length) continue;
    if ((rule.unless || []).length) {
      if (whole === null) whole = squash(source);
      if (rule.unless.some((phrase) => whole.includes(squash(phrase)))) continue;
    }
    if (state && state.offered) state.offered.add(rule.id);
    hits.push({ rule, matched: matched.concat(detected) });
  }
  return hits;
}

module.exports = { DEFAULTS, MATCH, INSERT_KINDS, ACTIONS, DETECTORS, normalizeRules, createState, detect };
