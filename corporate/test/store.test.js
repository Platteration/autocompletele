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
