const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const plain = (value) => JSON.parse(JSON.stringify(value));

// Run the browser script against a storage.local double. Sync storage is a
// trap: any use of it fails the test. `rejectSet(payload)` may throw to model
// a failed write (quota, disk), before anything changes, as the browser does.
function padWith(initial = {}, { rejectSet, rejectRemove, locks } = {}) {
  const items = structuredClone(initial);
  const calls = [];
  const syncUses = [];
  const local = {
    async get(key) {
      calls.push({ operation: "get", key });
      if (key === null || key === undefined) return structuredClone(items);
      return key in items ? { [key]: structuredClone(items[key]) } : {};
    },
    async set(payload) {
      calls.push({ operation: "set", keys: Object.keys(payload) });
      if (rejectSet) rejectSet(payload);
      Object.assign(items, structuredClone(payload));
    },
    async remove(keys) {
      calls.push({ operation: "remove", keys: [].concat(keys) });
      if (rejectRemove) rejectRemove(keys);
      for (const key of [].concat(keys)) delete items[key];
    },
  };
  const sync = new Proxy({}, { get(_, name) { syncUses.push(String(name)); throw new Error("sync storage must not be used"); } });
  const context = { chrome: { storage: { local, sync } }, self: {} };
  if (locks) context.navigator = { locks };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("../src/pad-store.js"), "utf8"), context);
  return { pad: context.self.ActlePadStore, items, calls, syncUses };
}

const writes = (calls) => calls.filter((call) => call.operation !== "get");

test("a new draft is one local key holding its own id, text, times and rev 1", async () => {
  const app = padWith();
  const before = Date.now();
  const draft = await app.pad.createDraft({ title: "Hello", body: "Dear Sam" });
  assert.match(draft.id, /^[a-z0-9]+$/);
  assert.deepEqual(Object.keys(app.items), ["pad-draft:" + draft.id]);
  const stored = app.items["pad-draft:" + draft.id];
  assert.deepEqual(Object.keys(stored).sort(), ["body", "createdAt", "id", "rev", "title", "updatedAt"]);
  assert.equal(stored.title, "Hello");
  assert.equal(stored.body, "Dear Sam");
  assert.equal(stored.rev, 1);
  assert.ok(stored.createdAt >= before && stored.updatedAt === stored.createdAt);
  assert.deepEqual(plain(await app.pad.getDraft(draft.id)), plain(draft));
  assert.equal(await app.pad.getDraft("missing"), null);
  assert.deepEqual(app.syncUses, []);
});

test("drafts are listed newest edit first, with word counts", async () => {
  const app = padWith({
    "pad-draft:old": { id: "old", title: "Old", body: "one two", createdAt: 1, updatedAt: 10, rev: 1 },
    "pad-draft:new": { id: "new", title: "New", body: "It's three words", createdAt: 2, updatedAt: 30, rev: 4 },
    "pad-draft:mid": { id: "mid", title: "", body: "", createdAt: 3, updatedAt: 20, rev: 2 },
    "sh:abc": { trigger: "cool/", expansion: "Not a draft" },
    settings: { enabled: true },
  });
  const drafts = await app.pad.listDrafts();
  assert.deepEqual(plain(drafts.map((draft) => draft.id)), ["new", "mid", "old"]);
  assert.deepEqual(plain(drafts.map((draft) => draft.words)), [3, 0, 2]);
  assert.equal(drafts[0].body, "It's three words");
});

