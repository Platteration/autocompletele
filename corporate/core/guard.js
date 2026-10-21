// actle Guard (work in progress): compliance checks on what a person is about
// to send, in any application. Administrators ship rule packs per regulation
// in the policy; a rule combines keywords and detectors (card numbers, IBANs,
// national ID numbers, internal project codes, forbidden promises, secrets),
// may apply only when a recipient is outside the organisation, warns with a
// message and may offer a one-click fix. Findings carry masked values only,
// and the audit trail is counts per rule: no typed text ever leaves the desk.
// Pure and local: reading recipients and showing warnings are the shell's job.
"use strict";

const { containsCardNumber, baseName } = require("./capture-policy.js");
const { keywordPattern, createState, MATCH } = require("./keyword-rules.js");

const SEVERITIES = Object.freeze(["info", "warn", "block"]);
const RECIPIENTS = Object.freeze(["any", "external"]);
const FIX_KINDS = Object.freeze(["text", "remove", "shorthand"]);
const OUTCOMES = Object.freeze(["raised", "fixed", "dismissed"]);
const NORMALISED = new WeakSet();

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(asText).filter(Boolean);
}

function squash(value) {
  return String(value).replace(/\s+/g, " ").toLowerCase();
}

/** Star every letter and digit except `start` leading and `end` trailing ones; at most half stay visible. */
function mask(value, start, end) {
  const text = String(value);
  const total = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const tail = Math.min(end, Math.floor(total / 2));
  const head = Math.min(start, Math.floor(total / 2) - tail);
  let k = 0;
  return text.replace(/[\p{L}\p{N}]/gu, (ch) => (k++ < head || k > total - tail ? ch : "*"));
}

function span(kind, match, value, extra) {
  return Object.assign({ kind, value, index: match.index, end: match.index + match[0].length }, extra);
}

