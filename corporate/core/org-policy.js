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
const filer = require("./filer.js");
// Suite modules: each parses its own policy section.
const SUITE = Object.freeze({
  reply: { module: require("./reply.js"), normalize: "normalizeReplies", lists: ["replies"], maps: ["extract"] },
  sheets: { module: require("./sheets.js"), normalize: "normalizeSheets", lists: ["columns", "blocks"], maps: ["vocabularies"], listKeys: { blocks: "trigger" } },
  forms: { module: require("./forms.js"), normalize: "normalizeForms", lists: ["records", "lookups", "forms"], maps: [] },
  guard: { module: require("./guard.js"), normalize: "normalizeGuard", lists: ["packs", "internalDomains", "internalCodes"], maps: [] },
  notes: { module: require("./notes.js"), normalize: "normalizeNotes", lists: ["documents"], maps: ["actions"] },
});

const VERSION = 1;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function empty() {
  return {
    version: VERSION,
    organization: "",
    typing: { charsPerMinute: metrics.DEFAULT_CHARS_PER_MINUTE, secondsPerAttachment: 20, secondsPerFiling: 45 },
    capture: capture.createPolicy({}),
    keywordRules: [],
    documents: { shortcuts: [] },
    filing: { watch: [], fields: {}, rules: [], fallback: null, dateOrder: "dmy" },
    reply: null,
    sheets: null,
    forms: null,
    guard: null,
    notes: null,
    library: [],
    learning: { minCount: miner.DEFAULTS.minCount, minLength: miner.DEFAULTS.minLength, minWords: miner.DEFAULTS.minWords },
    retention: { metricsDays: 365, corpusDays: 90 },
    paused: { active: false, message: "" },
    serial: null,
    reporting: { team: "", hourlyRate: null, currency: null, includeApps: false, period: "week", periods: 12 },
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
    for (const section of ["typing", "learning", "retention", "reporting"]) {
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
  // Filing: rules merge by id, watch folders by path, fields by name; a later
  // layer's fallback and date order win.
  const filings = list.map((layer) => layer.filing).filter(isObject);
  if (filings.length) {
    const filing = {};
    const rules = filings.map((f) => Array.isArray(f.rules) ? f.rules : []).filter((l) => l.length);
    if (rules.length) filing.rules = byKey(rules, "id");
    const watch = filings.map((f) => (Array.isArray(f.watch) ? f.watch : []).map((w) => isObject(w) ? w : { path: w })).filter((l) => l.length);
    if (watch.length) filing.watch = byKey(watch, "path");
    const fields = filings.map((f) => f.fields).filter(isObject);
    if (fields.length) filing.fields = Object.assign({}, ...fields);
    for (const f of filings) {
      if (f.fallback !== undefined) filing.fallback = f.fallback;
      if (f.dateOrder !== undefined) filing.dateOrder = f.dateOrder;
    }
    out.filing = filing;
  }
  // Suite sections: lists merge by id (blocks by trigger, plain strings by
  // value), maps by key, scalars from the later layer.
  for (const [name, spec] of Object.entries(SUITE)) {
    const sections = list.map((layer) => layer[name]).filter(isObject);
    if (!sections.length) continue;
    const merged = {};
    for (const section of sections) {
      for (const [key, value] of Object.entries(section)) {
        if (spec.lists.includes(key) && Array.isArray(value)) {
          const previous = Array.isArray(merged[key]) ? merged[key] : [];
          const keyName = (spec.listKeys || {})[key] || "id";
          merged[key] = value.every((v) => typeof v === "string")
            ? [...new Set(previous.concat(value))]
            : byKey([previous, value], keyName);
        } else if (spec.maps.includes(key) && isObject(value)) {
          merged[key] = Object.assign({}, isObject(merged[key]) ? merged[key] : {}, value);
        } else {
          merged[key] = value;
        }
      }
    }
    out[name] = merged;
  }
  return out;
}

/**
 * Typed triggers live in one namespace on a desk: the library, document sets,
 * forms records and notes documents. The engine tries them in that order, so
 * a shared trigger silently hides the later owner; say so.
 */
function triggerClashes(policy) {
  const owners = new Map();
  const claim = (trigger, what) => {
    if (!trigger) return;
    if (!owners.has(trigger)) owners.set(trigger, []);
    owners.get(trigger).push(what);
  };
  for (const sh of policy.library) claim(sh.trigger, "library shortcut " + sh.trigger);
  for (const set of policy.documents.shortcuts) claim(set.trigger, "document set " + set.trigger);
  for (const record of (policy.forms && policy.forms.records) || []) claim(record.trigger, "forms record " + record.id);
  for (const doc of (policy.notes && policy.notes.documents) || []) claim(doc.trigger, "notes document " + doc.id);
  const warnings = [];
  for (const [trigger, list] of owners) {
    if (list.length > 1) warnings.push("trigger " + trigger + " is claimed by " + list.join(", ") + "; only the first is reachable by typing");
  }
  return warnings;
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
  policy.typing.secondsPerFiling = positive(typing.secondsPerFiling, policy.typing.secondsPerFiling);

  policy.capture = capture.createPolicy(source.capture);
  policy.warnings.push(...policy.capture.warnings);

  const rules = keywords.normalizeRules(source.keywordRules);
  policy.keywordRules = rules.rules;
  policy.warnings.push(...rules.warnings);

  const catalog = documents.normalizeCatalog(source.documents);
  policy.documents = { shortcuts: catalog.shortcuts };
  policy.warnings.push(...catalog.warnings);

  const filing = filer.normalizeFiling(source.filing);
  policy.filing = { watch: filing.watch, fields: filing.fields, rules: filing.rules, fallback: filing.fallback, dateOrder: filing.dateOrder };
  policy.warnings.push(...filing.warnings);

  for (const [name, spec] of Object.entries(SUITE)) {
    let normalized;
    try {
      normalized = spec.module[spec.normalize](source[name]);
    } catch (error) {
      // A section that makes its normaliser throw is dropped with a warning:
      // the desk must start from a signed policy whatever one section holds.
      policy.warnings.push(name + " section ignored: " + error.message);
      normalized = spec.module[spec.normalize](undefined);
    }
    policy.warnings.push(...normalized.warnings);
    delete normalized.warnings;
    policy[name] = normalized;
  }

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

  const learning = source.learning && typeof source.learning === "object" ? source.learning : {};
  policy.learning.minCount = Math.max(2, Math.floor(positive(learning.minCount, policy.learning.minCount)));
  policy.learning.minLength = Math.floor(positive(learning.minLength, policy.learning.minLength));
  policy.learning.minWords = Math.floor(positive(learning.minWords, policy.learning.minWords));

  // Kill switch: an administrator can pause the assistant on every desk.
  // Nothing is expanded, offered or learned while paused; nothing is deleted.
  policy.paused = pausedOf(source.paused);
  if (Number.isSafeInteger(source.serial) && source.serial > 0) policy.serial = source.serial;

  const reporting = isObject(source.reporting) ? source.reporting : {};
  policy.reporting.team = String(reporting.team == null ? "" : reporting.team).trim();
  policy.reporting.hourlyRate = positive(reporting.hourlyRate, null);
  policy.reporting.currency = typeof reporting.currency === "string" && reporting.currency.trim() ? reporting.currency.trim() : null;
  policy.reporting.includeApps = reporting.includeApps === true;
  policy.reporting.period = ["day", "week", "month"].includes(reporting.period) ? reporting.period : "week";
  policy.reporting.periods = Math.min(366, Math.floor(positive(reporting.periods, 12)));

  const retention = source.retention && typeof source.retention === "object" ? source.retention : {};
  policy.retention.metricsDays = Math.floor(positive(retention.metricsDays, policy.retention.metricsDays));
  policy.retention.corpusDays = Math.floor(positive(retention.corpusDays, policy.retention.corpusDays));
  // Last, once every trigger owner is known.
  policy.warnings.push(...triggerClashes(policy));
  return policy;
}

module.exports = { VERSION, empty, parse, merge };
