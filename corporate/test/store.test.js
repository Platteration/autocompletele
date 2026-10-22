const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore, FILES } = require("../core/store.js");

function temp() {
  const base = process.env.ACTLE_TEST_TMP || os.tmpdir();
  return fs.mkdtempSync(path.join(base, "actle-corporate-"));
}

test("library round-trips in the shared format and imports merge by trigger", () => {
  const store = createStore(temp());
  assert.deepEqual(store.loadLibrary(), []);
  store.saveLibrary([{ trigger: "a/", expansion: "A" }, { trigger: " ", expansion: "skip" }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.root, FILES.library), "utf8")), { version: 1, shorthands: [{ trigger: "a/", expansion: "A" }] });
  const result = store.importLibraryJson(JSON.stringify({ version: 1, shorthands: [{ trigger: "a/", expansion: "A2" }, { trigger: "b/", expansion: "B" }] }));
  assert.deepEqual(result, { ok: true, added: 1, updated: 1, total: 2 });
  assert.deepEqual(store.loadLibrary().map((sh) => sh.expansion), ["A2", "B"]);
  assert.equal(store.importLibraryJson("nope").ok, false);
  assert.equal(store.importLibraryJson("{}").ok, false);
  assert.match(store.exportLibraryJson(), /"b\/"/);
});

test("a corrupt file is moved aside with a warning and defaults are used", () => {
  const store = createStore(temp());
  fs.writeFileSync(path.join(store.root, FILES.settings), "{broken", "utf8");
  const settings = store.loadSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.charsPerMinute, null);
  const warnings = store.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /settings\.json could not be read/);
  assert.ok(fs.readdirSync(store.root).some((name) => name.startsWith("settings.json.corrupt-")));
  assert.deepEqual(store.warnings(), [], "warnings are handed over once");
});

test("metrics and corpus are append-only logs that skip bad lines and prune by age", () => {
  const store = createStore(temp());
  const day = 86400000;
  store.appendMetric({ at: Date.now() - 400 * day, kind: "expansion", keystrokesSaved: 5 });
  store.appendMetric({ at: Date.now(), kind: "expansion", keystrokesSaved: 7 });
  fs.appendFileSync(path.join(store.root, FILES.metrics), "garbage\n", "utf8");
  assert.deepEqual(store.loadMetrics().map((e) => e.keystrokesSaved), [5, 7]);
  assert.match(store.warnings()[0], /1 unreadable line skipped/);
  assert.equal(store.pruneMetrics(365), 1);
  assert.deepEqual(store.loadMetrics().map((e) => e.keystrokesSaved), [7]);
  assert.equal(store.pruneMetrics(0), 0);

  store.appendSession({ app: "outlook", startedAt: 1, endedAt: Date.now() - 100 * day, text: "old" });
  store.appendSession({ app: "outlook", startedAt: 1, endedAt: Date.now(), text: "new" });
  assert.equal(store.loadSessions().length, 2);
  assert.equal(store.pruneSessions(90), 1);
  assert.deepEqual(store.loadSessions().map((s) => s.text), ["new"]);
  store.clearSessions();
  assert.deepEqual(store.loadSessions(), []);
});

test("settings, policy and learned decisions persist", () => {
  const store = createStore(temp());
  store.saveSettings({ enabled: false, charsPerMinute: 250, captureApps: [{ process: "slack", mode: "learn" }] });
  const settings = store.loadSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.charsPerMinute, 250);
  assert.equal(settings.captureApps.length, 1);
  assert.equal(settings.shiftEnterForNewlines, false);
  assert.equal(store.loadPolicy(), null);
  store.savePolicy({ version: 1, organization: "X" });
  assert.equal(store.loadPolicy().organization, "X");
  assert.deepEqual(store.loadLearned(), { dismissed: [] });
  store.saveLearned({ dismissed: ["a phrase"] });
  assert.deepEqual(store.loadLearned(), { dismissed: ["a phrase"] });
});