/** Remainder of a string of digits and letters (A=10..Z=35) modulo 97, as ISO 7064 uses it. */
function mod97(text) {
  let rest = 0;
  for (const ch of text.toUpperCase()) {
    const v = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    rest = (rest * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rest;
}

function validIban(text) {
  const compact = text.replace(/ /g, "");
  return compact.length >= 15 && compact.length <= 34 && mod97(compact.slice(4) + compact.slice(0, 4)) === 1;
}

const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
const IBAN = /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,3})?(?![A-Za-z0-9])/g;
const EMAIL = /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
const PHONE = /(?<![\w+])(?:\+|00)?\d(?:[ ()./-]{0,2}\d){6,16}(?![\w])/g;
const DATE_LIKE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2}))(?:[ T]\d{1,2})?$/;
// Same shapes as capture-policy.js uses for scrubbing (not exported there).
const SECRET_LABEL = /\b(password|passwd|passcode|passphrase|pwd|pin|secret|token|api[ _-]?key|otp)\b(\s*(?:[:=]|is)\s*)(\S+)/gi;
const TOKEN = /(?<![\w\/@.-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![\w\/@.-])/g;
const ES_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

// National ID numbers by ISO country code. US and GB have no check digit, so
// only their format and allocation rules are checked; ES and FR have one.
const NATIONAL_IDS = Object.freeze({
  // US Social Security number, written with dashes or spaces; area 000, 666 and 9xx, group 00 and serial 0000 are never issued.
  US: { re: /(?<![\d-])(\d{3})[- ](\d{2})[- ](\d{4})(?![\d-])/g, valid: (m) => m[1] !== "000" && m[1] !== "666" && m[1][0] !== "9" && m[2] !== "00" && m[3] !== "0000" },
  // UK National Insurance number; letter rules from HMRC, prefixes BG GB NK KN TN NT ZZ never issued.
  GB: { re: /(?<![A-Za-z0-9])([A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]) ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/gi, valid: (m) => !["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"].includes(m[1].toUpperCase()) },
  // Spanish DNI (8 digits) and NIE (X/Y/Z + 7 digits); check letter is the number modulo 23.
  ES: { re: /(?<![A-Za-z0-9])(?:([XYZ])-?(\d{7})|(\d{8}))-?([A-Z])(?![A-Za-z0-9])/gi, valid: (m) => ES_LETTERS[Number(m[1] ? "XYZ".indexOf(m[1].toUpperCase()) + m[2] : m[3]) % 23] === m[4].toUpperCase() },
  // French NIR (social security number); key is 97 minus the 13-digit number modulo 97, Corsica 2A/2B counted as 19/18.
  FR: { re: /(?<![A-Za-z0-9])([12]) ?(\d{2}) ?(\d{2}) ?(\d{2}|2[AB]) ?(\d{3}) ?(\d{3}) ?(\d{2})(?![A-Za-z0-9])/gi, valid: (m) => 97 - mod97((m[1] + m[2] + m[3] + m[4] + m[5] + m[6]).toUpperCase().replace("2A", "19").replace("2B", "18")) === Number(m[7]) },
});
const COUNTRIES = Object.freeze(Object.keys(NATIONAL_IDS));

// Each scanner returns spans {kind, value (masked), index, end}; DETECTORS drops `end`.
const SCANNERS = {
  // Threat: a payment card number pasted into chat or mail (PCI DSS). Luhn-checked by capture-policy.
  "card-number": (text) => [...text.matchAll(CARD)].filter((m) => containsCardNumber(m[0])).map((m) => span("card-number", m, mask(m[0], 0, 4))),
  // Threat: bank account details sent to the wrong party. ISO 13616 mod-97 check; a trailing word swallowed by the grouping is dropped and retried.
  iban(text) {
    const out = [];
    for (const m of text.matchAll(IBAN)) {
      let candidate = m[0];
      while (!validIban(candidate) && candidate.lastIndexOf(" ") > 4) candidate = candidate.slice(0, candidate.lastIndexOf(" "));
      if (validIban(candidate)) out.push(span("iban", { index: m.index, 0: candidate }, mask(candidate, 2, 2)));
    }
    return out;
  },
  // Threat: personal data (a customer's address) shared outside the organisation. Local part masked, domain kept.
  email: (text) => [...text.matchAll(EMAIL)].map((m) => span("email", m, m[0][0] + "***" + m[0].slice(m[0].lastIndexOf("@")))),
  // Threat: personal phone numbers shared outside the organisation. Loose: 9 to 15 digits, 8 with a + or 00 prefix; dates skipped; order numbers can match.
  phone(text) {
    return [...text.matchAll(PHONE)].filter((m) => {
      const digits = m[0].replace(/\D/g, "").length;
      return !DATE_LIKE.test(m[0]) && digits <= 15 && digits >= (/^(?:\+|00)/.test(m[0]) ? 8 : 9);
    }).map((m) => span("phone", m, mask(m[0], 0, 2)));
  },
  // Threat: a national ID number typed into chat or mail (identity theft, GDPR art. 87). Countries per rule; all by default.
  "national-id"(text, options) {
    const out = [];
    for (const country of options.countries && options.countries.length ? options.countries : COUNTRIES) {
      const { re, valid } = NATIONAL_IDS[country];
      for (const m of text.matchAll(re)) if (valid(m)) out.push(span("national-id", m, mask(m[0], 0, 2), { country }));
    }
    return out;
  },
  // Threat: a promise the organisation must not make ("guaranteed"). Policy text, so not masked.
  "forbidden-phrase"(text, options) {
    const out = [];
    for (const phrase of options.phrases || []) {
      const re = keywordPattern(phrase, options.caseSensitive);
      for (const m of text.matchAll(new RegExp(re.source, re.flags + "g"))) out.push(span("forbidden-phrase", m, m[0]));
    }
    return out;
  },
  // Threat: an internal project code leaking to an external recipient. Patterns come from the policy.
  "internal-code"(text, options) {
    const out = [];
    for (const re of options.codes || []) {
      for (const m of text.matchAll(re)) if (m[0]) out.push(span("internal-code", m, mask(m[0], 3, 0)));
    }
    return out;
  },
  // Threat: a password or token pasted into a message. The secret itself is never returned, not even in part.
  secret(text) {
    const out = [];
    for (const m of text.matchAll(SECRET_LABEL)) {
      const index = m.index + m[1].length + m[2].length;
      out.push({ kind: "secret", value: m[1] + m[2] + "****", index, end: index + m[3].length });
    }
    for (const m of text.matchAll(TOKEN)) {
      if (!out.some((s) => m.index < s.end && m.index + m[0].length > s.index)) out.push(span("secret", m, "****"));
    }
    return out;
  },
};

const DETECTORS = Object.freeze(Object.fromEntries(Object.entries(SCANNERS).map(([name, scan]) => [
  name, (text, options) => scan(String(text == null ? "" : text), options || {}).map(({ end, ...finding }) => finding),
])));

function normalizeFix(raw, id, warnings) {
  if (raw == null) return null;
  const fix = isObject(raw) ? raw : { kind: "text", text: raw };
  const fail = (why) => (warnings.push("guard rule " + id + ": fix ignored, " + why), null);
  if (!FIX_KINDS.includes(fix.kind)) return fail("kind must be text, remove or shorthand");
  if (fix.kind === "text") {
    if (!asText(fix.text)) return fail("empty text");
    return { kind: "text", text: String(fix.text), position: fix.position === "start" ? "start" : "end" };
  }
  if (fix.kind === "shorthand") return asText(fix.trigger) ? { kind: "shorthand", trigger: asText(fix.trigger) } : fail("no shorthand trigger");
  return { kind: "remove", with: fix.with == null ? "" : String(fix.with) };
}

function normalizeRule(raw, pack, index, guard, ids) {
  const warnings = guard.warnings;
  if (!isObject(raw)) {
    warnings.push("guard rule " + pack + "/" + index + " ignored: not an object");
    return null;
  }
  let id = asText(raw.id) || pack + "-" + index;
  while (ids.has(id)) id += "-dup";
  const skip = (why) => (warnings.push("guard rule " + id + " ignored: " + why), null);
  const keywords = list(raw.keywords);
  const detect = list(raw.detect);
  const unknown = detect.filter((name) => !Object.hasOwn(SCANNERS, name));
  if (unknown.length) return skip("unknown detector " + unknown.join(", ") + " (known: " + Object.keys(SCANNERS).join(", ") + ")");
  if (!keywords.length && !detect.length) return skip("no keywords or detectors");
  const phrases = list(raw.phrases);
  if (detect.includes("forbidden-phrase") && !phrases.length) return skip("forbidden-phrase needs `phrases`");
  if (detect.includes("internal-code") && !guard.internalCodes.length) return skip("internal-code needs `internalCodes` in the guard section");
  const asked = list(raw.countries).map((c) => c.toUpperCase());
  const countries = asked.filter((c) => COUNTRIES.includes(c));
  const unsupported = asked.filter((c) => !countries.includes(c)).join(", ") + " (known: " + COUNTRIES.join(", ") + ")";
  if (asked.length && !countries.length) return skip("no supported country: " + unsupported);
  if (asked.length > countries.length) warnings.push("guard rule " + id + ": unknown countries " + unsupported + " ignored");
  const message = asText(raw.message);
  if (!message) return skip("a warning needs a message");
  const oneOf = (name, allowed) => {
    if (raw[name] === undefined || allowed.includes(raw[name])) return raw[name] === undefined ? allowed[0] : raw[name];
    warnings.push("guard rule " + id + ": " + name + " must be " + allowed.join(" or ") + "; using " + allowed[0]);
    return allowed[0];
  };
  // An unreadable recipients value widens the rule (warn more), never narrows it.
  const severity = oneOf("severity", ["warn", "info", "block"]);
  const recipients = oneOf("recipients", RECIPIENTS);
  ids.add(id);
  const caseSensitive = raw.caseSensitive === true;
  return {
    id,
    label: asText(raw.label) || id,
    pack,
    detect,
    keywords,
    match: MATCH.includes(raw.match) ? raw.match : "any",
    caseSensitive,
    unless: list(raw.unless),
    apps: list(raw.apps).map(baseName).filter(Boolean),
    message,
    fix: normalizeFix(raw.fix, id, warnings),
    severity,
    recipients,
    options: { phrases, codes: guard.internalCodes, countries, caseSensitive },
  };
}

/** Validate the `guard` policy section. Unusable parts are dropped with a warning; the section is never refused. */
function normalizeGuard(raw) {
  const warnings = [];
  const guard = { packs: [], internalDomains: [], internalCodes: [], warnings };
  if (raw != null && !isObject(raw)) warnings.push("guard section ignored: not an object");
  const source = isObject(raw) ? raw : {};
  for (const entry of list(source.internalDomains)) {
    const domain = entry.toLowerCase().replace(/^[@*.]+/, "");
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) warnings.push("guard internal domain " + entry + " ignored: not a domain name");
    else if (!guard.internalDomains.includes(domain)) guard.internalDomains.push(domain);
  }
  for (const pattern of list(source.internalCodes)) {
    try {
      guard.internalCodes.push(new RegExp(pattern, "g"));
    } catch (error) {
      warnings.push("guard internal code " + pattern + " ignored: invalid pattern (" + error.message + ")");
    }
  }
  if (source.packs != null && !Array.isArray(source.packs)) warnings.push("guard packs ignored: not a list");
  const packIds = new Set();
  const ruleIds = new Set();
  (Array.isArray(source.packs) ? source.packs : []).forEach((raw, index) => {
    if (!isObject(raw)) return warnings.push("guard pack " + index + " ignored: not an object");
    let id = asText(raw.id) || "pack-" + index;
    while (packIds.has(id)) id += "-dup";
    const rules = (Array.isArray(raw.rules) ? raw.rules : [])
      .map((rule, i) => normalizeRule(rule, id, i, guard, ruleIds)).filter(Boolean);
    if (!rules.length) return warnings.push("guard pack " + id + " ignored: no usable rules");
    packIds.add(id);
    guard.packs.push({ id, label: asText(raw.label) || id, rules });
  });
  const external = guard.packs.flatMap((p) => p.rules).filter((r) => r.recipients === "external");
  if (external.length && !guard.internalDomains.length) warnings.push("guard has no internalDomains: every recipient counts as external for " + external.map((r) => r.id).join(", "));
  NORMALISED.add(guard);
  return guard;
}

