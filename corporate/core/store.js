// Files under the app data folder. Reads never refuse: a corrupt file is moved
// aside with a warning and the app starts with defaults, so one bad write
// cannot lock a person out of their library or hide their statistics.
// Writes are atomic (temp file + rename).
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { expander } = require("./personal.js");
const metricsModule = require("./metrics.js");

// Hygiene: files are created readable by the person only and folders
// listable by the person only, like corpus.key, instead of what the umask
// gives (0644/0755). It only matters where the folder above is traversable
// by other accounts (a data folder IT created with mkdir -p, a custom path);
// Electron creates its own user-data folder 0700. Windows ignores the bits
// and relies on the profile's ACL.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

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
  filing: "filing-index.json",
  appsDir: "apps",
});

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  charsPerMinute: null,       // null = use the policy's assumption
  captureApps: [],            // the person's own learn/off rules, same shape as policy.capture.apps
  shiftEnterForNewlines: false,
  startWithSystem: false,
  installId: null,            // random id that lets an administrator count a desk's reports once
  paletteShortcut: "CommandOrControl+Shift+Space", // global hotkey for the search palette; "" turns it off
  watchFolders: [],           // the person's own folders to file from, same shape as policy.filing.watch
  ignoredFolders: [],         // policy watch folders the person turned off ("Never for this folder")
});

// Settings the suite's apps keep in settings.json (desktop/apps): dactle
// remembers the author. settings.json holds these and DEFAULT_SETTINGS'
// keys only; anything else a caller sends is dropped.
const APP_SETTINGS = Object.freeze({ notesAuthor: "" });

// path: no desktop system opens a longer path (Windows' extended paths stop at
// 32,767 characters). A longer one is dropped, never cut: a cut path names
// another folder, and a cut ignoredFolders entry no longer matches the policy
// folder it turns off, which would then be watched again.
const LIMITS = Object.freeze({ list: 200, text: 200, path: 32767, pattern: 1000, shortcut: 100 });