test("the filing index round-trips, tolerates junk and starts empty", () => {
  const store = createStore(temp());
  assert.deepEqual(store.loadFilingIndex(), { version: 1, entries: [] });
  store.saveFilingIndex({ entries: [{ id: "a", path: "S:/x/a.pdf", rule: "invoice" }] });
  assert.deepEqual(store.loadFilingIndex().entries.map((e) => e.id), ["a"]);
  store.saveFilingIndex({ entries: "nope" });
  assert.deepEqual(store.loadFilingIndex().entries, []);
  fs.writeFileSync(path.join(store.root, FILES.filing), "{broken", "utf8");
  assert.deepEqual(store.loadFilingIndex(), { version: 1, entries: [] });
  assert.match(store.warnings()[0], /filing-index\.json could not be read/);
  const settings = store.loadSettings();
  assert.deepEqual(settings.watchFolders, []);
  assert.deepEqual(settings.ignoredFolders, []);
  store.saveSettings({ watchFolders: [{ path: "~/Scans" }], ignoredFolders: ["~/Downloads"] });
  assert.deepEqual(store.loadSettings().watchFolders, [{ path: "~/Scans" }]);
  assert.deepEqual(store.loadSettings().ignoredFolders, ["~/Downloads"]);
});

test("settings keep only the known keys, each coerced and capped; the desk id is the store's own", () => {
  const store = createStore(temp());
  const target = path.join(store.root, FILES.settings);
  // What a dashboard page could send through settings:save.
  store.saveSettings(JSON.parse(JSON.stringify({
    enabled: false,
    installId: "spoofed-desk-id",
    paletteShortcut: "c",
    notesAuthor: "  " + "y".repeat(100000),
    arbitraryKey: { nested: true },
    captureApps: [{ id: "own-1", mode: "learn", match: { process: "slack", title: "t".repeat(5000), extra: 1 }, extra: true }, "junk", null],
    watchFolders: [{ path: "~/Scans", recursive: true, label: "Scans", extra: 1 }, { path: "" }, 7, "~/Inbox"],
    ignoredFolders: ["~/Downloads"],
    shiftEnterForNewlines: "yes",
  })));
  const raw = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(raw), ["enabled", "charsPerMinute", "captureApps", "shiftEnterForNewlines", "startWithSystem", "installId", "paletteShortcut", "watchFolders", "ignoredFolders", "notesAuthor"]);
  assert.notEqual(raw.installId, "spoofed-desk-id", "a caller cannot choose the desk id");
  assert.match(raw.installId, /^[0-9a-f-]{36}$/, "asking for one when none is stored generates a random one");
  assert.equal(raw.paletteShortcut, "CommandOrControl+Shift+Space", "a plain key is no global hotkey");
  assert.equal(raw.notesAuthor, "y".repeat(200));
  assert.deepEqual(raw.captureApps, [{ id: "own-1", mode: "learn", match: { process: "slack", title: "t".repeat(1000) } }]);
  assert.deepEqual(raw.watchFolders, [{ path: "~/Scans", recursive: true, label: "Scans" }, "~/Inbox"]);
  assert.equal(raw.shiftEnterForNewlines, false);
  assert.equal(raw.enabled, false);

  // A caller merging into a fresh object with Object.assign can hand over inherited keys; only own ones count.
  store.saveSettings(Object.assign({}, JSON.parse('{"__proto__": {"notesAuthor": "inherited", "watchFolders": ["/"]}}')));
  assert.equal(Object.hasOwn(store.loadSettings(), "notesAuthor"), false);
  assert.deepEqual(store.loadSettings().watchFolders, []);
  store.saveSettings({ captureApps: Array.from({ length: 300 }, (v, i) => ({ id: "r" + i, mode: "off", match: { process: ["outlook.exe", 5] } })) });
  assert.equal(store.loadSettings().captureApps.length, 200, "lists are capped");
  assert.deepEqual(store.loadSettings().captureApps[0].match, { process: ["outlook.exe"] });

  const id = raw.installId;
  store.saveSettings(Object.assign(store.loadSettings(), { installId: "another-id" }));
  store.saveSettings({ installId: null });
  assert.equal(store.loadSettings().installId, id, "once stored, the desk id never changes through saveSettings");

  // A file written by an earlier version (or by hand) is read the same way.
  fs.writeFileSync(target, JSON.stringify({ installId: "desk-1", constructor: "x", arbitraryKey: 1, paletteShortcut: " Ctrl+Space ", notesAuthor: 42 }));
  const loaded = store.loadSettings();
  assert.equal(Object.hasOwn(loaded, "arbitraryKey"), false);
  assert.equal(Object.hasOwn(loaded, "constructor"), false);
  assert.equal(loaded.installId, "desk-1");
  assert.equal(loaded.paletteShortcut, "Ctrl+Space");
  assert.equal(loaded.notesAuthor, "");
  fs.writeFileSync(target, JSON.stringify({ installId: "../not an id" }));
  assert.equal(store.loadSettings().installId, null, "a malformed stored id is dropped; the next report generates one");
  const fallback = "CommandOrControl+Shift+Space";
  for (const [given, kept] of [["", ""], ["F9", "F9"], ["Shift+F2", "Shift+F2"], ["Alt+F4", "Alt+F4"], ["CmdOrCtrl+,", "CmdOrCtrl+,"], ["Ctrl+Z", "Ctrl+Z"],
    ["Command+Option+K", "Command+Option+K"], ["Super+Alt+K", "Super+Alt+K"], ["Meta+Shift+P", "Meta+Shift+P"],
    ["Shift+A", fallback], ["Ctrl+Alt", fallback], [7, fallback], ["Space", fallback], ["Shift+Space", fallback],
    // Chords that type characters: Option+L is "@" on a German Mac, Ctrl+Alt is AltGr on Windows, Option+Space a no-break space.
    ["Alt+L", fallback], ["Option+E", fallback], ["AltGr+Q", fallback], ["Control+Alt+Q", fallback], ["CommandOrControl+Alt+7", fallback],
    ["Alt+Shift+2", fallback], ["Alt+Space", fallback]]) {
    fs.writeFileSync(target, JSON.stringify({ paletteShortcut: given }));
    assert.equal(store.loadSettings().paletteShortcut, kept, JSON.stringify(given));
  }
});