/** True when some recipient's domain is not internal. A recipient without a readable address counts as external. */
function hasExternalRecipient(recipients, internalDomains) {
  const domains = Array.isArray(internalDomains) ? internalDomains : [];
  return (Array.isArray(recipients) ? recipients : []).some((recipient) => {
    const text = asText(recipient).toLowerCase().replace(/[>\s.]+$/, "");
    const domain = text.includes("@") ? text.slice(text.lastIndexOf("@") + 1) : "";
    return !domain || !domains.some((d) => domain === d || domain.endsWith("." + d));
  });
}

/** Keyword and detector spans when the rule's conditions hold in `text`, else null. */
function ruleSpans(text, rule) {
  const keywordSpans = [];
  let matched = 0;
  for (const keyword of rule.keywords) {
    const re = keywordPattern(keyword, rule.caseSensitive);
    const found = [...text.matchAll(new RegExp(re.source, re.flags + "g"))].map((m) => span("keyword", m, m[0]));
    if (found.length) matched++;
    keywordSpans.push(...found);
  }
  if (rule.keywords.length && !(rule.match === "all" ? matched === rule.keywords.length : matched > 0)) return null;
  const detected = rule.detect.flatMap((name) => SCANNERS[name](text, rule.options));
  if (rule.detect.length && !detected.length) return null;
  return { keywords: keywordSpans, detected };
}

