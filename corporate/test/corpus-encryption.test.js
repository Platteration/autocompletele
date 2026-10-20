const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBox, generateKey } = require("../core/crypto-box.js");
const { createStore, FILES } = require("../core/store.js");
const { loadCorpusKey } = require("../desktop/corpus-key.js");
const { createAssistant } = require("../desktop/assistant.js");

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-corpus-"));
}

function fakeKeychain(overrides) {
  return Object.assign({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from("KC:" + text),
    decryptString: (blob) => {
      const text = Buffer.from(blob).toString();
      if (!text.startsWith("KC:")) throw new Error("not ours");
      return text.slice(3);
    },
  }, overrides);
}

const session = (text, endedAt) => ({ app: "outlook", startedAt: (endedAt || Date.now()) - 1000, endedAt: endedAt || Date.now(), text, redactions: 0 });

test("the box round-trips text and rejects altered records and other keys", () => {
  const box = createBox(generateKey());
  const sealed = box.seal("Grüße, café 🎉");
  assert.match(sealed, /^v1:/);
  assert.equal(box.open(sealed), "Grüße, café 🎉");
  assert.notEqual(box.seal("same"), box.seal("same"), "a fresh nonce every time");
  const raw = Buffer.from(sealed.slice(3), "base64");
  raw[raw.length - 1] ^= 1;
  assert.equal(box.open("v1:" + raw.toString("base64")), null);
  assert.equal(createBox(generateKey()).open(sealed), null);
  assert.equal(box.open("plain"), null);
  assert.equal(box.open("v1:AAAA"), null);
  assert.equal(box.open(null), null);
  assert.throws(() => createBox(Buffer.alloc(16)), /32 bytes/);
});

test("sealed sessions never show their text on disk and read back with the key", () => {
  const store = createStore(temp());
  store.setCorpusBox(createBox(generateKey()));
  store.appendSession(session("Thanks for your order A-1001"));
  const disk = fs.readFileSync(path.join(store.root, FILES.corpus), "utf8");
  assert.equal(disk.includes("Thanks"), false);
  assert.equal(disk.includes("outlook"), false, "metadata is sealed too");
  assert.deepEqual(store.loadSessions().map((s) => s.text), ["Thanks for your order A-1001"]);
  assert.equal(store.corpusInfo().encrypted, true);
});

test("plain records from before encryption are sealed, and unreadable ones are kept", () => {
  const dir = temp();
  const plain = createStore(dir);
  plain.appendSession(session("old plain text"));
  const keyA = generateKey();
  const a = createStore(dir);
  a.setCorpusBox(createBox(keyA));
  assert.equal(a.encryptCorpus(), 1);
  assert.equal(a.encryptCorpus(), 0);
  assert.equal(fs.readFileSync(path.join(dir, FILES.corpus), "utf8").includes("old plain"), false);
  a.appendSession(session("second"));

  // A desk without the key (keychain locked) reads nothing but keeps the records.
  const locked = createStore(dir);
  assert.deepEqual(locked.loadSessions(), []);
  assert.match(locked.warnings().join(" "), /2 learned session\(s\) are encrypted with a key this desk cannot read/);
  locked.pruneSessions(1);
  assert.equal(locked.corpusInfo().locked, 2);

  // A desk with another key prunes an expired plain record: the rewrite
  // must carry the two records it cannot read over unchanged.
  createStore(dir).appendSession(session("expired plain", Date.now() - 5 * 86400000));
  const other = createStore(dir);
  other.setCorpusBox(createBox(generateKey()));
  assert.equal(other.pruneSessions(1), 1);
  assert.equal(other.corpusInfo().locked, 2, "the records sealed with the other key survive the rewrite");
  assert.equal(fs.readFileSync(path.join(dir, FILES.corpus), "utf8").includes("expired plain"), false);

  const back = createStore(dir);
  back.setCorpusBox(createBox(keyA));
  assert.deepEqual(back.loadSessions().map((s) => s.text).sort(), ["old plain text", "second"]);
});

test("pruning by age keeps locked records and seals what it rewrites", () => {
  const dir = temp();
  const day = 86400000;
  const plain = createStore(dir);
  plain.appendSession(session("ancient", Date.now() - 200 * day));
  plain.appendSession(session("recent plain", Date.now()));
  const store = createStore(dir);
  store.setCorpusBox(createBox(generateKey()));
  assert.equal(store.pruneSessions(90), 1);
  assert.deepEqual(store.loadSessions().map((s) => s.text), ["recent plain"]);
  assert.equal(fs.readFileSync(path.join(dir, FILES.corpus), "utf8").includes("recent plain"), false);
  const info = store.corpusInfo();
  assert.equal(info.sessions, 1);
  assert.equal(info.plaintext, 0);
  assert.ok(info.bytes > 0);
  store.clearSessions();
  assert.equal(store.corpusInfo().sessions, 0);
});