test("malformed stored values are skipped or repaired on read", async () => {
  const app = padWith({
    "pad-draft:ok": { title: 7, body: "Kept", createdAt: "yesterday", updatedAt: Infinity, rev: -2 },
    "pad-draft:nobody": { title: "No body", rev: 1 },
    "pad-draft:array": ["body"],
    "pad-draft:null": null,
    "pad-draft:": { body: "no id" },
    "pad-trash": [null, { id: "t", body: 5 }, { id: "t2", title: "T2", body: "Deleted", deletedAt: "soon" }, { id: "t2", body: "duplicate" }, "text"],
    "pad-prefs": { suggestions: "no", lastDraftId: 42 },
    "pad-dismissed": ["As  You Can See", 3, "", "as you can see", null, "Kind regards"],
  });
  assert.deepEqual(plain(await app.pad.listDrafts()), [
    { id: "ok", title: "", body: "Kept", createdAt: null, updatedAt: null, rev: 0, words: 1 },
  ]);
  assert.equal(await app.pad.getDraft("nobody"), null);
  assert.deepEqual(plain(await app.pad.getTrash()), [
    { id: "t2", title: "T2", body: "Deleted", createdAt: null, updatedAt: null, rev: 0, deletedAt: null },
  ]);
  assert.deepEqual(plain(await app.pad.getPrefs()), { suggestions: true, lastDraftId: null });
  assert.deepEqual(plain(await app.pad.getDismissed()), ["as you can see", "kind regards"]);
  app.items["pad-prefs"] = "corrupt";
  app.items["pad-dismissed"] = { phrase: "x" };
  app.items["pad-trash"] = { id: "x", body: "not a list" };
  assert.deepEqual(plain(await app.pad.getPrefs()), { suggestions: true, lastDraftId: null });
  assert.deepEqual(plain(await app.pad.getDismissed()), []);
  assert.deepEqual(plain(await app.pad.getTrash()), []);
});

test("a save writes only that draft and moves its rev on", async () => {
  const app = padWith({
    "pad-draft:a": { id: "a", title: "A", body: "first", createdAt: 1, updatedAt: 1, rev: 3 },
    "pad-draft:b": { id: "b", title: "B", body: "other", createdAt: 1, updatedAt: 1, rev: 1 },
  });
  const result = await app.pad.saveDraft("a", { title: "A2", body: "second" }, 3);
  assert.equal(result.ok, true);
  assert.equal(result.draft.rev, 4);
  assert.equal(result.draft.body, "second");
  assert.ok(result.draft.updatedAt > 1);
  assert.deepEqual(plain(writes(app.calls)), [{ operation: "set", keys: ["pad-draft:a"] }]);
  assert.equal(app.items["pad-draft:a"].body, "second");
  assert.equal(app.items["pad-draft:b"].body, "other");
});

test("a save over a version this tab did not see is refused and returns the stored one", async () => {
  const stored = { id: "a", title: "A", body: "saved by another tab", createdAt: 1, updatedAt: 5, rev: 4 };
  const app = padWith({ "pad-draft:a": stored });
  const result = await app.pad.saveDraft("a", { title: "A", body: "this tab's text" }, 3);
  assert.deepEqual(plain(result), { ok: false, conflict: true, current: stored });
  assert.deepEqual(app.items["pad-draft:a"], stored, "the other tab's version is not overwritten");
  assert.deepEqual(writes(app.calls), []);

  const gone = await app.pad.saveDraft("deleted", { title: "", body: "text" }, 1);
  assert.deepEqual(plain(gone), { ok: false, conflict: true, current: null });
  assert.equal(app.items["pad-draft:deleted"], undefined, "a deleted draft is not recreated behind the page's back");
});

test("saving unchanged text writes nothing", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "A", body: "same", createdAt: 1, updatedAt: 1, rev: 2 } });
  const result = await app.pad.saveDraft("a", { title: "A", body: "same" }, 2);
  assert.equal(result.ok, true);
  assert.equal(result.draft.rev, 2);
  assert.deepEqual(writes(app.calls), []);
});

test("delete copies the draft to Recently deleted drafts before removing it", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 5 } });
  const result = await app.pad.deleteDraft("a");
  assert.equal(result.deleted, true);
  assert.equal(result.kept, true);
  assert.deepEqual(plain(writes(app.calls)), [
    { operation: "set", keys: ["pad-trash"] },
    { operation: "remove", keys: ["pad-draft:a"] },
  ]);
  assert.equal(app.items["pad-draft:a"], undefined);
  const [entry] = await app.pad.getTrash();
  assert.deepEqual({ ...plain(entry), deletedAt: typeof entry.deletedAt }, {
    id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 5, deletedAt: "number",
  });
  assert.deepEqual(plain(await app.pad.deleteDraft("a")), { deleted: false });
});

