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
const lookupsModule = require("./lookups.js");

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
    lookups: [],
    library: [],
    learning: { minCount: miner.DEFAULTS.minCount, minLength: miner.DEFAULTS.minLength, minWords: miner.DEFAULTS.minWords },
    retention: { metricsDays: 365, corpusDays: 90 },
    paused: { active: false, message: "" },
    serial: null,
    licence: null,
    licensing: { allowTierOverride: false },
    updates: { url: null, channel: "latest" },
    reporting: { team: "", hourlyRate: null, currency: null, includeApps: false, period: "week", periods: 12, endpoint: null, uploadEvery: "week", uploadToken: null },
    warnings: [],
  };
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function libraryList(value) {
  if (isObject(value) && Array.isArray(value.shorthands)) return value.shorthands;
  return Array.isArray(value) ? value : [];
}

function byKey(lists, key) {
  const map = new Map();
  const loose = [];
  for (const list of lists) {
    for (const item of list) {
      if (isObject(item) && typeof item[key] === "string" && item[key].trim()) map.set(item[key].trim(), item);
      else loose.push(item);
    }
  }
  return [...map.values()].concat(loose);
}

/**
 * Layer several raw policies, most general first (organisation, then
 * department, then team). Later layers win field by field; shortcuts, keyword
 * rules and document sets are merged by trigger or id; capture rules from
 * later layers are tried first. A pause in any layer pauses the result.
 */
function merge(layers) {
  const list = (Array.isArray(layers) ? layers : []).filter(isObject);
  const out = {};
  for (const layer of list) {
    if (typeof layer.organization === "string") out.organization = layer.organization;
    if (typeof layer.licence === "string" && layer.licence.trim()) out.licence = layer.licence;
    if (isObject(layer.updates) && typeof layer.updates.url === "string" && layer.updates.url.trim()) out.updates = Object.assign({}, layer.updates);
    for (const section of ["typing", "learning", "retention", "reporting", "licensing"]) {
      if (isObject(layer[section])) out[section] = Object.assign({}, out[section], layer[section]);
    }
    if (layer.paused && !(out.paused && pausedOf(out.paused).active)) out.paused = layer.paused;
    if (isObject(layer.capture)) {
      const capture = out.capture || { apps: [] };
      if (layer.capture.defaultMode !== undefined) capture.defaultMode = layer.capture.defaultMode;
      if (Array.isArray(layer.capture.apps)) capture.apps = layer.capture.apps.concat(capture.apps);
      out.capture = capture;
    }
  }
  const libraries = list.map((layer) => libraryList(layer.library)).filter((l) => l.length);
  if (libraries.length) out.library = { version: 1, shorthands: byKey(libraries, "trigger") };
  const rules = list.map((layer) => Array.isArray(layer.keywordRules) ? layer.keywordRules : []).filter((l) => l.length);
  if (rules.length) out.keywordRules = byKey(rules, "id");
  const docs = list.map((layer) => isObject(layer.documents) && Array.isArray(layer.documents.shortcuts) ? layer.documents.shortcuts : [])
    .filter((l) => l.length);
  if (docs.length) out.documents = { shortcuts: byKey(docs, "trigger") };
  const lookups = list.map((layer) => Array.isArray(layer.lookups) ? layer.lookups : []).filter((l) => l.length);
  if (lookups.length) out.lookups = byKey(lookups, "trigger");
  return out;
}

/**
 * Keyword rules may only point at shortcuts and document sets that exist. Runs
 * at parse time and again when a tier trims the library. Filters in place and
 * adds a warning per dropped rule.
 */