test("the desk id survives a settings.json that is corrupt or unreadable when the next save comes", () => {
  const store = createStore(temp());
  const target = path.join(store.root, FILES.settings);
  store.saveSettings({ installId: "asked" });
  const id = store.loadSettings().installId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  fs.writeFileSync(target, "{ half-saved hand edit");
  store.saveSettings({ charsPerMinute: 250, installId: "asked" });
  assert.equal(store.loadSettings().installId, id, "not a second id for the same desk");
  assert.equal(store.loadSettings().charsPerMinute, 250);
  assert.ok(fs.readdirSync(store.root).some((name) => name.startsWith("settings.json.corrupt-")), "the broken file is kept aside");
  // A file that cannot be read for a moment (an antivirus lock) keeps it too.
  const realRead = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    if (file === target) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return realRead.call(this, file, ...rest);
  };
  try {
    store.saveSettings({ enabled: false, installId: "asked" });
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(store.loadSettings().installId, id);
  assert.equal(store.loadSettings().enabled, false);
  // At the next start a new store learns the id when it reads the settings, and keeps it through a broken file too.
  const next = createStore(store.root);
  assert.equal(next.loadSettings().installId, id);
  fs.writeFileSync(target, "{ broken again");
  next.saveSettings({ enabled: true });
  assert.equal(next.loadSettings().installId, id);
  // Reading a broken file in between (defaults, no id) does not make the store forget it.
  fs.writeFileSync(target, "{ broken once more");
  assert.equal(next.loadSettings().installId, null);
  next.saveSettings({ enabled: true });
  assert.equal(next.loadSettings().installId, id);
});