test("a draft whose copy cannot be kept is not deleted", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 1 } }, {
    rejectSet(payload) { if ("pad-trash" in payload) throw new Error("QUOTA_BYTES quota exceeded"); },
  });
  await assert.rejects(app.pad.deleteDraft("a"), (error) => error.code === "NOT_KEPT" && /QUOTA_BYTES quota exceeded/.test(error.message) && /not deleted/.test(error.message));
  assert.equal(app.items["pad-draft:a"].body, "Dear Sam");
  assert.equal(app.calls.some((call) => call.operation === "remove"), false);
});

test("once the person agrees, a draft whose copy cannot be kept is deleted without one", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 1 } }, {
    rejectSet(payload) { if ("pad-trash" in payload) throw new Error("QUOTA_BYTES quota exceeded"); },
  });
  await assert.rejects(app.pad.deleteDraft("a"), (error) => error.code === "NOT_KEPT" && error.reason === "QUOTA_BYTES quota exceeded");
  app.calls.length = 0;
  assert.deepEqual(plain(await app.pad.deleteDraft("a", { withoutCopy: true })), { deleted: true, kept: false });
  assert.equal(app.items["pad-draft:a"], undefined);
  assert.equal(app.items["pad-trash"], undefined);
  assert.deepEqual(plain(writes(app.calls)), [{ operation: "remove", keys: ["pad-draft:a"] }]);
  assert.deepEqual(plain(await app.pad.deleteDraft("a", { withoutCopy: true })), { deleted: false });
});

test("a failed removal takes the copy back out of Recently deleted drafts", async () => {
  const earlier = { id: "z", title: "Z", body: "older", createdAt: 1, updatedAt: 1, rev: 1, deletedAt: 1 };
  const app = padWith({ "pad-draft:a": { id: "a", title: "A", body: "text", createdAt: 1, updatedAt: 1, rev: 1 }, "pad-trash": [earlier] }, {
    rejectRemove() { throw new Error("disk error"); },
  });
  await assert.rejects(app.pad.deleteDraft("a"), /disk error/);
  assert.equal(app.items["pad-draft:a"].body, "text");
  assert.deepEqual(plain(app.items["pad-trash"]), [earlier]);
});

test("Recently deleted drafts keeps the 20 newest", async () => {
  const app = padWith();
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push((await app.pad.createDraft({ title: "Draft " + i, body: "body " + i })).id);
  for (const id of ids) await app.pad.deleteDraft(id);
  const trash = await app.pad.getTrash();
  assert.equal(app.pad.TRASH_LIMIT, 20);
  assert.equal(trash.length, 20);
  assert.deepEqual(plain(trash.map((entry) => entry.title)), Array.from({ length: 20 }, (_, i) => "Draft " + (24 - i)));
  assert.deepEqual((await app.pad.listDrafts()).length, 0);
});

test("restore puts a draft back under its id with a newer rev", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 5 } });
  await app.pad.deleteDraft("a");
  const result = await app.pad.restoreDraft("a");
  assert.equal(result.restored, true);
  assert.equal(result.draft.id, "a");
  assert.equal(result.draft.rev, 6, "a tab still holding rev 5 cannot save over it unseen");
  assert.deepEqual(plain(app.items["pad-draft:a"]), { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 6 });
  assert.deepEqual(plain(await app.pad.getTrash()), []);
  assert.deepEqual(plain(await app.pad.restoreDraft("a")), { restored: false, message: "That draft is no longer in Recently deleted drafts." });
});

