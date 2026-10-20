// The organisation policy file: one JSON document an administrator ships to
// every desk. It carries the shared shortcut library, the applications that
// may be learned from, keyword rules, document shortcuts and the typing-speed
// assumption behind the time-saved figures. Invalid parts are skipped with a
// warning; the policy as a whole is never refused (an empty policy is valid).
"use strict";

const { expander } = require("./personal.js");
const capture = require("./capture-policy.js");
const keywords = require("./keyword-rules.js");
const documents = require("./documents.js");
const metrics = require("./metrics.js");
const miner = require("./phrase-miner.js");

const VERSION = 1;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function empty() {
  return {
    version: VERSION,
    organization: "",
    typing: { charsPerMinute: metrics.DEFAULT_CHARS_PER_MINUTE, secondsPerAttachment: 20 },
    capture: capture.createPolicy({}),
    keywordRules: [],
    documents: { shortcuts: [] },
    library: [],
    learning: { minCount: miner.DEFAULTS.minCount, minLength: miner.DEFAULTS.minLength, minWords: miner.DEFAULTS.minWords },
    retention: { metricsDays: 365, corpusDays: 90 },
    warnings: [],
  };
}

/** Parse a policy object or JSON string. Always returns a usable policy plus warnings. */
function parse(input) {
  const policy = empty();
  let source = input;
  if (typeof input === "string") {
    try {
      source = JSON.parse(input);
    } catch (error) {
      policy.warnings.push("policy is not valid JSON: " + error.message);
      return policy;
    }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    if (input != null) policy.warnings.push("policy is not an object");
    return policy;
  }
  if (source.version != null && Number(source.version) !== VERSION) {
    policy.warnings.push("policy version " + source.version + " is newer than " + VERSION + "; unknown fields are ignored");
  }
  policy.organization = String(source.organization == null ? "" : source.organization).trim();

  const typing = source.typing && typeof source.typing === "object" ? source.typing : {};
  policy.typing.charsPerMinute = positive(typing.charsPerMinute, policy.typing.charsPerMinute);
  policy.typing.secondsPerAttachment = positive(typing.secondsPerAttachment, policy.typing.secondsPerAttachment);

  policy.capture = capture.createPolicy(source.capture);
  policy.warnings.push(...policy.capture.warnings);

  const rules = keywords.normalizeRules(source.keywordRules);
  policy.keywordRules = rules.rules;
  policy.warnings.push(...rules.warnings);

  const catalog = documents.normalizeCatalog(source.documents);
  policy.documents = { shortcuts: catalog.shortcuts };
  policy.warnings.push(...catalog.warnings);

  const library = source.library && typeof source.library === "object" && Array.isArray(source.library.shorthands)
    ? source.library.shorthands : Array.isArray(source.library) ? source.library : [];
  policy.library = expander.sanitizeList(library);
  if (Array.isArray(library) && policy.library.length !== library.length) {
    policy.warnings.push((library.length - policy.library.length) + " library entries ignored (empty or duplicate trigger)");
  }
  // Keyword rules may only point at shortcuts and document sets that exist.
  const triggers = new Set(policy.library.map((sh) => sh.trigger));
  const shortcuts = new Set(policy.documents.shortcuts.map((s) => s.trigger));
  policy.keywordRules = policy.keywordRules.filter((rule) => {
    if (rule.insert.kind === "shorthand" && !triggers.has(rule.insert.trigger)) {
      policy.warnings.push("keyword rule " + rule.id + " ignored: shortcut " + rule.insert.trigger + " is not in the policy library");
      return false;
    }
    if (rule.insert.kind === "document" && !shortcuts.has(rule.insert.shortcut)) {
      policy.warnings.push("keyword rule " + rule.id + " ignored: document shortcut " + rule.insert.shortcut + " is not in the policy");
      return false;
    }
    return true;
  });

  const learning = source.learning && typeof source.learning === "object" ? source.learning : {};
  policy.learning.minCount = Math.max(2, Math.floor(positive(learning.minCount, policy.learning.minCount)));
  policy.learning.minLength = Math.floor(positive(learning.minLength, policy.learning.minLength));
  policy.learning.minWords = Math.floor(positive(learning.minWords, policy.learning.minWords));

  const retention = source.retention && typeof source.retention === "object" ? source.retention : {};
  policy.retention.metricsDays = Math.floor(positive(retention.metricsDays, policy.retention.metricsDays));
  policy.retention.corpusDays = Math.floor(positive(retention.corpusDays, policy.retention.corpusDays));
  return policy;
}

module.exports = { VERSION, empty, parse };
