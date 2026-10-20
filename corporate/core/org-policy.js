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
const { GROUP_PATTERN, groupNames } = require("./groups.js");

const VERSION = 1;
const COLLECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
    groups: [],
    collections: [],
    learning: { minCount: miner.DEFAULTS.minCount, minLength: miner.DEFAULTS.minLength, minWords: miner.DEFAULTS.minWords },
    retention: { metricsDays: 365, corpusDays: 90 },
    paused: { active: false, message: "" },
    serial: null,
    licence: null,
    licensing: { allowTierOverride: false },
    threadMemory: { enabled: true },
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
    for (const section of ["typing", "learning", "retention", "reporting", "licensing", "threadMemory"]) {
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
  // A collection is replaced whole by a later layer with the same id.
  const collections = list.map((layer) => Array.isArray(layer.collections) ? layer.collections : []).filter((l) => l.length);
  if (collections.length) out.collections = byKey(collections, "id");
  return out;
}

/** The library of a raw policy or collection: {shorthands:[…]} or a bare list. */
function rawLibrary(value) {
  return value && typeof value === "object" && Array.isArray(value.shorthands) ? value.shorthands : Array.isArray(value) ? value : [];
}

/**
 * Collections: named bundles shared with the groups in their audience. The
 * ones this desk receives are normalised one by one and appended after what
 * is shared with everyone; an item already present wins and the newcomer is
 * dropped with a warning. Collections the desk does not receive are listed
 * by name only, and their content is not checked here.
 * @param {object} policy the policy being built (shared items already in place)
 * @param {*} raw the policy's `collections` value
 * @param {string[]|"*"} groups the desk's groups, or "*" for every collection
 */
function resolveCollections(policy, raw, groups) {
  const list = Array.isArray(raw) ? raw : [];
  if (raw != null && !Array.isArray(raw)) policy.warnings.push("collections ignored: not a list");
  const seen = new Set();
  const present = {
    library: new Map(policy.library.map((sh) => [sh.trigger, "everyone"])),
    keywordRules: new Map(policy.keywordRules.map((rule) => [rule.id, "everyone"])),
    documents: new Map(policy.documents.shortcuts.map((set) => [set.trigger, "everyone"])),
    lookups: new Map(policy.lookups.map((lookup) => [lookup.trigger, "everyone"])),
  };
  const NAMES = { library: "shortcut", keywordRules: "keyword rule", documents: "document shortcut", lookups: "lookup" };
  list.forEach((item, index) => {
    const id = isObject(item) && typeof item.id === "string" ? item.id.trim() : "";
    if (!COLLECTION_ID_PATTERN.test(id)) {
      policy.warnings.push("collection " + index + " ignored: id must be lower-case letters, digits and dashes");
      return;
    }
    if (seen.has(id)) {
      policy.warnings.push("collection " + id + " ignored: duplicate id");
      return;
    }
    seen.add(id);
    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : id;
    const audience = groupNames(item.audience);
    for (const bad of audience.rejected) policy.warnings.push("collection " + id + ": audience group " + JSON.stringify(bad) + " ignored: use lower-case letters, digits and dashes");
    if (item.audience != null && !audience.names.length && (audience.rejected.length || !Array.isArray(item.audience))) {
      policy.warnings.push("collection " + id + " ignored: no usable audience group");
      return;
    }
    const entry = { id, label, audience: audience.names, applied: false, members: { library: [], keywordRules: [], documents: [], lookups: [] } };
    policy.collections.push(entry);
    const applies = !audience.names.length || groups === "*" || audience.names.some((name) => groups.includes(name));
    if (!applies) return;
    entry.applied = true;
    const prefix = "collection " + id + ": ";
    const add = (kind, key, items, warnings) => {
      for (const warning of warnings) policy.warnings.push(prefix + warning);
      for (const found of items) {
        const owner = present[kind].get(found[key]);
        if (owner) {
          policy.warnings.push(NAMES[kind] + " " + found[key] + " in collection " + id + " ignored: " + (owner === "everyone" ? "already shared with everyone" : "collection " + owner + " defines it first"));
          continue;
        }
        present[kind].set(found[key], id);
        entry.members[kind].push(found[key]);
        if (kind === "library") policy.library.push(found);
        else if (kind === "keywordRules") policy.keywordRules.push(found);
        else if (kind === "documents") policy.documents.shortcuts.push(found);
        else policy.lookups.push(found);
      }
    };
    const library = rawLibrary(item.library);
    const cleanLibrary = expander.sanitizeList(library);
    add("library", "trigger", cleanLibrary, library.length !== cleanLibrary.length ? [(library.length - cleanLibrary.length) + " library entries ignored (empty or duplicate trigger)"] : []);
    // Unnamed rules get an id of their own so they cannot collide with the shared keyword-<n>.
    const rules = (Array.isArray(item.keywordRules) ? item.keywordRules : []).map((rule, i) => (isObject(rule) && !(typeof rule.id === "string" && rule.id.trim()) ? Object.assign({}, rule, { id: id + "/keyword-" + i }) : rule));
    const normalRules = keywords.normalizeRules(rules);
    add("keywordRules", "id", normalRules.rules, normalRules.warnings);
    const catalog = documents.normalizeCatalog(item.documents);
    add("documents", "trigger", catalog.shortcuts, catalog.warnings);
    const lookups = lookupsModule.normalizeLookups(item.lookups);
    add("lookups", "trigger", lookups.lookups, lookups.warnings);
  });
}

