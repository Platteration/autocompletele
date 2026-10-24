// Keyword rules: when the words a person writes include a rule's keywords, the
// assistant offers to insert something predetermined (a text, a saved shortcut
// or a document set). A rule with action "warn" shows a message instead, for
// example "contract" without the legal disclaimer, or a card number in a
// message, and may offer a fix. Detection looks at the recent text of the
// current field and fires each rule once per field session.
"use strict";

const { containsCardNumber } = require("./capture-policy.js");

const DEFAULTS = Object.freeze({ windowChars: 500 });
const MATCH = Object.freeze(["any", "all"]);
const INSERT_KINDS = Object.freeze(["text", "shorthand", "document"]);
const ACTIONS = Object.freeze(["offer", "warn"]);
const DETECTORS = Object.freeze({ "card-number": containsCardNumber });

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
  let whole = null;
  const hits = [];
  for (const rule of list) {
    if (state && state.offered && state.offered.has(rule.id)) continue;
    const keywords = rule.keywords || [];
    const matched = keywords.filter((keyword) => keywordPattern(keyword, rule.caseSensitive).test(recent));
    if (keywords.length && !(rule.match === "all" ? matched.length === keywords.length : matched.length > 0)) continue;
    const detected = (rule.detect || []).filter((name) => DETECTORS[name](recent));
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

module.exports = { DEFAULTS, MATCH, INSERT_KINDS, ACTIONS, DETECTORS, normalizeRules, createState, detect, keywordPattern };