test("restore never overwrites a draft that now holds other text under the same id", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 5 } });
  await app.pad.deleteDraft("a");
  const other = { id: "a", title: "Other", body: "Written since", createdAt: 9, updatedAt: 9, rev: 1 };
  app.items["pad-draft:a"] = structuredClone(other);
  const result = await app.pad.restoreDraft("a");
  assert.equal(result.restored, true);
  assert.notEqual(result.draft.id, "a");
  assert.deepEqual(app.items["pad-draft:a"], other);
  assert.equal(app.items["pad-draft:" + result.draft.id].body, "Dear Sam");
  assert.equal(app.items["pad-draft:" + result.draft.id].id, result.draft.id);
  assert.deepEqual(plain(await app.pad.getTrash()), []);
});

test("restoring a draft that is already back only drops the copy", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 5 } });
  await app.pad.deleteDraft("a");
  app.items["pad-draft:a"] = { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 7 };
  const result = await app.pad.restoreDraft("a");
  assert.equal(result.alreadyThere, true);
  assert.equal(app.items["pad-draft:a"].rev, 7);
  assert.deepEqual(plain(await app.pad.getTrash()), []);
  assert.deepEqual(plain(Object.keys(app.items).filter((key) => key.startsWith("pad-draft:"))), ["pad-draft:a"]);
});

test("deleting the same id twice with other text keeps both copies", async () => {
  const app = padWith({ "pad-draft:a": { id: "a", title: "First", body: "one", createdAt: 1, updatedAt: 1, rev: 1 } });
  await app.pad.deleteDraft("a");
  app.items["pad-draft:a"] = { id: "a", title: "Second", body: "two", createdAt: 2, updatedAt: 2, rev: 1 };
  await app.pad.deleteDraft("a");
  const trash = await app.pad.getTrash();
  assert.deepEqual(plain(trash.map((entry) => entry.body)), ["two", "one"]);
  assert.equal(trash[0].id, "a");
  assert.notEqual(trash[1].id, "a");
});

test("forget removes one copy and empty removes them all", async () => {
  const app = padWith();
  for (const title of ["A", "B", "C"]) await app.pad.deleteDraft((await app.pad.createDraft({ title, body: title })).id);
  const [c, b] = await app.pad.getTrash();
  assert.equal(await app.pad.forgetDraft(b.id), true);
  assert.equal(await app.pad.forgetDraft("missing"), false);
  assert.deepEqual(plain((await app.pad.getTrash()).map((entry) => entry.title)), ["C", "A"]);
  assert.equal(c.title, "C");
  await app.pad.emptyTrash();
  assert.equal(app.items["pad-trash"], undefined);
});

test("a closing tab's rescue is one write, with no read and no lock", async () => {
  const names = [];
  const locks = { request(name, callback) { names.push(name); return Promise.resolve(callback({ name })); } };
  const app = padWith({}, { locks });
  await app.pad.writeRescue("tab1", { draftId: "a", baseRev: 3, title: "T", body: "Last words" });
  assert.deepEqual(plain(app.calls), [{ operation: "set", keys: ["pad-rescue:tab1"] }]);
  assert.deepEqual(names, []);
  assert.deepEqual({ ...plain(app.items["pad-rescue:tab1"]), at: typeof app.items["pad-rescue:tab1"].at },
    { draftId: "a", baseRev: 3, title: "T", body: "Last words", saving: null, at: "number" });
  assert.deepEqual(plain(await app.pad.rescuedTabs()), ["tab1"]);
  assert.ok(app.pad.isPadKey("pad-rescue:tab1"));

  const failing = padWith({}, { rejectSet() { throw new Error("QUOTA_BYTES quota exceeded"); } });
  await failing.pad.writeRescue("tab2", { body: "x" }); // resolves: nobody is left to tell
});

test("rescued text goes over its draft when no other save came after", async () => {
  const app = padWith({
    "pad-draft:a": { id: "a", title: "Letter", body: "Dear Sam", createdAt: 1, updatedAt: 2, rev: 3 },
    "pad-rescue:t": { draftId: "a", baseRev: 3, title: "Letter", body: "Dear Sam, the venue", at: 5 },
  });
  const result = await app.pad.recoverRescue("t");
  assert.equal(result.inPlace, true);
  assert.equal(app.items["pad-draft:a"].body, "Dear Sam, the venue");
  assert.equal(app.items["pad-draft:a"].rev, 4);
  assert.equal(app.items["pad-rescue:t"], undefined);
  assert.equal(Object.keys(app.items).filter((key) => key.startsWith("pad-draft:")).length, 1);
});