test("the corpus key comes from the keychain and is never replaced while it protects records", () => {
  const dir = temp();
  const store = createStore(dir);
  assert.equal(loadCorpusKey({ store, keychain: undefined }).status, "unavailable");
  assert.equal(loadCorpusKey({ store, keychain: fakeKeychain({ isEncryptionAvailable: () => false }) }).status, "unavailable");
  const basic = loadCorpusKey({ store, keychain: fakeKeychain({ getSelectedStorageBackend: () => "basic_text" }) });
  assert.equal(basic.status, "unavailable");
  assert.match(basic.message, /GNOME Keyring or KWallet/);
  assert.equal(fs.existsSync(path.join(dir, FILES.corpusKey)), false, "nothing written without a real keychain");

  const created = loadCorpusKey({ store, keychain: fakeKeychain() });
  assert.equal(created.status, "created");
  assert.equal(created.key.length, 32);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, FILES.corpusKey)).mode & 0o777, 0o600);
  const again = loadCorpusKey({ store, keychain: fakeKeychain() });
  assert.equal(again.status, "ok");
  assert.ok(again.key.equals(created.key));

  store.setCorpusBox(createBox(created.key));
  store.appendSession(session("protected"));
  store.setCorpusBox(null);
  const broken = fakeKeychain({ decryptString: () => { throw new Error("keychain locked"); } });
  const unreadable = loadCorpusKey({ store, keychain: broken });
  assert.equal(unreadable.status, "unreadable");
  assert.equal(unreadable.key, null);
  assert.match(unreadable.message, /1 encrypted session\(s\) are kept untouched/);
  assert.ok(loadCorpusKey({ store, keychain: fakeKeychain() }).key.equals(created.key), "the key file was not touched");

  store.clearSessions();
  const replaced = loadCorpusKey({ store, keychain: fakeKeychain({ decryptString: () => "short" }) });
  assert.equal(replaced.status, "replaced");
  assert.match(replaced.aside, /^corpus\.key\.unreadable-/);
  assert.ok(fs.existsSync(path.join(dir, replaced.aside)), "the old key file is kept, renamed");
});

test("without a keychain learned text is not written, and the person is told", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ capture: { defaultMode: "learn" } }));
  const assistant = createAssistant({ dataDir });
  assert.ok(assistant.warnings().some((w) => /Learning is paused/.test(w)));
  assistant.focusChanged({ process: "notepad" });
  for (const ch of "This is a long enough message to be a learning session.") assistant.keyTyped({ text: ch });
  assistant.focusChanged({ process: "other" });
  assert.equal(fs.existsSync(path.join(dataDir, FILES.corpus)), false);
  const info = assistant.corpusInfo();
  assert.equal(info.storing, false);
  assert.match(info.problem, /no secure keychain/);
});

test("with a keychain, an old plain corpus is sealed at start and the person can delete it", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ capture: { defaultMode: "learn" }, retention: { corpusDays: 30 } }));
  createStore(dataDir).appendSession(session("from the previous version"));
  const assistant = createAssistant({ dataDir, keychain: fakeKeychain() });
  const events = assistant.audit().map((e) => e.event);
  assert.ok(events.includes("corpus-key-created"));
  assert.ok(events.includes("corpus-encrypted"));
  assert.equal(fs.readFileSync(path.join(dataDir, FILES.corpus), "utf8").includes("previous version"), false);
  assistant.focusChanged({ process: "notepad" });
  for (const ch of "This is a long enough message to be a learning session.") assistant.keyTyped({ text: ch });
  assistant.focusChanged({ process: "other" });
  const info = assistant.corpusInfo();
  assert.equal(info.sessions, 2);
  assert.equal(info.storing, true);
  assert.equal(info.retentionDays, 30);
  const cleared = assistant.clearLearning();
  assert.equal(cleared.sessions, 0);
  const deleted = assistant.audit().filter((e) => e.event === "corpus-deleted");
  assert.deepEqual(deleted.map((e) => [e.by, e.sessions]), [["person", 2]]);
});

