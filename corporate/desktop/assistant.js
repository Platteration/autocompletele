// Everything the desktop app does that does not need Electron: files, the
// engine, metrics, learning and the operations the dashboard calls. main.js
// adds the tray, the windows and the input/output adapters; simulate.js drives
// the same object from a script.
"use strict";

const fs = require("node:fs");
const core = require("../core/index.js");
const learning = require("./learning.js");

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
  let rawPolicy = store.loadPolicy();
  if (rawPolicy == null && settings.policyFile) {
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
  if (rawPolicy == null && settings.policy) rawPolicy = settings.policy;

  function buildPolicy() {
    const policy = core.orgPolicy.parse(rawPolicy == null ? {} : rawPolicy);
    // The person's own capture rules take precedence over the organisation's.
    const own = core.capturePolicy.createPolicy({ defaultMode: policy.capture.defaultMode, apps: userSettings.captureApps });
    policy.capture = { defaultMode: policy.capture.defaultMode, apps: own.apps.concat(policy.capture.apps), warnings: policy.capture.warnings.concat(own.warnings) };
    if (userSettings.charsPerMinute) policy.typing.charsPerMinute = userSettings.charsPerMinute;
    return policy;
  }

  let policy = buildPolicy();
  warnings.push(...policy.warnings);

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

  let cachedCandidates = null;
  const listeners = { session: [], candidates: [] };

  function emit(name, value) {
    for (const listener of listeners[name]) listener(value);
  }

  function on(name, listener) {
    if (listeners[name]) listeners[name].push(listener);
  }

  function persistSession(session) {
    if (!session) return;
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
    const result = saveShorthand({ trigger: candidate && candidate.trigger, expansion: candidate && candidate.expansion });
    if (result.ok) {
      ledger.record({ kind: "learned", trigger: candidate.trigger, keystrokesSaved: 0, app: "" });
    }
    return result;
  }

  function dismissCandidate(text) {
    const learned = store.loadLearned();
    const value = String(text == null ? "" : text);
    if (value && !learned.dismissed.includes(value)) learned.dismissed.push(value);
    store.saveLearned(learned);
    cachedCandidates = null;
    return candidates();
  }

  function saveSettings(next) {
    const merged = Object.assign({}, userSettings, next || {});
    store.saveSettings(merged);
    userSettings = store.loadSettings();
    policy = buildPolicy();
    engine.setPolicy(policy);
    engine.setEnabled(userSettings.enabled);
    cachedCandidates = null;
    return userSettings;
  }

  function setEnabled(value) {
    return saveSettings({ enabled: value !== false });
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
    warnings: () => warnings.concat(store.warnings()),
    log,
  };
}

module.exports = { createAssistant };