test("rescued text never overwrites a newer save or a deleted draft's place", async () => {
  const app = padWith({
    "pad-draft:a": { id: "a", title: "Letter", body: "Their newer text", createdAt: 1, updatedAt: 9, rev: 5 },
    "pad-rescue:t": { draftId: "a", baseRev: 3, title: "Letter", body: "My unsaved text", at: 5 },
    "pad-rescue:u": { draftId: "gone", baseRev: 1, title: "", body: "From a deleted draft", at: 5 },
  });
  const copyTitle = (text) => (text.title || text.body.slice(0, 9)) + " (recovered)";
  const first = await app.pad.recoverRescue("t", copyTitle);
  assert.equal(first.inPlace, false);
  assert.equal(app.items["pad-draft:a"].body, "Their newer text", "the other version stays as it was");
  assert.deepEqual([first.draft.title, app.items["pad-draft:" + first.draft.id].body], ["Letter (recovered)", "My unsaved text"]);
  const second = await app.pad.recoverRescue("u", copyTitle);
  assert.deepEqual([second.draft.title, second.draft.body, second.inPlace], ["From a de (recovered)", "From a deleted draft", false]);
  assert.deepEqual(Object.keys(app.items).filter((key) => key.startsWith("pad-rescue:")), []);
});

test("rescued text that was saved after all, or is empty, is only removed", async () => {
  const app = padWith({
    "pad-draft:a": { id: "a", title: "Letter", body: "Same", createdAt: 1, updatedAt: 2, rev: 4 },
    "pad-rescue:t": { draftId: "a", baseRev: 3, title: "Letter", body: "Same", at: 5 },
    "pad-rescue:e": { draftId: "new1", baseRev: 0, title: " ", body: "\n", at: 5 },
    "pad-rescue:bad": "not a rescue",
    "pad-rescue:noid": { draftId: null, baseRev: 0, title: "", body: "x", at: 5 },
  });
  const landed = await app.pad.recoverRescue("t");
  assert.deepEqual([landed.draft.id, landed.draft.rev, landed.inPlace], ["a", 4, true], "the draft that holds the text, unchanged");
  for (const tab of ["e", "bad", "noid"]) assert.equal(await app.pad.recoverRescue(tab), null);
  assert.deepEqual(Object.keys(app.items), ["pad-draft:a"]);
  assert.equal(app.items["pad-draft:a"].rev, 4);
});

test("rescued text goes over a save of its own that landed while the tab closed", async () => {
  const app = padWith({
    // The running save wrote "Dear Sam, the" as rev 4; the editor had more.
    "pad-draft:a": { id: "a", title: "", body: "Dear Sam, the", createdAt: 1, updatedAt: 2, rev: 4 },
    "pad-rescue:t": { draftId: "a", baseRev: 3, title: "", body: "Dear Sam, the venue", saving: { title: "", body: "Dear Sam, the" }, at: 5 },
    // A new draft: its first save landed with less text than the editor had.
    "pad-draft:n": { id: "n", title: "", body: "Brand", createdAt: 1, updatedAt: 2, rev: 1 },
    "pad-rescue:u": { draftId: "n", baseRev: 0, title: "", body: "Brand new", saving: { title: "", body: "Brand" }, at: 5 },
    // Another tab's rev 4 with other text is not this tab's save.
    "pad-draft:b": { id: "b", title: "B", body: "Theirs", createdAt: 1, updatedAt: 2, rev: 4 },
    "pad-rescue:v": { draftId: "b", baseRev: 3, title: "B", body: "Mine", saving: { title: "B", body: "Mi" }, at: 5 },
  });
  const copyTitle = (text) => text.title + " (recovered)";
  assert.equal((await app.pad.recoverRescue("t", copyTitle)).inPlace, true);
  assert.deepEqual([app.items["pad-draft:a"].body, app.items["pad-draft:a"].rev], ["Dear Sam, the venue", 5]);
  assert.equal((await app.pad.recoverRescue("u", copyTitle)).inPlace, true);
  assert.deepEqual([app.items["pad-draft:n"].body, app.items["pad-draft:n"].rev], ["Brand new", 2]);
  const other = await app.pad.recoverRescue("v", copyTitle);
  assert.deepEqual([other.inPlace, other.draft.title, other.draft.body], [false, "B (recovered)", "Mine"]);
  assert.equal(app.items["pad-draft:b"].body, "Theirs");
  assert.equal(Object.keys(app.items).filter((key) => key.startsWith("pad-draft:")).length, 4, "one copy, no duplicates");
});

