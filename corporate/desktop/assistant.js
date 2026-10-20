// Everything the desktop app does that does not need Electron: files, the
// engine, metrics, learning and the operations the dashboard calls. main.js
// adds the tray, the windows and the input/output adapters; simulate.js drives
// the same object from a script.
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const core = require("../core/index.js");
const learning = require("./learning.js");
const { loadCorpusKey } = require("./corpus-key.js");

function readPolicyFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return null;
  }
}

function createAssistant(options) {
  const settings = Object.assign({ now: () => Date.now(), swallowsTriggerKey: false }, options || {});
  const store = core.store.createStore(settings.dataDir);
  const warnings = [];
  const log = typeof settings.log === "function" ? settings.log : () => {};

  let userSettings = store.loadSettings();

  // Learned text is only ever written encrypted. Without a usable keychain
  // key, sessions are not stored and the dashboard says so.
  const corpusKey = loadCorpusKey({ store, keychain: settings.keychain });
  const learningStorage = !!corpusKey.key;
  if (learningStorage) store.setCorpusBox(core.cryptoBox.createBox(corpusKey.key));
  else warnings.push(corpusKey.message);
  if (corpusKey.status === "created" || corpusKey.status === "replaced") {
    audit({ event: "corpus-key-" + corpusKey.status, aside: corpusKey.aside || null });
  }
  const encryptedNow = store.encryptCorpus();
  if (encryptedNow) audit({ event: "corpus-encrypted", sessions: encryptedNow });
  // Dismissals written as plain text by an earlier version become digests.
  const dismissedBefore = store.loadLearned().dismissed;
  if (dismissedBefore.some((entry) => !entry.startsWith("sha256:"))) {
    store.saveLearned({ dismissed: [...new Set(dismissedBefore.map(learning.dismissalKey))] });
  }

  // A desk is "managed" when IT installed a deployment file naming signed
  // policy sources. Then only signed layers apply; an unsigned local policy
  // file is ignored, so it cannot override what the organisation signed.
  const deploymentRaw = settings.deployment !== undefined ? settings.deployment : store.loadDeployment();
  const policySource = deploymentRaw ? core.policySource.createPolicySource({
    deployment: deploymentRaw,
    cache: { load: store.loadPolicyCache, save: store.savePolicyCache },
    fetch: settings.fetch,
    readFile: settings.readFile,
    now: settings.now,
  }) : null;
  const managed = !!(policySource && policySource.deployment.sources.length);
  // The desk's groups (IT sets them in deployment.json) decide which policy collections it receives.
  const groups = policySource ? policySource.deployment.groups : [];
  if (policySource && !managed) warnings.push(...policySource.deployment.warnings);
  let sourceReport = { sources: [], warnings: [] };

  let rawPolicy = managed ? null : store.loadPolicy();
  if (managed) {
    sourceReport = policySource.loadCached();
    rawPolicy = core.orgPolicy.merge(sourceReport.layers);
    if (store.loadPolicy() != null || settings.policyFile) {
      warnings.push("a local policy file is ignored because this desk receives a signed policy from its deployment settings");
    }
  } else if (rawPolicy == null && settings.policyFile) {
    const text = readPolicyFile(settings.policyFile);
    if (text == null) {
      warnings.push("policy file " + settings.policyFile + " could not be read; running without an organisation policy");
    } else {
      try {
        rawPolicy = JSON.parse(text);
      } catch (error) {
        warnings.push("policy file " + settings.policyFile + " is not valid JSON (" + error.message + "); running without an organisation policy");
      }
    }
  }
  if (!managed && rawPolicy == null && settings.policy) rawPolicy = settings.policy;

  // Licence state and tier of this desk, recomputed with every policy.
  let licence = { status: "unenforced", reason: "", licence: null, keyId: null, daysLeft: null };
  let entitlement = core.license.entitlements(licence);
  let untrimmed = { shortcuts: 0, layers: 0 };

  function buildPolicy() {
    let policy = core.orgPolicy.parse(rawPolicy == null ? {} : rawPolicy, { groups });
    licence = core.license.licenceState(policy.licence, {
      now: settings.now(),
      publicKeys: settings.vendorPublicKeys,
      organization: policy.organization,
    });
    // The person's testing override: any tier while licensing is unenforced, otherwise only
    // when the policy allows it and only downwards (see core/license.js).
    entitlement = core.license.entitlements(licence, { override: userSettings.tierOverride, allowOverride: policy.licensing.allowTierOverride });
    const layers = managed ? sourceReport.layers.length : rawPolicy == null ? 0 : 1;
    untrimmed = core.license.usage(policy, layers);
    // The person's own capture rules take precedence over the organisation's.
    const own = core.capturePolicy.createPolicy({ defaultMode: policy.capture.defaultMode, apps: userSettings.captureApps });
    policy.capture = { defaultMode: policy.capture.defaultMode, apps: own.apps.concat(policy.capture.apps), warnings: policy.capture.warnings.concat(own.warnings) };
    if (userSettings.charsPerMinute) policy.typing.charsPerMinute = userSettings.charsPerMinute;
    // The tier is applied last so that a person's own learn rule cannot restore learning on an unlicensed desk.
    return core.license.applyTier(policy, entitlement, { layers });
  }

  let policy = buildPolicy();

  const ledger = core.metrics.createLedger({ now: settings.now, charsPerMinute: policy.typing.charsPerMinute });
  ledger.load(store.loadMetrics());
  ledger.onRecord((entry) => store.appendMetric(entry));
  store.pruneMetrics(policy.retention.metricsDays);
  store.pruneSessions(policy.retention.corpusDays);
  warnings.push(...store.warnings());

  const engine = core.engine.createEngine({
    library: store.loadLibrary(),
    policy,
    ledger,
    now: settings.now,
    swallowsTriggerKey: settings.swallowsTriggerKey,
  });
  engine.setEnabled(userSettings.enabled);
  recordPolicyAudit("start");

  let cachedCandidates = null;
  const listeners = { session: [], candidates: [] };

  function audit(entry) {
    store.appendAudit(Object.assign({ at: settings.now() }, entry));
  }

  function sourceStatusKey(source) {
    if (source.status === "failed") return "failed: " + (source.error || "");
    if (source.error) return "cached: " + source.error;
    return "ok";
  }

  // Record what the organisation changed, and when a policy source starts or
  // stops failing. Never typed text: hashes, serials, labels and statuses.
  function recordPolicyAudit(origin) {
    const hash = core.policySigning.sha256(JSON.stringify(rawPolicy == null ? {} : rawPolicy));
    const state = store.loadPolicyState() || {};
    const previous = state.sourceStatus && typeof state.sourceStatus === "object" ? state.sourceStatus : {};
    const sourceStatus = {};
    for (const source of sourceReport.sources) {
      const key = sourceStatusKey(source);
      sourceStatus[source.id] = key;
      const before = previous[source.id] || "ok";
      if (key !== before) {
        audit({ event: key === "ok" ? "policy-source-recovered" : "policy-source-problem", source: source.label, location: source.location, status: source.status, error: source.error || null });
      }
    }
    const licenceKey = licence.status + ":" + (licence.licence ? licence.licence.id : "") + ":" + entitlement.licensedTier;
    if (state.licence !== licenceKey && licence.status !== "unenforced") {
      audit({ event: "licence-changed", status: licence.status, tier: entitlement.licensedTier, id: licence.licence ? licence.licence.id : null, seats: licence.licence ? licence.licence.seats : null, expiresAt: licence.licence ? licence.licence.expiresAt : null });
    }
    if (state.hash !== hash) {
      audit({
        event: "policy-applied",
        origin,
        hash,
        previousHash: state.hash || null,
        organization: policy.organization,
        paused: policy.paused.active,
        sources: sourceReport.sources.map((source) => ({ label: source.label, status: source.status, serial: source.serial || null, keyId: source.keyId || null })),
        warnings: policy.warnings.length,
      });
    }
    store.savePolicyState({ hash, appliedAt: settings.now(), sourceStatus, licence: licenceKey });
  }

  // Apply a new policy without disturbing the field being typed in: the
  // learning session and the field's rule state survive unless the policy
  // itself ends learning there (then the session is stored).
  function applyEngineSettings() {
    persistSession(engine.setPolicy(policy));
    if (engine.enabled !== userSettings.enabled) persistSession(engine.setEnabled(userSettings.enabled).session);
  }

  function applyPolicy(origin) {
    policy = buildPolicy();
    applyEngineSettings();
    buildLookupStore();
    cachedCandidates = null;
    recordPolicyAudit(origin);
  }

  /** Fetch the signed policy layers again (managed desks only). */
  async function refreshPolicy() {
    if (!managed) return { ok: false, managed: false, sources: [], warnings: [] };
    sourceReport = await policySource.refresh();
    rawPolicy = core.orgPolicy.merge(sourceReport.layers);
    applyPolicy("refresh");
    return { ok: true, managed: true, sources: sourceReport.sources.slice(), warnings: sourceReport.warnings.slice(), paused: policy.paused.active };
  }

  function emit(name, value) {
    for (const listener of listeners[name]) listener(value);
  }

  function on(name, listener) {
    if (listeners[name]) listeners[name].push(listener);
  }

  function persistSession(session) {
    if (!session || !learningStorage) return;
    store.appendSession(session);
    cachedCandidates = null;
    emit("session", session);
    emit("candidates", candidates());
  }

  function focusChanged(context) {
    const result = engine.focusChanged(context);
    persistSession(result.session);
    return result;
  }

  function endSession() {
    persistSession(engine.endSession());
  }

  function keyTyped(key) {
    return engine.keyTyped(key);
  }

  function candidates() {
    if (!cachedCandidates) {
      cachedCandidates = learning.candidates({
        sessions: store.loadSessions(),
        library: engine.library,
        learning: policy.learning,
        dismissed: store.loadLearned().dismissed,
      });
    }
    return cachedCandidates.slice();
  }

  function corpusInfo() {
    return Object.assign(store.corpusInfo(), {
      storing: learningStorage,
      problem: learningStorage ? null : corpusKey.message,
      retentionDays: policy.retention.corpusDays,
    });
  }

  /** The person deletes everything learned so far (decisions on proposals are kept). */
  function clearLearning() {
    const before = store.corpusInfo();
    store.clearSessions();
    // Everything derived from learned text goes too: dismissals and the
    // suggestions not yet exported.
    store.saveLearned({ dismissed: [] });
    store.saveSuggestions([]);
    cachedCandidates = null;
    audit({ event: "corpus-deleted", by: "person", sessions: before.sessions + before.locked });
    emit("candidates", candidates());
    return corpusInfo();
  }

  function saveShorthand(sh) {
    const trigger = String(sh && sh.trigger == null ? "" : sh.trigger).trim();
    const expansion = String(sh && sh.expansion == null ? "" : sh.expansion);
    if (!trigger) return { ok: false, error: "The trigger cannot be empty." };
    if (/\s/.test(trigger)) return { ok: false, error: "The trigger cannot contain spaces." };
    const list = store.loadLibrary().filter((item) => item.trigger !== trigger && item.trigger !== (sh.previousTrigger || ""));
    list.push({ trigger, expansion });
    store.saveLibrary(list);
    engine.setLibrary(list);
    cachedCandidates = null;
    return { ok: true, library: engine.library };
  }

  function deleteShorthand(trigger) {
    const list = store.loadLibrary().filter((item) => item.trigger !== trigger);
    store.saveLibrary(list);
    engine.setLibrary(list);
    cachedCandidates = null;
    return { ok: true, library: engine.library };
  }

  function acceptCandidate(candidate) {
    let expansion = candidate && candidate.expansion;
    // A template proposal is rebuilt here from its segments, with the
    // person's names for its blanks, rather than trusting text from the page.
    if (candidate && candidate.template != null) {
      const found = candidates().find((c) => c.kind === "template" && c.template === candidate.template);
      if (!found) return { ok: false, error: "This proposal has changed. Look at the Learning tab again." };
      const built = core.variableDetector.templateFrom(found.segments, candidate.names);
      if (!built.ok) return { ok: false, error: built.error };
      expansion = built.template;
    }
    const result = saveShorthand({ trigger: candidate && candidate.trigger, expansion });
    if (result.ok) {
      ledger.record({ kind: "learned", trigger: candidate.trigger, keystrokesSaved: 0, app: "" });
    }
    return result;
  }

  function dismissCandidate(text) {
    const learned = store.loadLearned();
    const value = String(text == null ? "" : text);
    const key = learning.dismissalKey(value);
    if (value && !learned.dismissed.includes(key)) learned.dismissed.push(key);
    store.saveLearned(learned);
    cachedCandidates = null;
    return candidates();
  }

  function saveSettings(next) {
    const merged = Object.assign({}, userSettings, next || {});
    const before = JSON.stringify(userSettings.captureApps || []);
    const overrideBefore = userSettings.tierOverride;
    store.saveSettings(merged);
    userSettings = store.loadSettings();
    if (JSON.stringify(userSettings.captureApps || []) !== before) {
      audit({ event: "capture-rules-changed", by: "person", rules: userSettings.captureApps.map((rule) => ({ label: rule.label || null, mode: rule.mode || null, match: rule.match || { process: rule.process, title: rule.title, bundleId: rule.bundleId } })) });
    }
    policy = buildPolicy();
    if (userSettings.tierOverride !== overrideBefore) {
      audit({ event: "tier-override-changed", by: "person", from: overrideBefore, to: userSettings.tierOverride, honoured: entitlement.override.honoured, note: entitlement.override.note || null });
    }
    applyEngineSettings();
    buildLookupStore();
    cachedCandidates = null;
    return userSettings;
  }

  function setEnabled(value) {
    return saveSettings({ enabled: value !== false });
  }

  // Search palette: find and insert any shortcut or document set without
  // remembering its trigger.
  function paletteSearch(query, limit) {
    if (policy.paused.active) return [];
    const direct = core.paletteSearch.lookupQuery(query, policy.lookups);
    const first = direct ? [{ kind: "lookup", trigger: direct.lookup.trigger, argument: direct.argument, source: "organization", needsInput: false, preview: direct.lookup.trigger + " " + direct.argument + ": " + direct.lookup.label }] : [];
    const items = core.paletteSearch.items(engine.library, policy.documents, policy.lookups);
    return first.concat(core.paletteSearch.search(items, query, limit).map((item) => ({
      kind: item.kind, trigger: item.trigger, source: item.source, needsInput: item.needsInput, preview: item.preview,
    })));
  }

  /** The action for a palette choice. The query and Enter count as keystrokes spent. */
  function paletteChoose(choice) {
    if (policy.paused.active || !choice) return null;
    const spentKeystrokes = core.metrics.graphemes(String(choice.query == null ? "" : choice.query)) + 1;
    if (choice.kind === "lookup") {
      const parsed = core.paletteSearch.lookupQuery(choice.query, policy.lookups);
      const argument = String(choice.argument || (parsed && parsed.trigger === choice.trigger ? parsed.argument : "") || "").trim();
      const lookup = policy.lookups.find((l) => l.trigger === choice.trigger);
      if (!lookup) return null;
      if (!argument) return { type: "lookup-needs-argument", trigger: lookup.trigger, message: "Type " + lookup.trigger + " followed by a " + lookup.source.key + " to look up " + lookup.label + "." };
      return resolveLookup({ trigger: lookup.trigger, argument, typed: "", backspaces: 0, via: "palette", spentKeystrokes });
    }
    if (choice.kind === "documents") {
      const set = policy.documents.shortcuts.find((s) => s.trigger === choice.trigger);
      return set ? { type: "documents", trigger: set.trigger, label: set.label, documents: set.documents.slice(), backspaces: 0, via: "palette" } : null;
    }
    const sh = engine.library.find((item) => item.trigger === choice.trigger);
    if (!sh) return null;
    const { template } = core.personal;
    if (template.requiresInput(sh.expansion)) {
      return { type: "template", trigger: sh.trigger, expansion: sh.expansion, fields: template.fields(sh.expansion), variables: template.variables(sh.expansion), backspaces: 0, source: sh.source, via: "palette", spentKeystrokes };
    }
    const rendered = template.render(sh.expansion, null, new Date(settings.now()));
    return { type: "expand", trigger: sh.trigger, text: rendered.text, cursorOffset: rendered.cursorOffset, backspaces: 0, source: sh.source, via: "palette", spentKeystrokes };
  }

  /** Record a palette expansion after the shell inserted it. */
  function paletteInserted(action) {
    if (!action || action.type !== "expand") return null;
    if (action.lookup) return lookupInserted(action);
    return engine.recordInsert({ kind: "palette", trigger: action.trigger, source: action.source, inserted: action.text, typed: "", spentKeystrokes: action.spentKeystrokes });
  }

  // Suggestions to the organisation: proposals the person picked.
  function suggestionText(candidate) {
    if (candidate && candidate.template != null) {
      const found = candidates().find((c) => c.kind === "template" && c.template === candidate.template);
      if (!found) return { ok: false, error: "This proposal has changed. Look at the Learning tab again." };
      const built = core.variableDetector.templateFrom(found.segments, candidate.names);
      return built.ok ? { ok: true, text: built.template, kind: "template", sessions: found.sessions } : built;
    }
    const found = candidates().find((c) => c.kind !== "template" && c.text === (candidate && candidate.text));
    if (!found) return { ok: false, error: "This proposal has changed. Look at the Learning tab again." };
    return { ok: true, text: found.text, kind: found.kind, sessions: found.sessions };
  }

  function suggest(candidate) {
    const resolved = suggestionText(candidate);
    if (!resolved.ok) return resolved;
    const queued = core.suggestions.enqueue(store.loadSuggestions(), { kind: resolved.kind, text: resolved.text, trigger: candidate.trigger, sessions: resolved.sessions });
    store.saveSuggestions(queued);
    return { ok: true, queued };
  }

  function unsuggest(text) {
    const key = core.phraseMiner.normalize(text);
    const queued = store.loadSuggestions().filter((item) => core.phraseMiner.normalize(item.text) !== key);
    store.saveSuggestions(queued);
    return { ok: true, queued };
  }

  function suggestionsExport() {
    if (!userSettings.installId) {
      store.saveSettings(Object.assign({}, userSettings, { installId: crypto.randomUUID() }));
      userSettings = store.loadSettings();
    }
    return core.suggestions.buildExport(store.loadSuggestions(), { now: settings.now(), installId: userSettings.installId, team: policy.reporting.team });
  }

  /** The counts-only report this desk would send to its organisation. */
  function usageReport() {
    if (!userSettings.installId) {
      store.saveSettings(Object.assign({}, userSettings, { installId: crypto.randomUUID() }));
      userSettings = store.loadSettings();
    }
    return core.report.buildReport(ledger.entries(), {
      now: settings.now(),
      period: policy.reporting.period,
      count: policy.reporting.periods,
      charsPerMinute: policy.typing.charsPerMinute,
      installId: userSettings.installId,
      team: policy.reporting.team,
      organization: policy.organization,
      includeApps: policy.reporting.includeApps,
      hourlyRate: policy.reporting.hourlyRate,
      currency: policy.reporting.currency,
      licenceId: licence.licence ? licence.licence.id : "",
      tier: entitlement.tier,
    });
  }

  // Data behind the policy's lookups, cached under lookup-cache/.
  let lookupWarnings = [];
  let lookupStore = null;
  function buildLookupStore() {
    lookupStore = core.lookups.createLookupStore({
      lookups: policy.lookups,
      fetch: settings.fetch,
      readFile: settings.readFile,
      cache: { load: store.loadLookupCache, save: store.saveLookupCache },
      now: settings.now,
    });
    lookupStore.loadCached();
    lookupWarnings = [];
  }
  buildLookupStore();

  /** Fetch lookup sources (only the ones due, unless `all`). Failures keep the last good copy. */
  async function refreshLookups(all) {
    const result = await lookupStore.refresh(all ? undefined : lookupStore.due());
    lookupWarnings = result.warnings;
    return result;
  }

  /** Turn a lookup action into an expansion, or a miss the shell reports without deleting anything. */
  function resolveLookup(action) {
    const lookup = policy.lookups.find((l) => l.trigger === action.trigger);
    const row = lookup ? lookupStore.find(action.trigger, action.argument) : null;
    if (!lookup || !row) {
      return { type: "lookup-miss", trigger: action.trigger, argument: action.argument, message: "No " + (lookup ? lookup.label : action.trigger) + " found for " + JSON.stringify(action.argument) + "." };
    }
    const rendered = core.lookups.render(lookup, row, new Date(settings.now()));
    return {
      type: "expand", trigger: lookup.trigger, argument: action.argument, text: rendered.text, cursorOffset: rendered.cursorOffset,
      backspaces: action.backspaces || 0, typed: action.typed || "", source: "organization", via: action.via || "lookup", lookup: true, spentKeystrokes: action.spentKeystrokes || 0,
    };
  }

  function lookupInserted(action) {
    return engine.recordInsert({ kind: "lookup", trigger: action.trigger, inserted: action.text, typed: action.typed, source: "organization", spentKeystrokes: action.spentKeystrokes });
  }

  const uploader = core.reportUpload.createUploader({
    policy: () => policy,
    buildReport: usageReport,
    fetch: settings.fetch,
    state: { load: store.loadUploadState, save: store.saveUploadState },
    now: settings.now,
    audit,
  });

  function licenceInfo() {
    const ent = entitlement;
    return {
      status: licence.status,
      reason: licence.reason,
      enforced: ent.enforced,
      entitled: ent.tier !== "free",
      tier: ent.tier,
      tierName: ent.name,
      tierSource: ent.source,
      licensedTier: ent.licensedTier,
      limits: Object.assign({}, ent.limits),
      features: Object.assign({}, ent.features),
      usage: Object.assign({}, untrimmed),
      override: Object.assign({}, ent.override),
      tierNote: core.license.tierNote(ent.tier),
      id: licence.licence ? licence.licence.id : null,
      organization: licence.licence ? licence.licence.organization : null,
      seats: licence.licence ? licence.licence.seats : null,
      expiresAt: licence.licence ? licence.licence.expiresAt : null,
      graceDays: licence.licence ? licence.licence.graceDays : null,
      daysLeft: licence.daysLeft,
      freeTierNote: core.license.FREE_TIER_NOTE,
    };
  }

  function policyInfo() {
    return {
      organization: policy.organization,
      warnings: policy.warnings.slice(),
      typing: Object.assign({}, policy.typing),
      capture: { defaultMode: policy.capture.defaultMode, apps: policy.capture.apps.map((rule) => Object.assign({}, rule)) },
      keywordRules: policy.keywordRules.map((rule) => Object.assign({}, rule)),
      documents: policy.documents.shortcuts.map((s) => Object.assign({}, s)),
      organizationLibrary: policy.library.slice(),
      learning: Object.assign({}, policy.learning),
      retention: Object.assign({}, policy.retention),
      paused: Object.assign({}, policy.paused),
      reporting: Object.assign({}, policy.reporting),
      updates: Object.assign({}, policy.updates),
      licence: licenceInfo(),
      lookups: lookupStore.status().lookups,
      groups: groups.slice(),
      collections: policy.collections.filter((c) => c.applied).map((c) => ({
        id: c.id,
        label: c.label,
        audience: c.audience.slice(),
        counts: { shortcuts: c.members.library.length, keywordRules: c.members.keywordRules.length, documents: c.members.documents.length, lookups: c.members.lookups.length },
      })),
      hiddenCollections: policy.collections.filter((c) => !c.applied).map((c) => ({ id: c.id, label: c.label, audience: c.audience.slice() })),
      collectionOf: core.orgPolicy.collectionIndex(policy),
      managed,
      refreshMinutes: managed ? policySource.deployment.refreshMinutes : null,
      sources: sourceReport.sources.map((source) => Object.assign({}, source)),
    };
  }

  return {
    store,
    engine,
    ledger,
    on,
    focusChanged,
    endSession,
    keyTyped,
    recordInsert: (event) => engine.recordInsert(event),
    candidates,
    acceptCandidate,
    dismissCandidate,
    saveShorthand,
    deleteShorthand,
    importLibrary: (text) => {
      const result = store.importLibraryJson(text);
      if (result.ok) engine.setLibrary(store.loadLibrary());
      cachedCandidates = null;
      return result;
    },
    exportLibrary: () => store.exportLibraryJson(),
    library: () => engine.library,
    settings: () => Object.assign({}, userSettings),
    saveSettings,
    setEnabled,
    policyInfo,
    policy: () => policy,
    summary: (query) => ledger.summary(query),
    series: (query) => ledger.series(query),
    byApp: (query) => ledger.byApp(query),
    warnings: () => warnings.concat(sourceReport.warnings, policy.warnings, lookupWarnings, store.warnings()),
    refreshLookups,
    resolveLookup,
    lookupInserted,
    lookupStatus: () => lookupStore.status(),
    refreshPolicy,
    usageReport,
    uploadReport: () => uploader.upload(),
    uploadDue: () => uploader.due(),
    uploadStatus: () => uploader.status(),
    corpusInfo,
    clearLearning,
    paletteSearch,
    paletteChoose,
    paletteInserted,
    suggest,
    unsuggest,
    suggestions: () => store.loadSuggestions(),
    suggestionsExport,
    audit: (limit) => store.loadAudit(limit),
    record: (entry) => audit(entry),
    get managed() { return managed; },
    licence: licenceInfo,
    get paused() { return policy.paused.active; },
    log,
  };
}

module.exports = { createAssistant };