function dropDanglingRules(policy) {
  const triggers = new Set(policy.library.map((sh) => sh.trigger));
  const shortcuts = new Set(policy.documents.shortcuts.map((s) => s.trigger));
  policy.keywordRules = policy.keywordRules.filter((rule) => {
    if (!rule.insert) return true;
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
  return policy;
}

function pausedOf(value) {
  if (value === true) return { active: true, message: "" };
  if (isObject(value) && value.active !== false) {
    return { active: true, message: String(value.message == null ? "" : value.message).trim() };
  }
  return { active: false, message: "" };
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

  const lookups = lookupsModule.normalizeLookups(source.lookups);
  policy.lookups = lookups.lookups;
  policy.warnings.push(...lookups.warnings);

  const library = source.library && typeof source.library === "object" && Array.isArray(source.library.shorthands)
    ? source.library.shorthands : Array.isArray(source.library) ? source.library : [];
  policy.library = expander.sanitizeList(library);
  if (Array.isArray(library) && policy.library.length !== library.length) {
    policy.warnings.push((library.length - policy.library.length) + " library entries ignored (empty or duplicate trigger)");
  }
  dropDanglingRules(policy);

  // Whether a person may try another tier on the Policy tab while licensing is enforced (see core/license.js).
  const licensing = isObject(source.licensing) ? source.licensing : {};
  if (licensing.allowTierOverride !== undefined && typeof licensing.allowTierOverride !== "boolean") policy.warnings.push("licensing.allowTierOverride ignored: use true or false");
  policy.licensing.allowTierOverride = licensing.allowTierOverride === true;

  const learning = source.learning && typeof source.learning === "object" ? source.learning : {};
  policy.learning.minCount = Math.max(2, Math.floor(positive(learning.minCount, policy.learning.minCount)));
  policy.learning.minLength = Math.floor(positive(learning.minLength, policy.learning.minLength));
  policy.learning.minWords = Math.floor(positive(learning.minWords, policy.learning.minWords));

  // Kill switch: an administrator can pause the assistant on every desk.
  // Nothing is expanded, offered or learned while paused; nothing is deleted.
  policy.paused = pausedOf(source.paused);
  if (Number.isSafeInteger(source.serial) && source.serial > 0) policy.serial = source.serial;
  // The business licence token (see core/license.js); checked by the desk, not here.
  policy.licence = typeof source.licence === "string" && source.licence.trim() ? source.licence.trim() : null;

  const reporting = isObject(source.reporting) ? source.reporting : {};
  policy.reporting.team = String(reporting.team == null ? "" : reporting.team).trim();
  policy.reporting.hourlyRate = positive(reporting.hourlyRate, null);
  policy.reporting.currency = typeof reporting.currency === "string" && reporting.currency.trim() ? reporting.currency.trim() : null;
  policy.reporting.includeApps = reporting.includeApps === true;
  policy.reporting.period = ["day", "week", "month"].includes(reporting.period) ? reporting.period : "week";
  policy.reporting.periods = Math.min(366, Math.floor(positive(reporting.periods, 12)));
  // Upload only over https: the report names organisation shortcuts and teams.
  const endpoint = typeof reporting.endpoint === "string" ? reporting.endpoint.trim() : "";
  if (endpoint && !/^https:\/\//i.test(endpoint)) policy.warnings.push("reporting.endpoint ignored: only https:// is allowed");
  policy.reporting.endpoint = /^https:\/\//i.test(endpoint) ? endpoint : null;
  policy.reporting.uploadEvery = ["day", "week"].includes(reporting.uploadEvery) ? reporting.uploadEvery : "week";
  policy.reporting.uploadToken = typeof reporting.uploadToken === "string" && reporting.uploadToken.trim() ? reporting.uploadToken.trim() : null;

  // Software updates: a desk only ever fetches from an https server the policy names (see desktop/updater.js).
  const updates = isObject(source.updates) ? source.updates : {};
  const updateUrl = typeof updates.url === "string" ? updates.url.trim().replace(/\/+$/, "") : "";
  if (updateUrl && !/^https:\/\//i.test(updateUrl)) policy.warnings.push("updates.url ignored: only https:// is allowed");
  policy.updates.url = /^https:\/\//i.test(updateUrl) ? updateUrl : null;
  const channel = typeof updates.channel === "string" ? updates.channel.trim() : "";
  if (channel && !/^[a-z][a-z0-9-]{0,31}$/.test(channel)) policy.warnings.push("updates.channel ignored: use lower-case letters, digits and dashes");
  policy.updates.channel = /^[a-z][a-z0-9-]{0,31}$/.test(channel) ? channel : "latest";

  const retention = source.retention && typeof source.retention === "object" ? source.retention : {};
  policy.retention.metricsDays = Math.floor(positive(retention.metricsDays, policy.retention.metricsDays));
  policy.retention.corpusDays = Math.floor(positive(retention.corpusDays, policy.retention.corpusDays));
  return policy;
}

module.exports = { VERSION, empty, parse, merge, dropDanglingRules };