test("a new draft's rescued text becomes that draft, and a failed write keeps the rescue", async () => {
  let fail = true;
  const app = padWith({ "pad-rescue:t": { draftId: "fresh1", baseRev: 0, title: "Note", body: "Never saved", at: 5 } }, {
    rejectSet(payload) { if (fail && Object.keys(payload).some((key) => key.startsWith("pad-draft:"))) throw new Error("QUOTA_BYTES quota exceeded"); },
  });
  await assert.rejects(app.pad.recoverRescue("t"), /QUOTA_BYTES/);
  assert.equal(app.items["pad-rescue:t"].body, "Never saved", "kept for the next try");
  fail = false;
  const result = await app.pad.recoverRescue("t", () => "unused");
  assert.deepEqual([result.draft.id, result.draft.title, result.draft.body, result.draft.rev, result.inPlace], ["fresh1", "Note", "Never saved", 1, true]);
  assert.equal(app.items["pad-rescue:t"], undefined);
  await app.pad.writeRescue("t", { draftId: "x", baseRev: 0, body: "again" });
  await app.pad.clearRescue("t");
  assert.equal(app.items["pad-rescue:t"], undefined);
});

test("a new draft can be given its id before it is first saved", async () => {
  const app = padWith();
  const id = app.pad.newDraftId();
  assert.match(id, /^[a-z0-9]+$/);
  const draft = await app.pad.createDraft({ title: "", body: "x", id });
  assert.equal(draft.id, id);
  assert.equal(app.items["pad-draft:" + id].body, "x");
});

test("preferences default to suggestions on, merge patches and ignore bad values", async () => {
  const app = padWith();
  assert.deepEqual(plain(await app.pad.getPrefs()), { suggestions: true, lastDraftId: null });
  assert.deepEqual(writes(app.calls), [], "reading the defaults writes nothing");
  assert.deepEqual(plain(await app.pad.savePrefs({ suggestions: false })), { suggestions: false, lastDraftId: null });
  assert.deepEqual(plain(await app.pad.savePrefs({ lastDraftId: "abc" })), { suggestions: false, lastDraftId: "abc" });
  assert.deepEqual(plain(await app.pad.savePrefs({ suggestions: "yes", lastDraftId: 3, extra: 1 })), { suggestions: false, lastDraftId: "abc" });
  assert.deepEqual(plain(app.items["pad-prefs"]), { suggestions: false, lastDraftId: "abc" });
});

test("dismissed phrases are normalized, newest first, and capped at 200", async () => {
  const app = padWith();
  assert.deepEqual(plain(await app.pad.dismissPhrase("  As   you\ncan SEE ")), ["as you can see"]);
  assert.deepEqual(plain(await app.pad.dismissPhrase("Kind regards")), ["kind regards", "as you can see"]);
  assert.deepEqual(plain(await app.pad.dismissPhrase("as you can see")), ["as you can see", "kind regards"], "a repeat moves to the front once");
  assert.deepEqual(plain(await app.pad.dismissPhrase("   ")), ["as you can see", "kind regards"]);
  for (let i = 0; i < 205; i++) await app.pad.dismissPhrase("phrase " + i);
  const dismissed = await app.pad.getDismissed();
  assert.equal(app.pad.DISMISSED_LIMIT, 200);
  assert.equal(dismissed.length, 200);
  assert.equal(dismissed[0], "phrase 204");
  assert.equal(dismissed[199], "phrase 5");
  assert.equal(dismissed.includes("as you can see"), false, "the oldest drop off");
  await app.pad.clearDismissed();
  assert.equal(app.items["pad-dismissed"], undefined);
  assert.deepEqual(plain(await app.pad.getDismissed()), []);
});