function own(source, key) {
  return source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function cappedText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// A process, bundle id or title is a string or a list of strings (capture-policy's list()).
function textOrList(value, max) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").slice(0, LIMITS.list).map((v) => v.slice(0, max));
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

// The person's own capture rules, in the shape capture-policy reads: id,
// label, mode, and process/bundleId/title either in `match` or on the rule.
function cleanCaptureRule(raw) {
  if (!isPlainObject(raw)) return null;
  const rule = {};
  for (const key of ["id", "label", "mode"]) if (typeof own(raw, key) === "string") rule[key] = raw[key].slice(0, LIMITS.text);
  const copyMatch = (from, to) => {
    for (const key of ["process", "bundleId"]) {
      const value = textOrList(own(from, key), LIMITS.text);
      if (value !== undefined) to[key] = value;
    }
    const title = textOrList(own(from, "title"), LIMITS.pattern);
    if (title !== undefined) to.title = title;
  };
  copyMatch(raw, rule);
  if (isPlainObject(own(raw, "match"))) {
    rule.match = {};
    copyMatch(raw.match, rule.match);
  }
  return rule;
}

function cleanPath(value) {
  return typeof value === "string" && value.trim() && value.length <= LIMITS.path ? value : null;
}

// A watch folder is a path, or {path, recursive?, label?} as the dashboard and policy write it.
function cleanWatchFolder(raw) {
  if (typeof raw === "string") return cleanPath(raw);
  if (!isPlainObject(raw) || !cleanPath(own(raw, "path"))) return null;
  const folder = { path: raw.path };
  if (own(raw, "recursive") !== undefined) folder.recursive = raw.recursive === true;
  if (typeof own(raw, "label") === "string") folder.label = raw.label.slice(0, LIMITS.text);
  return folder;
}

// An Electron accelerator: modifiers joined by "+" and a key; "" turns the
// palette hotkey off. Hardening (the dashboard never sends this key; it is
// edited by hand). Threat: a global hotkey takes its key combination away
// from every application, so one that types a character stops the person
// typing it anywhere: a plain or Shift-only key, Alt/Option (Option+L is "@"
// on a German Mac), AltGr, and Ctrl+Alt (AltGr on Windows). So the key is a
// function key, or the chord has Command, Super or Meta, or Control without
// Alt, Option or AltGr. A chord the applications use themselves (Ctrl+C) is
// not refused: that is a choice, not a character.
const MODIFIERS = /^(?:command|cmd|control|ctrl|commandorcontrol|cmdorctrl|alt|option|altgr|shift|super|meta)$/i;
const COMMAND = /^(?:command|cmd|super|meta)$/i;
const CONTROL = /^(?:control|ctrl|commandorcontrol|cmdorctrl)$/i;
const TYPING = /^(?:alt|option|altgr)$/i;
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/i;
function cleanShortcut(value) {
  if (typeof value !== "string") return DEFAULT_SETTINGS.paletteShortcut;
  const text = value.trim();
  if (!text) return "";
  const parts = text.split("+");
  const key = parts.pop();
  const has = (pattern) => parts.some((part) => pattern.test(part));
  const ok = text.length <= LIMITS.shortcut && (/^[A-Za-z0-9]+$/.test(key) || /^[!-*,-/:-@[-`{-~]$/.test(key)) && !MODIFIERS.test(key)
    && parts.every((part) => MODIFIERS.test(part)) && (FUNCTION_KEY.test(key) || has(COMMAND) || (has(CONTROL) && !has(TYPING)));
  return ok ? text : DEFAULT_SETTINGS.paletteShortcut;
}

// The desk id is generated here (crypto.randomUUID); a stored one is kept as
// long as it looks like an id.
function cleanInstallId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : null;
}

/** Only the known settings, each coerced to its type and capped; unknown keys are dropped. */
function cleanSettings(source) {
  const list = (value) => (Array.isArray(value) ? value.slice(0, LIMITS.list) : []);
  const cpm = Number(own(source, "charsPerMinute"));
  const out = {
    enabled: own(source, "enabled") !== false,
    charsPerMinute: Number.isFinite(cpm) && cpm > 0 ? cpm : null,
    captureApps: list(own(source, "captureApps")).map(cleanCaptureRule).filter(Boolean),
    shiftEnterForNewlines: own(source, "shiftEnterForNewlines") === true,
    startWithSystem: own(source, "startWithSystem") === true,
    installId: cleanInstallId(own(source, "installId")),
    paletteShortcut: own(source, "paletteShortcut") === undefined ? DEFAULT_SETTINGS.paletteShortcut : cleanShortcut(source.paletteShortcut),
    watchFolders: list(own(source, "watchFolders")).map(cleanWatchFolder).filter(Boolean),
    ignoredFolders: list(own(source, "ignoredFolders")).map(cleanPath).filter(Boolean),
  };
  for (const key of Object.keys(APP_SETTINGS)) {
    if (own(source, key) !== undefined) out[key] = cappedText(source[key], LIMITS.text);
  }
  return out;
}

function createStore(dir) {
  const root = path.resolve(String(dir));
  const warnings = [];
  // When set, learning sessions are written sealed ({"enc": "v1:…"}).
  let corpusBox = null;

  function ensureDir() {
    fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  }

  // Hygiene, once when the store opens: the data folder, apps/,
  // policy-cache/ and the store's own files written before the modes above
  // (or under a looser umask) are tightened to them. Only what the store
  // writes is touched (not Electron's files in the same folder), never
  // through a symbolic link, never a file another account owns (a
  // deployment.json IT installed). A failure is a warning, never a refusal.
  function tightenExisting() {
    // Windows has no uid here and relies on the profile's ACL.
    if (typeof process.getuid !== "function") return;
    const uid = process.getuid();
    // `stat` is lstat for what is inside the folder, so a link is never followed there.
    const tighten = (target, mode, statOf) => {
      let stat;
      try {
        stat = statOf(target);
      } catch (error) {
        return;
      }
      if (stat.uid !== uid || ((stat.mode & 0o777) & ~mode) === 0) return;
      try {
        fs.chmodSync(target, mode);
      } catch (error) {
        warnings.push(path.basename(target) + " could not be made private to this account: " + error.message);
      }
    };
    // Directory entries are typed without following links: a link is neither a file nor a folder here.
    const entries = (folder) => {
      try {
        return fs.readdirSync(folder, { withFileTypes: true });
      } catch (error) {
        return [];
      }
    };
    tighten(root, DIR_MODE, fs.statSync);
    const ownNames = Object.values(FILES).filter((name) => name !== FILES.appsDir && name !== FILES.policyCacheDir);
    const subfolders = [FILES.appsDir, FILES.policyCacheDir];
    for (const entry of entries(root)) {
      // The files themselves and what the store derives from them (temp files, moved-aside copies).
      if (entry.isFile() && ownNames.some((name) => entry.name === name || entry.name.startsWith(name + "."))) tighten(file(entry.name), FILE_MODE, fs.lstatSync);
      if (entry.isDirectory() && subfolders.includes(entry.name)) {
        const folder = file(entry.name);
        tighten(folder, DIR_MODE, fs.lstatSync);
        for (const inner of entries(folder)) if (inner.isFile()) tighten(path.join(folder, inner.name), FILE_MODE, fs.lstatSync);
      }
    }
  }
  tightenExisting();

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
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: DIR_MODE });
    const temp = target + ".tmp-" + process.pid;
    // The temp file's mode survives the rename.
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: FILE_MODE });
    fs.renameSync(temp, target);
  }

  function appendLine(name, value) {
    ensureDir();
    fs.appendFileSync(file(name), JSON.stringify(value) + "\n", { encoding: "utf8", mode: FILE_MODE });
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
    fs.writeFileSync(temp, values.map((v) => JSON.stringify(v)).join("\n") + (values.length ? "\n" : ""), { encoding: "utf8", mode: FILE_MODE });
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

  // settings.json keeps DEFAULT_SETTINGS' keys and APP_SETTINGS' only, each
  // coerced and capped (cleanSettings), on the way in and on the way out:
  // what the dashboard or an app sends cannot add keys, grow without limit,
  // or set installId.
  // The desk id this store last read or wrote. A settings.json that is
  // corrupt or briefly unreadable when the next save comes (a half-saved hand
  // edit, an antivirus lock) must not mint a second id for the same desk:
  // reports and suggestions count desks by it.
  let knownInstallId = null;

  function loadSettings() {
    const settings = cleanSettings(readJson(FILES.settings, {}));
    if (settings.installId) knownInstallId = settings.installId;
    return settings;
  }

  /**
   * Save the settings. installId is never taken from the caller: the stored
   * one is kept (or the one this store last saw), and when there is none a
   * caller that passes one (the assistant, before its first report) gets a
   * new random id generated here.
   */
  function saveSettings(settings) {
    const out = cleanSettings(settings);
    const stored = cleanInstallId(own(readJson(FILES.settings, {}), "installId"));
    out.installId = stored || knownInstallId || (own(settings, "installId") ? crypto.randomUUID() : null);
    knownInstallId = out.installId;
    writeJson(FILES.settings, out);
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

  /** Per-app data files (apps/<id>.json) for the suite's apps: counts, sessions, settings of their own. */
  function appFile(id) {
    const safe = String(id == null ? "" : id).replace(/[^a-z0-9-]/gi, "");
    return path.join(FILES.appsDir, (safe || "app") + ".json");
  }

  function loadAppData(id, fallback) {
    return readJson(appFile(id), fallback === undefined ? {} : fallback);
  }

  function saveAppData(id, value) {
    writeJson(appFile(id), value && typeof value === "object" ? value : {});
  }

  /** Filed documents: names, paths and the values found, never document text. */
  function loadFilingIndex() {
    const data = readJson(FILES.filing, { version: 1, entries: [] });
    return { version: 1, entries: Array.isArray(data.entries) ? data.entries : [] };
  }

  function saveFilingIndex(index) {
    writeJson(FILES.filing, { version: 1, entries: Array.isArray(index && index.entries) ? index.entries : [] });
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
    loadFilingIndex,
    saveFilingIndex,
    loadAppData,
    saveAppData,
  };
}

module.exports = { FILES, DEFAULT_SETTINGS, createStore };