test("watch and ignored folders keep whole paths: an impossible length is dropped, never cut, and the lists are capped", () => {
  const store = createStore(temp());
  const long = "/srv/" + "a".repeat(4090); // longer than macOS allows, as long as Linux allows
  const impossible = "/srv/" + "b".repeat(32763); // 32,768 characters: no system opens it
  store.saveSettings({
    watchFolders: [long, impossible, { path: long, recursive: true }, { path: impossible }, "", "   ", { path: "  " }],
    ignoredFolders: [long, impossible, "", "   ", 7, null, "~/Downloads"],
  });
  const settings = store.loadSettings();
  assert.deepEqual(settings.watchFolders, [long, { path: long, recursive: true }]);
  assert.deepEqual(settings.ignoredFolders, [long, "~/Downloads"], "a turned-off policy folder still matches its policy path");
  store.saveSettings({ ignoredFolders: Array.from({ length: 300 }, (v, i) => "S:/policy/" + i), watchFolders: Array.from({ length: 300 }, (v, i) => "~/own/" + i) });
  assert.equal(store.loadSettings().ignoredFolders.length, 200);
  assert.equal(store.loadSettings().ignoredFolders.at(-1), "S:/policy/199");
  assert.equal(store.loadSettings().watchFolders.length, 200);
});

test("data files are written for this account only, and older ones are tightened when the store opens (hygiene)", { skip: process.platform === "win32" && "Windows relies on the profile ACL" }, () => {
  const mode = (target) => fs.statSync(target).mode & 0o777;
  const previous = process.umask(0o022);
  try {
    const base = temp();
    const store = createStore(path.join(base, "userData"));
    store.saveSettings({ enabled: true });
    store.saveFilingIndex({ entries: [{ id: "a", path: "/x" }] });
    store.appendAudit({ event: "x" });
    store.appendMetric({ at: Date.now() - 400 * 86400000, kind: "expansion", keystrokesSaved: 1 });
    store.appendMetric({ at: Date.now(), kind: "expansion", keystrokesSaved: 2 });
    store.pruneMetrics(30); // rewrites the file
    store.saveAppData("forms", { sessions: [] });
    store.savePolicyCache("intranet", { serial: 1 });
    store.appendSession({ app: "x", startedAt: 1, endedAt: Date.now(), text: "t" });
    assert.equal(mode(store.root), 0o700);
    for (const dir of ["apps", "policy-cache"]) assert.equal(mode(path.join(store.root, dir)), 0o700, dir);
    for (const name of ["settings.json", "filing-index.json", "audit.jsonl", "metrics.jsonl", "corpus.jsonl", "apps/forms.json", "policy-cache/intranet.json"]) {
      assert.equal(mode(path.join(store.root, name)), 0o600, name);
    }

    // A folder written before (or created by IT with mkdir -p): tightened once, nothing else touched.
    const old = path.join(base, "older");
    fs.mkdirSync(path.join(old, "apps"), { recursive: true, mode: 0o755 });
    fs.chmodSync(old, 0o755);
    fs.writeFileSync(path.join(old, "settings.json"), "{}", { mode: 0o644 });
    fs.writeFileSync(path.join(old, "audit.jsonl.corrupt-2026"), "", { mode: 0o644 });
    fs.writeFileSync(path.join(old, "apps", "forms.json"), "{}", { mode: 0o644 });
    fs.writeFileSync(path.join(old, "Preferences"), "{}", { mode: 0o644 }); // Electron's, not the store's
    const outside = path.join(base, "outside.txt");
    fs.writeFileSync(outside, "x", { mode: 0o644 });
    fs.symlinkSync(outside, path.join(old, "learned.json"));
    // A deployment.json IT installed as another account (testable when the suite runs as root).
    const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
    fs.writeFileSync(path.join(old, "deployment.json"), "{}", { mode: 0o644 });
    if (asRoot) fs.chownSync(path.join(old, "deployment.json"), 65534, 65534);
    createStore(old);
    assert.equal(mode(old), 0o700);
    assert.equal(mode(path.join(old, "apps")), 0o700);
    assert.equal(mode(path.join(old, "settings.json")), 0o600);
    assert.equal(mode(path.join(old, "audit.jsonl.corrupt-2026")), 0o600);
    assert.equal(mode(path.join(old, "apps", "forms.json")), 0o600);
    assert.equal(mode(path.join(old, "Preferences")), 0o644, "files the store does not write are left alone");
    assert.equal(mode(outside), 0o644, "a symbolic link is not followed");
    assert.equal(mode(path.join(old, "deployment.json")), asRoot ? 0o644 : 0o600, "another account's file is left alone");

    // The same, as any account: a folder and files whose owner is not this process's uid are left as they are.
    const foreign = path.join(base, "foreign");
    fs.mkdirSync(path.join(foreign, "apps"), { recursive: true, mode: 0o755 });
    fs.chmodSync(foreign, 0o755);
    fs.writeFileSync(path.join(foreign, "settings.json"), "{}", { mode: 0o644 });
    fs.writeFileSync(path.join(foreign, "apps", "forms.json"), "{}", { mode: 0o644 });
    const realUid = process.getuid;
    process.getuid = () => realUid.call(process) + 1;
    try {
      createStore(foreign);
    } finally {
      process.getuid = realUid;
    }
    for (const [name, expected] of [["", 0o755], ["apps", 0o755], ["settings.json", 0o644], ["apps/forms.json", 0o644]]) {
      assert.equal(mode(path.join(foreign, name)), expected, "another account's " + (name || "folder") + " is left alone");
    }
  } finally {
    process.umask(previous);
  }
});

