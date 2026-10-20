// Files under the app data folder. Reads never refuse: a corrupt file is moved
// aside with a warning and the app starts with defaults, so one bad write
// cannot lock a person out of their library or hide their statistics.
// Writes are atomic (temp file + rename).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { expander } = require("./personal.js");
const metricsModule = require("./metrics.js");

const FILES = Object.freeze({
  library: "library.json",
  policy: "policy.json",
  settings: "settings.json",
  metrics: "metrics.jsonl",
  corpus: "corpus.jsonl",
  learned: "learned.json",
  deployment: "deployment.json",
  policyState: "policy-state.json",
  audit: "audit.jsonl",
  policyCacheDir: "policy-cache",
  corpusKey: "corpus.key",
  suggestions: "suggestions.json",
  uploadState: "upload-state.json",
  lookupCacheDir: "lookup-cache",
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  charsPerMinute: null,       // null = use the policy's assumption
  captureApps: [],            // the person's own learn/off rules, same shape as policy.capture.apps
  shiftEnterForNewlines: false,
  startWithSystem: false,
  installId: null,            // random id that lets an administrator count a desk's reports once
  paletteShortcut: "CommandOrControl+Shift+Space", // global hotkey for the search palette; "" turns it off
});

function createStore(dir) {
  const root = path.resolve(String(dir));
  const warnings = [];
  // When set, learning sessions are written sealed ({"enc": "v1:…"}).
  let corpusBox = null;

  function ensureDir() {
    fs.mkdirSync(root, { recursive: true });
  }

  function file(name) {
    return path.join(root, name);
  }

  function quarantine(name, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = file(name + ".corrupt-" + stamp);
    try {
      fs.renameSync(file(name), target);
      warnings.push(name + " could not be read (" + reason + "); it was moved to " + path.basename(target) + " and defaults are in use");
    } catch (error) {
      warnings.push(name + " could not be read (" + reason + ") and could not be moved aside: " + error.message);
    }
  }

  function readJson(name, fallback) {
    const target = file(name);
    if (!fs.existsSync(target)) return fallback;
    let raw;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch (error) {
      warnings.push(name + " could not be read: " + error.message);
      return fallback;
    }
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" ? value : fallback;
    } catch (error) {
      quarantine(name, "invalid JSON");
      return fallback;
    }
  }

  function writeJson(name, value) {
    ensureDir();
    const target = file(name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = target + ".tmp-" + process.pid;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(temp, target);
  }

  function appendLine(name, value) {
    ensureDir();
    fs.appendFileSync(file(name), JSON.stringify(value) + "\n", "utf8");
  }

  function readLines(name) {
    const target = file(name);
    if (!fs.existsSync(target)) return [];
    let raw;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch (error) {
      warnings.push(name + " could not be read: " + error.message);
      return [];
    }
    const out = [];
    let bad = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object") out.push(value);
        else bad++;
      } catch (error) {
        bad++;
      }
    }
    if (bad) warnings.push(bad + " unreadable line" + (bad === 1 ? "" : "s") + " skipped in " + name);
    return out;
  }

  function rewriteLines(name, values) {
    ensureDir();
    const target = file(name);
    const temp = target + ".tmp-" + process.pid;
    fs.writeFileSync(temp, values.map((v) => JSON.stringify(v)).join("\n") + (values.length ? "\n" : ""), "utf8");
    fs.renameSync(temp, target);
  }

  // Library: the shared shorthands.json format (version 1), so a file exported
  // from the extension or the personal apps can be dropped in unchanged.
  function loadLibrary() {
    const data = readJson(FILES.library, { version: 1, shorthands: [] });
    return expander.sanitizeList(data.shorthands);
  }

  function saveLibrary(list) {
    writeJson(FILES.library, { version: 1, shorthands: expander.sanitizeList(list) });
  }

  function loadPolicy() {
    return readJson(FILES.policy, null);
  }

  function savePolicy(policy) {
    writeJson(FILES.policy, policy);
  }

  function loadSettings() {
    const data = readJson(FILES.settings, {});
    const out = Object.assign({}, DEFAULT_SETTINGS, data);
    out.enabled = out.enabled !== false;
    const cpm = Number(out.charsPerMinute);
    out.charsPerMinute = Number.isFinite(cpm) && cpm > 0 ? cpm : null;
    out.captureApps = Array.isArray(out.captureApps) ? out.captureApps : [];
    out.installId = typeof out.installId === "string" && out.installId ? out.installId : null;
    out.paletteShortcut = typeof out.paletteShortcut === "string" ? out.paletteShortcut.trim() : DEFAULT_SETTINGS.paletteShortcut;
    return out;
  }

  function saveSettings(settings) {
    writeJson(FILES.settings, Object.assign({}, DEFAULT_SETTINGS, settings));
  }

  function appendMetric(entry) {
    appendLine(FILES.metrics, entry);
  }

  function loadMetrics() {
    return readLines(FILES.metrics).map((raw) => metricsModule.normalizeEntry(raw, Date.now())).filter(Boolean);
  }

  function pruneMetrics(keepDays) {
    const days = Number(keepDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    const all = loadMetrics();
    const kept = all.filter((entry) => entry.at >= cutoff);
    if (kept.length !== all.length) rewriteLines(FILES.metrics, kept);
    return all.length - kept.length;
  }

  function setCorpusBox(box) {
    corpusBox = box || null;
  }

  function sealSession(session) {
    return corpusBox ? { enc: corpusBox.seal(JSON.stringify(session)) } : session;
  }

  function appendSession(session) {
    appendLine(FILES.corpus, sealSession(session));
  }

  /**
   * Read the corpus. Sealed records this desk cannot open (no key, or a
   * different key) are returned as `locked` so a rewrite keeps them: a
   * keychain that is briefly unavailable must not cost the person their
   * learned text.
   */
  function readCorpus() {
    const sessions = [];
    const locked = [];
    let plaintext = 0;
    for (const record of readLines(FILES.corpus)) {
      if (typeof record.enc === "string") {
        const opened = corpusBox ? corpusBox.open(record.enc) : null;
        let session = null;
        try {
          session = opened == null ? null : JSON.parse(opened);
        } catch (error) {
          session = null;
        }
        if (session && typeof session.text === "string") sessions.push(session);
        else locked.push(record);
      } else if (typeof record.text === "string") {
        plaintext++;
        sessions.push(record);
      }
    }
    return { sessions, locked, plaintext };
  }

  let lockedWarned = -1;
  function loadSessions() {
    const corpus = readCorpus();
    if (corpus.locked.length && corpus.locked.length !== lockedWarned) {
      warnings.push(corpus.locked.length + " learned session(s) are encrypted with a key this desk cannot read; they are kept but not used");
    }
    lockedWarned = corpus.locked.length;
    return corpus.sessions;
  }

  function pruneSessions(keepDays) {
    const days = Number(keepDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    const corpus = readCorpus();
    const kept = corpus.sessions.filter((s) => Number(s.endedAt || s.startedAt || 0) >= cutoff);
    const removed = corpus.sessions.length - kept.length;
    // Rewriting also seals any plain records left from before encryption.
    if (removed || (corpusBox && corpus.plaintext)) rewriteLines(FILES.corpus, corpus.locked.concat(kept.map(sealSession)));
    return removed;
  }

  /** Seal plain records written before encryption was available. Returns how many. */
  function encryptCorpus() {
    if (!corpusBox) return 0;
    const corpus = readCorpus();
    if (!corpus.plaintext) return 0;
    rewriteLines(FILES.corpus, corpus.locked.concat(corpus.sessions.map(sealSession)));
    return corpus.plaintext;
  }

  function corpusInfo() {
    const corpus = readCorpus();
    const times = corpus.sessions.map((s) => Number(s.endedAt || s.startedAt || 0)).filter((t) => t > 0);
    let bytes = 0;
    try {
      bytes = fs.statSync(file(FILES.corpus)).size;
    } catch (error) {
      bytes = 0;
    }
    return {
      sessions: corpus.sessions.length,
      locked: corpus.locked.length,
      plaintext: corpus.plaintext,
      encrypted: !!corpusBox,
      oldest: times.length ? Math.min(...times) : null,
      newest: times.length ? Math.max(...times) : null,
      bytes,
    };
  }

  function clearSessions() {
    rewriteLines(FILES.corpus, []);
  }

  function loadCorpusKeyBlob() {
    try {
      return fs.readFileSync(file(FILES.corpusKey));
    } catch (error) {
      return null;
    }
  }

  function saveCorpusKeyBlob(blob) {
    ensureDir();
    fs.writeFileSync(file(FILES.corpusKey), blob, { mode: 0o600 });
  }

  /** Keep an unreadable key file (renamed) instead of deleting it. */
  function moveCorpusKeyAside() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = file(FILES.corpusKey + ".unreadable-" + stamp);
    fs.renameSync(file(FILES.corpusKey), target);
    return path.basename(target);
  }

  /** Decisions about learned candidates: texts the person dismissed, so they are not proposed again. */
  function loadLearned() {
    const data = readJson(FILES.learned, {});
    return { dismissed: Array.isArray(data.dismissed) ? data.dismissed.map(String) : [] };
  }

  function saveLearned(learned) {
    writeJson(FILES.learned, { dismissed: Array.isArray(learned && learned.dismissed) ? learned.dismissed : [] });
  }

  // Deployment settings written by IT (policy sources and pinned keys).
  function loadDeployment() {
    return readJson(FILES.deployment, null);
  }

  function cacheName(id) {
    const safe = String(id).replace(/[^a-z0-9]/gi, "");
    return path.join(FILES.policyCacheDir, (safe || "source") + ".json");
  }

  function loadPolicyCache(id) {
    return readJson(cacheName(id), null);
  }

  function savePolicyCache(id, value) {
    writeJson(cacheName(id), value);
  }

  function loadPolicyState() {
    return readJson(FILES.policyState, {});
  }

  function savePolicyState(state) {
    writeJson(FILES.policyState, state);
  }

  /** Audit trail of policy and capture-rule changes: what changed and when, never typed text. */
  function appendAudit(entry) {
    appendLine(FILES.audit, Object.assign({ at: Date.now() }, entry));
  }

  function loadAudit(limit) {
    const all = readLines(FILES.audit);
    const count = Math.floor(Number(limit));
    return Number.isFinite(count) && count > 0 ? all.slice(-count) : all;
  }

  /** Proposals the person chose to suggest to their organisation, not yet exported or removed. */
  function loadSuggestions() {
    const data = readJson(FILES.suggestions, {});
    return Array.isArray(data.queued) ? data.queued : [];
  }

  function saveSuggestions(queued) {
    writeJson(FILES.suggestions, { queued: Array.isArray(queued) ? queued : [] });
  }

  function lookupCacheName(id) {
    const safe = String(id).replace(/[^a-z0-9]/gi, "");
    return path.join(FILES.lookupCacheDir, (safe || "lookup") + ".json");
  }

  function loadLookupCache(id) {
    return readJson(lookupCacheName(id), null);
  }

  function saveLookupCache(id, value) {
    writeJson(lookupCacheName(id), value);
  }

  function loadUploadState() {
    return readJson(FILES.uploadState, null);
  }

  function saveUploadState(state) {
    writeJson(FILES.uploadState, state);
  }

  function exportLibraryJson() {
    return JSON.stringify({ version: 1, shorthands: loadLibrary() }, null, 2) + "\n";
  }

  /** Import a shared-format file; returns the merged list and how many entries were added or updated. */
  function importLibraryJson(text) {
    let data;
    try {
      data = JSON.parse(String(text));
    } catch (error) {
      return { ok: false, error: "The file is not valid JSON." };
    }
    const incoming = expander.sanitizeList(data && data.shorthands);
    if (!incoming.length) return { ok: false, error: "The file contains no shorthands." };
    const current = loadLibrary();
    const byTrigger = new Map(current.map((sh) => [sh.trigger, sh]));
    let added = 0;
    let updated = 0;
    for (const sh of incoming) {
      if (byTrigger.has(sh.trigger)) {
        if (byTrigger.get(sh.trigger).expansion !== sh.expansion) updated++;
      } else added++;
      byTrigger.set(sh.trigger, sh);
    }
    const merged = [...byTrigger.values()];
    saveLibrary(merged);
    return { ok: true, added, updated, total: merged.length };
  }

  return {
    root,
    FILES,
    DEFAULT_SETTINGS,
    warnings: () => warnings.splice(0),
    loadLibrary,
    saveLibrary,
    loadPolicy,
    savePolicy,
    loadSettings,
    saveSettings,
    appendMetric,
    loadMetrics,
    pruneMetrics,
    setCorpusBox,
    appendSession,
    loadSessions,
    pruneSessions,
    encryptCorpus,
    corpusInfo,
    clearSessions,
    loadCorpusKeyBlob,
    saveCorpusKeyBlob,
    moveCorpusKeyAside,
    loadLearned,
    saveLearned,
    exportLibraryJson,
    importLibraryJson,
    loadDeployment,
    loadPolicyCache,
    savePolicyCache,
    loadPolicyState,
    savePolicyState,
    appendAudit,
    loadAudit,
    loadSuggestions,
    saveSuggestions,
    loadUploadState,
    saveUploadState,
    loadLookupCache,
    saveLookupCache,
  };
}

module.exports = { FILES, DEFAULT_SETTINGS, createStore };