test("every pad key is local and starts with pad-, and sync is never touched", async () => {
  const app = padWith();
  const draft = await app.pad.createDraft({ title: "T", body: "B" });
  await app.pad.saveDraft(draft.id, { title: "T", body: "B2" }, 1);
  await app.pad.listDrafts();
  await app.pad.savePrefs({ suggestions: false, lastDraftId: draft.id });
  await app.pad.dismissPhrase("as you can see");
  await app.pad.deleteDraft(draft.id);
  await app.pad.restoreDraft(draft.id);
  await app.pad.deleteDraft(draft.id);
  await app.pad.forgetDraft(draft.id);
  await app.pad.emptyTrash();
  assert.deepEqual(app.syncUses, []);
  for (const call of writes(app.calls)) for (const key of call.keys) assert.ok(app.pad.isPadKey(key), key);
  assert.ok(Object.keys(app.items).every(app.pad.isPadKey));
});

test("writes take the pad's Web Lock, and still save when the lock manager refuses", async () => {
  const names = [];
  const granting = { request(name, callback) { names.push(name); return Promise.resolve(callback({ name })); } };
  const app = padWith({}, { locks: granting });
  const draft = await app.pad.createDraft({ title: "", body: "x" });
  await app.pad.saveDraft(draft.id, { title: "", body: "y" }, 1);
  assert.deepEqual(names, ["actle-pad-write", "actle-pad-write"]);

  const refusing = { request() { return Promise.reject(new DOMException("denied", "SecurityError")); } };
  const refused = padWith({}, { locks: refusing });
  const saved = await refused.pad.createDraft({ title: "", body: "kept" });
  assert.equal(refused.items["pad-draft:" + saved.id].body, "kept");

  // A write that fails inside the lock is reported once, not retried behind the page's back.
  let sets = 0;
  const failing = padWith({}, { locks: granting, rejectSet() { sets++; throw new Error("QUOTA_BYTES quota exceeded"); } });
  await assert.rejects(failing.pad.createDraft({ title: "", body: "x" }), /QUOTA_BYTES/);
  assert.equal(sets, 1);
});

test("one failed write does not block the next", async () => {
  let fail = true;
  const app = padWith({}, { rejectSet() { if (fail) throw new Error("busy"); } });
  await assert.rejects(app.pad.createDraft({ title: "", body: "first" }), /busy/);
  fail = false;
  const draft = await app.pad.createDraft({ title: "", body: "second" });
  assert.equal(app.items["pad-draft:" + draft.id].body, "second");
});

test("word counts and download names", () => {
  const { pad } = padWith();
  assert.equal(pad.countWords(""), 0);
  assert.equal(pad.countWords("  Hi Sam,\n\nas you can see — it's 3:30 pm. "), 10);
  assert.equal(pad.countWords("Grüße aus Köln, ünd 東京"), 5);
  assert.equal(pad.fileNameFor("Quarterly report: Q3/Q4 *draft*"), "Quarterly report Q3 Q4 draft.txt");
  assert.equal(pad.fileNameFor("  ...  "), "Untitled draft.txt");
  assert.equal(pad.fileNameFor(""), "Untitled draft.txt");
  assert.equal(pad.fileNameFor("a\u0000b\tc"), "a b c.txt");
  assert.equal(pad.fileNameFor("x".repeat(120)), "x".repeat(80) + ".txt");
  assert.equal(pad.normalizePhrase("  As\tYou  Can See "), "as you can see");
});