test("per-app data files live under apps/ and start from the given fallback", () => {
  const store = createStore(temp());
  assert.deepEqual(store.loadAppData("reply"), {});
  assert.deepEqual(store.loadAppData("reply", { stats: {} }), { stats: {} });
  store.saveAppData("reply", { stats: { late: { offered: 2 } } });
  assert.deepEqual(store.loadAppData("reply").stats.late.offered, 2);
  assert.ok(fs.existsSync(path.join(store.root, "apps", "reply.json")));
  store.saveAppData("../escape", { x: 1 });
  assert.ok(fs.existsSync(path.join(store.root, "apps", "escape.json")), "ids cannot leave the apps folder");
  store.saveAppData("notes", "junk");
  assert.deepEqual(store.loadAppData("notes"), {});
});

test("deployment, policy cache, policy state and audit log persist", () => {
  const store = createStore(temp());
  assert.equal(store.loadDeployment(), null);
  fs.writeFileSync(path.join(store.root, FILES.deployment), JSON.stringify({ policySources: [] }), "utf8");
  assert.deepEqual(store.loadDeployment(), { policySources: [] });
  assert.equal(store.loadPolicyCache("abc123"), null);
  store.savePolicyCache("abc123", { serial: 2, envelope: "{}" });
  assert.deepEqual(store.loadPolicyCache("abc123"), { serial: 2, envelope: "{}" });
  assert.ok(fs.existsSync(path.join(store.root, "policy-cache", "abc123.json")));
  store.savePolicyCache("../../escape", { serial: 1 });
  assert.ok(fs.existsSync(path.join(store.root, "policy-cache", "escape.json")), "ids cannot leave the cache folder");
  assert.deepEqual(store.loadPolicyState(), {});
  store.savePolicyState({ hash: "h1" });
  assert.deepEqual(store.loadPolicyState(), { hash: "h1" });
  store.appendAudit({ event: "a", at: 1 });
  store.appendAudit({ event: "b" });
  store.appendAudit({ event: "c" });
  assert.deepEqual(store.loadAudit().map((e) => e.event), ["a", "b", "c"]);
  assert.equal(store.loadAudit()[0].at, 1);
  assert.equal(typeof store.loadAudit()[1].at, "number");
  assert.deepEqual(store.loadAudit(2).map((e) => e.event), ["b", "c"]);
});
