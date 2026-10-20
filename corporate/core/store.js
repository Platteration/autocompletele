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
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  charsPerMinute: null,       // null = use the policy's assumption
  captureApps: [],            // the person's own learn/off rules, same shape as policy.capture.apps
  shiftEnterForNewlines: false,
  startWithSystem: false,
});

function createStore(dir) {
  const root = path.resolve(String(dir));
  const warnings = [];

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

  function appendSession(session) {
    appendLine(FILES.corpus, session);
  }

  function loadSessions() {
    return readLines(FILES.corpus).filter((s) => typeof s.text === "string");
  }

  function pruneSessions(keepDays) {
    const days = Number(keepDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    const all = loadSessions();
    const kept = all.filter((s) => Number(s.endedAt || s.startedAt || 0) >= cutoff);
    if (kept.length !== all.length) rewriteLines(FILES.corpus, kept);
    return all.length - kept.length;
  }

  function clearSessions() {
    rewriteLines(FILES.corpus, []);
  }

  /** Decisions about learned candidates: texts the person dismissed, so they are not proposed again. */
  function loadLearned() {
    const data = readJson(FILES.learned, {});
    return { dismissed: Array.isArray(data.dismissed) ? data.dismissed.map(String) : [] };
  }

  function saveLearned(learned) {
    writeJson(FILES.learned, { dismissed: Array.isArray(learned && learned.dismissed) ? learned.dismissed : [] });
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
    appendSession,
    loadSessions,
    pruneSessions,
    clearSessions,
    loadLearned,
    saveLearned,
    exportLibraryJson,
    importLibraryJson,
  };
}

module.exports = { FILES, DEFAULT_SETTINGS, createStore };
