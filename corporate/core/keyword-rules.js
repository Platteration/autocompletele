// Keyword rules: when the words a person writes include a rule's keywords, the
// assistant offers to insert something predetermined (a text, a saved shortcut
// or a document set). Detection looks only at the recent text of the current
// field and offers each rule once per field session unless the person asks again.
"use strict";

const DEFAULTS = Object.freeze({ windowChars: 500 });
const MATCH = Object.freeze(["any", "all"]);
const INSERT_KINDS = Object.freeze(["text", "shorthand", "document"]);

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
    if (!keywords.length) {
      warnings.push("keyword rule " + id + " ignored: no keywords");
      return;
    }
    const insert = normalizeInsert(raw.insert, warnings, id);
    if (!insert) return;
    ids.add(id);
    rules.push({
      id,
      label: asText(raw.label) || keywords.join(", "),
      keywords,
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

/**
 * Find rules whose keywords appear in the recent text.
 * @returns {Array<{rule:object, matched:string[]}>}
 */
function detect(text, rules, state, options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const list = Array.isArray(rules) ? rules : rules && Array.isArray(rules.rules) ? rules.rules : [];
  const source = String(text == null ? "" : text);
  const recent = source.length > settings.windowChars ? source.slice(-settings.windowChars) : source;
  const hits = [];
  for (const rule of list) {
    if (state && state.offered && state.offered.has(rule.id)) continue;
    const matched = rule.keywords.filter((keyword) => keywordPattern(keyword, rule.caseSensitive).test(recent));
    const satisfied = rule.match === "all" ? matched.length === rule.keywords.length : matched.length > 0;
    if (!satisfied) continue;
    if (state && state.offered) state.offered.add(rule.id);
    hits.push({ rule, matched });
  }
  return hits;
}

module.exports = { DEFAULTS, MATCH, INSERT_KINDS, normalizeRules, createState, detect };