/**
 * Rules that fire on `text` for `context` ({recipients, app, title}). A rule
 * with recipients "external" needs at least one recipient outside
 * internalDomains (no recipients known: it does not fire); `unless` phrases
 * anywhere in the text suppress it; with a `state` (createState) each rule
 * fires once until the state is reset.
 * @returns {Array<{rule, severity, message, findings, fix}>}
 */
function check(text, context, config, state) {
  const guard = NORMALISED.has(config) ? config : normalizeGuard(config);
  const source = String(text == null ? "" : text);
  const ctx = isObject(context) ? context : {};
  const external = hasExternalRecipient(ctx.recipients, guard.internalDomains);
  const app = baseName(ctx.app);
  const offered = state && state.offered;
  let whole = null;
  const hits = [];
  for (const rule of guard.packs.flatMap((pack) => pack.rules)) {
    if (offered && offered.has(rule.id)) continue;
    if (rule.recipients === "external" && !external) continue;
    if (rule.apps.length && !rule.apps.includes(app)) continue;
    const spans = ruleSpans(source, rule);
    if (!spans) continue;
    if (rule.unless.length) {
      if (whole === null) whole = squash(source);
      if (rule.unless.some((phrase) => whole.includes(squash(phrase)))) continue;
    }
    if (offered) offered.add(rule.id);
    const findings = spans.keywords.concat(spans.detected).sort((a, b) => a.index - b.index).map(({ end, ...finding }) => finding);
    hits.push({ rule, severity: rule.severity, message: rule.message, findings, fix: rule.fix });
  }
  return hits;
}