test("dismissals are stored as digests, and deleting learned text clears dismissals and suggestions", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "learned.json"), JSON.stringify({ dismissed: ["Old plain dismissed sentence about a private matter."] }));
  const assistant = createAssistant({ dataDir, keychain: fakeKeychain() });
  const learned = JSON.parse(fs.readFileSync(path.join(dataDir, "learned.json"), "utf8"));
  assert.deepEqual(learned.dismissed.map((d) => d.slice(0, 7)), ["sha256:"], "plain entries from an earlier version are converted");
  assistant.dismissCandidate("Another proposal the person did not want.");
  const raw = fs.readFileSync(path.join(dataDir, "learned.json"), "utf8");
  assert.equal(/private matter|did not want/.test(raw), false);
  fs.writeFileSync(path.join(dataDir, "suggestions.json"), JSON.stringify({ queued: [{ kind: "phrase", text: "queued text", trigger: "q/" }] }));
  assistant.clearLearning();
  assert.deepEqual(assistant.store.loadLearned().dismissed, []);
  assert.deepEqual(assistant.suggestions(), []);
});

test("a dismissed proposal stays dismissed, whether stored as text or digest", () => {
  const learning = require("../desktop/learning.js");
  const sessions = ["We will get back to you within one business day.", "We will get back to you within one business day.", "We will get back to you within one business day."]
    .map((text) => ({ text: "Hello there.\n\n" + text }));
  const all = learning.candidates({ sessions, library: [], dismissed: [] });
  assert.ok(all.length > 0);
  const target = all[0].text;
  assert.equal(learning.candidates({ sessions, library: [], dismissed: [target] }).some((c) => c.text === target), false);
  assert.equal(learning.candidates({ sessions, library: [], dismissed: [learning.dismissalKey(target)] }).some((c) => c.text === target), false);
});

test("remembered answers are sealed per conversation, locked records survive, and the key is never replaced while they exist", () => {
  const dir = temp();
  const store = createStore(dir);
  assert.equal(store.saveThreads([{ app: "outlook", subject: "order 1234", answers: [{ name: "name", value: "Jo Bloggs", at: 1 }], pronouns: null, createdAt: 1, updatedAt: 1 }]), false, "without a key nothing is written");
  assert.equal(fs.existsSync(path.join(dir, FILES.threads)), false);
  const keyA = generateKey();
  store.setCorpusBox(createBox(keyA));
  assert.equal(store.saveThreads([{ app: "outlook", subject: "order 1234", answers: [{ name: "name", value: "Jo Bloggs", at: 1 }], pronouns: "she/her", createdAt: 1, updatedAt: 1 }]), true);
  const raw = fs.readFileSync(path.join(dir, FILES.threads), "utf8");
  for (const secret of ["Jo Bloggs", "order 1234", "outlook", "she/her"]) assert.equal(raw.includes(secret), false, secret + " is on disk in the clear");
  assert.deepEqual(store.loadThreads().threads.map((t) => t.answers[0].value), ["Jo Bloggs"]);
  assert.deepEqual(store.threadsInfo(), { count: 1, locked: 0, bytes: raw.length });
  // Another key: the old record is locked but kept through a save.
  store.setCorpusBox(createBox(generateKey()));
  assert.deepEqual([store.loadThreads().threads.length, store.loadThreads().locked.length], [0, 1]);
  assert.ok(store.warnings().some((w) => /1 remembered conversation\(s\) are encrypted with a key this desk cannot read/.test(w)));
  store.saveThreads([{ app: "gmail", subject: "quote", answers: [{ name: "name", value: "Sam", at: 2 }], pronouns: null, createdAt: 2, updatedAt: 2 }]);
  assert.equal(store.threadsInfo().locked, 1, "the locked record was carried over");
  store.setCorpusBox(createBox(keyA));
  assert.deepEqual([store.loadThreads().threads.length, store.loadThreads().locked.length], [1, 1], "the first key opens its record again");
  // Corpus empty, one locked conversation: the unreadable key is not replaced.
  const keyStore = createStore(temp());
  const keychain = fakeKeychain();
  const first = loadCorpusKey({ store: keyStore, keychain });
  assert.equal(first.status, "created");
  keyStore.setCorpusBox(createBox(first.key));
  keyStore.saveThreads([{ app: "outlook", subject: "order 1", answers: [{ name: "a", value: "1", at: 1 }], pronouns: null, createdAt: 1, updatedAt: 1 }]);
  keyStore.setCorpusBox(null);
  assert.equal(keyStore.corpusInfo().locked, 0, "no learned text at all");
  const broken = loadCorpusKey({ store: keyStore, keychain: fakeKeychain({ decryptString: () => { throw new Error("locked"); } }) });
  assert.equal(broken.status, "unreadable", "the key file stays while a remembered conversation is sealed with it");
  assert.match(broken.message, /1 remembered conversation\(s\)/);
  assert.equal(loadCorpusKey({ store: keyStore, keychain }).status, "ok", "and opens again with the keychain back");
  keyStore.clearThreads();
  assert.deepEqual(keyStore.threadsInfo(), { count: 0, locked: 0, bytes: 0 });
});