/**
 * Which collection each item of a parsed policy belongs to, keyed by trigger
 * (shortcuts, document sets, lookups) or rule id; items shared with everyone
 * are absent. Only items present in the policy passed in are listed, so the
 * index stays honest after a tier trimmed or switched something off.
 */
function collectionIndex(policy) {
  const index = { library: {}, keywordRules: {}, documents: {}, lookups: {} };
  if (!policy || !Array.isArray(policy.collections)) return index;
  const has = {
    library: new Set(policy.library.map((sh) => sh.trigger)),
    keywordRules: new Set(policy.keywordRules.map((rule) => rule.id)),
    documents: new Set(policy.documents.shortcuts.map((set) => set.trigger)),
    lookups: new Set(policy.lookups.map((lookup) => lookup.trigger)),
  };
  for (const collection of policy.collections) {
    for (const kind of Object.keys(index)) {
      for (const key of collection.members[kind]) if (has[kind].has(key)) index[kind][key] = collection.id;
    }
  }
  return index;
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

/**
 * Parse a policy object or JSON string. Always returns a usable policy plus warnings.
 * @param {{groups?: string[]|"*"}} [options] the desk's groups (which collections it receives);
 *   "*" means every collection (administrator views); anything else means none beyond what everyone gets.
 */
function parse(input, options) {
  const policy = empty();
  const wanted = options && options.groups;
  policy.groups = wanted === "*" ? "*" : groupNames(Array.isArray(wanted) ? wanted : []).names;
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
  resolveCollections(policy, source.collections, policy.groups);
  dropDanglingRules(policy);
  for (const collection of policy.collections) {
    collection.members.keywordRules = collection.members.keywordRules.filter((id) => policy.keywordRules.some((rule) => rule.id === id));
  }

  // Whether a person may try another tier on the Policy tab while licensing is enforced (see core/license.js).
  const licensing = isObject(source.licensing) ? source.licensing : {};
  if (licensing.allowTierOverride !== undefined && typeof licensing.allowTierOverride !== "boolean") policy.warnings.push("licensing.allowTierOverride ignored: use true or false");
  policy.licensing.allowTierOverride = licensing.allowTierOverride === true;

  // Template answers remembered per email conversation (core/thread-memory.js); on unless the organisation says otherwise.
  const threadMemory = isObject(source.threadMemory) ? source.threadMemory : {};
  if (threadMemory.enabled !== undefined && typeof threadMemory.enabled !== "boolean") policy.warnings.push("threadMemory.enabled ignored: use true or false");
  policy.threadMemory.enabled = threadMemory.enabled !== false;

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

module.exports = { VERSION, GROUP_PATTERN, empty, parse, merge, dropDanglingRules, groupNames, collectionIndex };