/**
 * The text with the hit's fix applied. "text" adds the fix text (at the end
 * unless position is "start") when it is not already there; "shorthand" does
 * the same with resolve(trigger), and returns the text unchanged without a
 * resolver; "remove" finds the rule's detector findings again in this text
 * (keyword findings when the rule has no detectors) and removes or replaces
 * them, so a stale index can never cut the wrong characters.
 */
function applyFix(text, hit, resolve) {
  const source = String(text == null ? "" : text);
  const fix = hit && hit.fix;
  if (!fix) return source;
  if (fix.kind !== "remove") {
    const addition = fix.kind === "text" ? fix.text : typeof resolve === "function" ? resolve(fix.trigger) : null;
    if (typeof addition !== "string" || squash(source).includes(squash(addition).trim())) return source;
    const joint = fix.position === "start" ? addition.slice(-1) + source.slice(0, 1) : source.slice(-1) + addition.slice(0, 1);
    const gap = source && !/\s/.test(joint) ? "\n\n" : "";
    return fix.position === "start" ? addition + gap + source : source + gap + addition;
  }
  const spans = hit.rule ? ruleSpans(source, hit.rule) : null;
  if (!spans) return source;
  const targets = (hit.rule.detect.length ? spans.detected : spans.keywords).sort((a, b) => a.index - b.index);
  const merged = [];
  for (const s of targets) {
    const last = merged[merged.length - 1];
    if (last && s.index < last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ index: s.index, end: s.end });
  }
  const replacement = fix.with == null ? "" : String(fix.with);
  let out = source;
  for (const s of merged.reverse()) {
    let end = s.end;
    if (!replacement && out[s.index - 1] === " " && out[end] === " ") end++;
    out = out.slice(0, s.index) + replacement + out.slice(end);
  }
  return out;
}

/** The audit line for a warning: rule, pack, outcome and time. Counts only; no text, no findings. */
function auditEntry(hit, outcome, at) {
  if (!hit || !hit.rule || !OUTCOMES.includes(outcome)) return null;
  return { rule: hit.rule.id, pack: hit.rule.pack, outcome, at: Number.isFinite(Number(at)) ? Number(at) : Date.now() };
}

/**
 * Counts for a report: warnings raised, accepted (outcome "fixed"),
 * dismissed and unanswered (raised with neither), per rule and per pack.
 * Entries that are not audit lines are skipped and counted.
 */
function summarise(auditEntries) {
  const zero = () => ({ raised: 0, accepted: 0, dismissed: 0, unanswered: 0 });
  const total = zero();
  const byRule = new Map();
  const byPack = new Map();
  let skipped = 0;
  for (const entry of Array.isArray(auditEntries) ? auditEntries : []) {
    if (!isObject(entry) || !asText(entry.rule) || !OUTCOMES.includes(entry.outcome)) {
      skipped++;
      continue;
    }
    const field = entry.outcome === "fixed" ? "accepted" : entry.outcome;
    const pack = asText(entry.pack);
    const ruleKey = pack + "\u0000" + asText(entry.rule);
    if (!byRule.has(ruleKey)) byRule.set(ruleKey, Object.assign({ rule: asText(entry.rule), pack }, zero()));
    if (!byPack.has(pack)) byPack.set(pack, Object.assign({ pack }, zero()));
    for (const row of [total, byRule.get(ruleKey), byPack.get(pack)]) row[field] += 1;
  }
  const finish = (row) => Object.assign(row, { unanswered: Math.max(0, row.raised - row.accepted - row.dismissed) });
  const order = (a, b) => b.raised - a.raised || (a.rule || a.pack).localeCompare(b.rule || b.pack);
  return {
    total: finish(total),
    byPack: [...byPack.values()].map(finish).sort(order),
    byRule: [...byRule.values()].map(finish).sort(order),
    skipped,
  };
}

module.exports = {
  SEVERITIES, RECIPIENTS, FIX_KINDS, OUTCOMES, COUNTRIES, DETECTORS,
  mask, normalizeGuard, hasExternalRecipient, createState, check, applyFix, auditEntry, summarise,
};
