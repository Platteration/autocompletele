const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Exercise the browser script with a storage double that rejects writes before
// mutation, as sync storage does for quota failures. Browser tests cover the
// actual API's per-item quota separately. The import journal and backup live in
// storage.local, which on Firefox is the library's own area.
function storageWith(initial, { rejectSet, rejectRemove, rejectLocalSet, afterGet, firefox = false, limits = {} } = {}) {
  const items = structuredClone(initial);
  const local = {};
  const calls = [];
  const localCalls = [];
  function area(data, library) {
    return {
      ...(library ? limits : {}),
      // afterGet may hold a read that has already been taken, as a slow
      // storage call would while another writer runs.
      async get(key) {
        const result = structuredClone(key ? { [key]: data[key] } : data);
        if (afterGet) await afterGet(key);
        return result;
      },
      async set(payload) {
        (library ? calls : localCalls).push({ operation: "set", payload: structuredClone(payload) });
        if (library && rejectSet) rejectSet(payload, data);
        if (!library && rejectLocalSet) rejectLocalSet(payload, data);
        Object.assign(data, structuredClone(payload));
      },
      async remove(keys) {
        (library ? calls : localCalls).push({ operation: "remove", keys });
        if (library && rejectRemove) rejectRemove();
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      },
    };
  }
  const dataStore = area(items, true);
  const chrome = {
    runtime: { getManifest: () => firefox ? { browser_specific_settings: { gecko: { id: "test@example.test" } } } : {} },
    // Firefox has no sync API here: every read, write and delete must use local storage.
    storage: firefox ? { local: dataStore } : { sync: dataStore, local: area(local, false) },
  };
  const context = vm.createContext({ chrome, self: {}, TextEncoder });
  vm.runInContext(fs.readFileSync(require.resolve("../src/storage.js"), "utf8"), context);
  return { storage: context.self.ShorthandStorage, items, local, calls, localCalls };
}

const initial = {
  "sh:local": { trigger: "local/", expansion: "Keep me", order: 0 },
  "sh:sig": { trigger: "sig/", expansion: "Original signature", order: 1 },
  settings: { enabled: false },
  unrelated: "preserve this too",
};
const library = { "sh:local": initial["sh:local"], "sh:sig": initial["sh:sig"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

test("Firefox uses local storage for its library and settings", async () => {
  const app = storageWith(initial, { firefox: true });
  assert.equal(app.storage.AREA, "local");
  assert.equal((await app.storage.getAll()).shorthands.length, 2);
  const id = await app.storage.saveShorthand({ trigger: "added/", expansion: "Added" });
  assert.equal(app.items["sh:" + id].expansion, "Added");
  await app.storage.deleteShorthand(id);
  assert.equal(app.items["sh:" + id], undefined);
  await app.storage.saveSettings({ enabled: true });
  assert.equal(app.items.settings.enabled, true);
  await app.storage.replaceAll([{ trigger: "replaced/", expansion: "Replacement" }]);
  assert.deepEqual(plain((await app.storage.getAll()).shorthands).map((item) => item.trigger), ["replaced/"]);
  assert.deepEqual(app.items["shorthand-import-backup"], library, "the pre-import backup also lives in local storage");
});

test("Chrome keeps using sync storage", async () => {
  const app = storageWith(initial);
  assert.equal(app.storage.AREA, "sync");
  assert.equal((await app.storage.getAll()).shorthands.length, 2);
});

test("use counts live in local storage only and accumulate by id", async () => {
  const app = storageWith(initial);
  await app.storage.recordUse("sig");
  await app.storage.recordUse("sig");
  await app.storage.recordUse("local");
  await app.storage.recordUse("");
  assert.deepEqual(plain(await app.storage.getUsageCounts()), { sig: 2, local: 1 });
  assert.equal(app.items["shorthand-usage-counts"], undefined, "counts must never reach synced library storage");
  assert.deepEqual(plain(app.local["shorthand-usage-counts"]), { sig: 2, local: 1 });
  assert.equal(JSON.stringify(app.storage.toExportJson((await app.storage.getAll()).shorthands)).includes("usage"), false);
});

test("stored use counts are sanitized on read", async () => {
  const app = storageWith(initial);
  app.local["shorthand-usage-counts"] = { a: 2.9, b: -1, c: "many", d: 0, e: Infinity };
  assert.deepEqual(plain(await app.storage.getUsageCounts()), { a: 2 });
  app.local["shorthand-usage-counts"] = ["not", "a", "map"];
  assert.deepEqual(plain(await app.storage.getUsageCounts()), {});
});

test("a pending selection draft is local-only and consumed exactly once", async () => {
  const app = storageWith(initial);
  assert.equal(await app.storage.savePendingDraft(""), false);
  assert.equal(await app.storage.takePendingDraft(), "");
  assert.equal(await app.storage.savePendingDraft("Selected on a page"), true);
  assert.equal(app.items["shorthand-pending-draft"], undefined, "drafts must never reach synced library storage");
  assert.equal(await app.storage.takePendingDraft(), "Selected on a page");
  assert.equal(await app.storage.takePendingDraft(), "");
  assert.equal(app.local["shorthand-pending-draft"], undefined);
});

test("a rejected library write leaves the entire saved library intact", async () => {
  const app = storageWith(initial, {
    rejectSet() { throw new Error("MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded"); },
  });
  await assert.rejects(app.storage.replaceAll([
    { trigger: "sig/", expansion: "Updated signature" },
    { trigger: "new/", expansion: "New entry" },
  ]), /quota exceeded/);
  assert.deepEqual(app.items, initial);
  assert.equal(app.calls.some((call) => call.operation === "remove"), false);
  assert.deepEqual(app.local["shorthand-import-backup"], library);
  assert.equal(app.local["shorthand-import-journal"], undefined, "a clean rollback leaves nothing to recover");
});

test("an oversized item is skipped without blocking good imports or erasing prior entries", async () => {
  const app = storageWith(initial);
  const result = await app.storage.replaceAll([
    { trigger: "sig/", expansion: "x".repeat(9000) },
    { trigger: "new/", expansion: "New entry" },
  ]);
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
  assert.equal(Object.values(app.items).some((item) => item.trigger === "new/"), true);
  assert.deepEqual(plain(result.skipped), [{ trigger: "sig/", reason: "sync per-item limit" }]);
  assert.equal(result.preservedExisting, true);
  assert.equal(app.calls.some((call) => call.operation === "remove"), false);
});

test("replacement reuses matching keys so updating a full library needs no extra slots", async () => {
  const app = storageWith(initial, {
    rejectSet(payload, items) {
      if (Object.keys({ ...items, ...payload }).filter((key) => key.startsWith("sh:")).length > 2) {
        throw new Error("MAX_ITEMS quota exceeded");
      }
    },
  });
  const result = await app.storage.replaceAll([
    { trigger: "local/", expansion: "Keep me" },
    { trigger: "sig/", expansion: "Updated signature" },
  ]);
  assert.deepEqual(app.items, {
    ...initial,
    "sh:sig": { trigger: "sig/", expansion: "Updated signature", order: 1 },
  });
  assert.deepEqual(plain(result.skipped), []);
});

test("successful replacement writes before removing old entries and retains settings", async () => {
  const app = storageWith(initial);
  const result = await app.storage.replaceAll([{ trigger: "new/", expansion: "New entry" }]);
  assert.deepEqual(plain(result.skipped), []);
  assert.equal(result.preservedExisting, false);
  assert.deepEqual(app.calls.map((call) => call.operation), ["set", "remove"]);
  const { shorthands } = await app.storage.getAll();
  assert.deepEqual(plain(shorthands).map(({ trigger, expansion }) => ({ trigger, expansion })), [
    { trigger: "new/", expansion: "New entry" },
  ]);
  assert.deepEqual(app.items.settings, initial.settings);
  assert.equal(app.items.unrelated, initial.unrelated);
});

test("merge retains local-only snippets and matching keys", async () => {
  const app = storageWith(initial);
  const result = await app.storage.replaceAll([
    { trigger: "sig/", expansion: "Updated signature" },
    { trigger: "new/", expansion: "New entry" },
  ], { merge: true });
  assert.deepEqual(plain(result.skipped), []);
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.equal(app.items["sh:sig"].expansion, "Updated signature");
  assert.equal(app.items["sh:sig"].order, 1, "an updated entry keeps its position");
  assert.equal((await app.storage.getAll()).shorthands.length, 3);
  assert.equal(app.calls.some((call) => call.operation === "remove"), false);
});

test("a failed cleanup keeps old entries and a recovery journal for the next open", async () => {
  const app = storageWith(initial, {
    rejectRemove() { throw new Error("Storage unavailable during cleanup"); },
  });
  await assert.rejects(app.storage.replaceAll([{ trigger: "new/", expansion: "New entry" }]), /Import interrupted/);
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
  assert.equal(Object.values(app.items).some((item) => item.trigger === "new/"), true);
  assert.equal(app.local["shorthand-import-journal"].committed, false, "recovery resumes when options next opens");
  assert.deepEqual(app.local["shorthand-import-backup"], library);
});

test("total quota pressure preserves the old library and reports additions that do not fit", async () => {
  // Four slots hold the settings, the unrelated record and both existing entries.
  const app = storageWith(initial, { limits: { MAX_ITEMS: 4 } });
  const result = await app.storage.replaceAll([
    { trigger: "new/", expansion: "No room until old entries are removed" },
    { trigger: "sig/", expansion: "Update fits in existing slot" },
  ], { merge: true });
  assert.deepEqual(plain(result.skipped), [{ trigger: "new/", reason: "sync item-count limit" }]);
  assert.equal(result.preservedExisting, true);
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.equal(app.items["sh:sig"].expansion, "Update fits in existing slot");
  assert.equal(app.calls.some((call) => call.operation === "remove"), false);
});

test("new and existing libraries default to Expand without rewriting saved data", async () => {
  for (const existing of [{}, initial]) {
    const app = storageWith(existing);
    assert.equal((await app.storage.getAll()).settings.animationMode, "expand");
    assert.equal(app.storage.DEFAULT_SETTINGS.animationMode, "expand");
    assert.deepEqual(app.items, existing);
    assert.deepEqual(app.calls, []);
  }
});

test("unknown saved animation modes normalize on read without changing other settings", async () => {
  for (const animationMode of ["unknown", "Expand", "", null, 3, {}, ["casino"]]) {
    const saved = {
      ...initial,
      settings: { enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", animationMode },
    };
    const app = storageWith(saved);
    assert.deepEqual(plain((await app.storage.getAll()).settings), {
      enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", animationMode: "expand", suggestionsEnabled: true, phraseWords: 3,
    });
    assert.deepEqual(app.items, saved);
    assert.deepEqual(app.calls, []);
  }
});

test("all animation modes round-trip in Chrome and Firefox without changing library or other settings", async () => {
  for (const firefox of [false, true]) {
    const saved = {
      ...initial,
      settings: { enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", retained: "keep" },
    };
    const app = storageWith(saved, { firefox });
    for (const animationMode of ["casino", "off", "expand"]) {
      const next = await app.storage.saveSettings({ animationMode });
      assert.equal(next.animationMode, animationMode);
      assert.equal((await app.storage.getAll()).settings.animationMode, animationMode);
      assert.deepEqual(app.items, { ...saved, settings: { ...saved.settings, animationMode, suggestionsEnabled: true, phraseWords: 3 } });
    }
    await app.storage.saveSettings({ enabled: true });
    assert.deepEqual(app.items.settings, { ...saved.settings, animationMode: "expand", enabled: true, suggestionsEnabled: true, phraseWords: 3 });
  }
});

test("unknown animation writes normalize to Expand while keeping the rest of the patch", async () => {
  const app = storageWith({ ...initial, settings: { enabled: true, animationMode: "casino" } });
  const settings = await app.storage.saveSettings({ animationMode: "unavailable", enabled: false });
  assert.equal(settings.animationMode, "expand");
  assert.equal(settings.enabled, false);
  assert.equal(app.items.settings.animationMode, "expand");
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
});

test("a failed animation preference save reports failure and retains the saved selection and library", async () => {
  const saved = { ...initial, settings: { enabled: false, animationMode: "casino" } };
  const app = storageWith(saved, {
    rejectSet() { throw new Error("Storage write rejected"); },
  });
  await assert.rejects(app.storage.saveSettings({ animationMode: "off" }), /Storage write rejected/);
  assert.deepEqual(app.items, saved);
  assert.equal((await app.storage.getAll()).settings.animationMode, "casino");
});

test("new and existing libraries suggest saved shortcuts by default without rewriting data", async () => {
  for (const existing of [{}, initial]) {
    const app = storageWith(existing);
    assert.equal(app.storage.DEFAULT_SETTINGS.suggestionsEnabled, true);
    assert.equal((await app.storage.getAll()).settings.suggestionsEnabled, true);
    assert.deepEqual(app.items, existing);
    assert.deepEqual(app.calls, []);
  }
});

test("nonboolean suggestion preferences normalize on read without changing saved data", async () => {
  for (const suggestionsEnabled of [null, 0, 1, "true", "false", "", {}, []]) {
    const saved = {
      ...initial,
      settings: { enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", animationMode: "casino", suggestionsEnabled },
    };
    const app = storageWith(saved);
    assert.deepEqual(plain((await app.storage.getAll()).settings), {
      ...saved.settings, suggestionsEnabled: true, phraseWords: 3,
    });
    assert.deepEqual(app.items, saved);
    assert.deepEqual(app.calls, []);
  }
});

test("suggestion choices round-trip in Chrome and Firefox while retaining other preferences and snippets", async () => {
  for (const firefox of [false, true]) {
    const saved = {
      ...initial,
      settings: { enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", animationMode: "casino", retained: "keep" },
    };
    const app = storageWith(saved, { firefox });
    for (const suggestionsEnabled of [false, true, false]) {
      assert.equal((await app.storage.saveSettings({ suggestionsEnabled })).suggestionsEnabled, suggestionsEnabled);
      assert.equal((await app.storage.getAll()).settings.suggestionsEnabled, suggestionsEnabled);
      assert.deepEqual(app.items, { ...saved, settings: { ...saved.settings, suggestionsEnabled, phraseWords: 3 } });
    }
    await Promise.all([
      app.storage.saveSettings({ enabled: true }),
      app.storage.saveSettings({ animationMode: "off" }),
    ]);
    assert.deepEqual(app.items, {
      ...saved, settings: { ...saved.settings, suggestionsEnabled: false, enabled: true, animationMode: "off", phraseWords: 3 },
    });
  }
});

test("nonboolean suggestion writes normalize to enabled while keeping the rest of the patch", async () => {
  for (const suggestionsEnabled of [undefined, null, 0, 1, "false", {}, []]) {
    const app = storageWith({ ...initial, settings: { enabled: true, suggestionsEnabled: false } });
    const settings = await app.storage.saveSettings({ suggestionsEnabled, enabled: false });
    assert.equal(settings.suggestionsEnabled, true);
    assert.equal(settings.enabled, false);
    assert.equal(app.items.settings.suggestionsEnabled, true);
    assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
    assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
  }
});

test("a rejected suggestion save retains the saved preference and whole library", async () => {
  const saved = { ...initial, settings: { enabled: false, suggestionsEnabled: false } };
  const app = storageWith(saved, {
    rejectSet() { throw new Error("Storage write rejected"); },
  });
  await assert.rejects(app.storage.saveSettings({ suggestionsEnabled: true }), /Storage write rejected/);
  assert.deepEqual(app.items, saved);
  assert.equal((await app.storage.getAll()).settings.suggestionsEnabled, false);
});

test("suggestion settings stay out of the cross-platform snippet export", async () => {
  const app = storageWith(initial);
  await app.storage.saveSettings({ suggestionsEnabled: false });
  const { shorthands } = await app.storage.getAll();
  assert.deepEqual(JSON.parse(app.storage.toExportJson(shorthands)), {
    version: 1,
    shorthands: [
      { trigger: "local/", expansion: "Keep me" },
      { trigger: "sig/", expansion: "Original signature" },
    ],
  });
});

test("only library and settings keys count as library changes", () => {
  const firefox = storageWith({}, { firefox: true }).storage;
  for (const key of ["shorthand-usage-counts", "shorthand-pending-draft", "actle-premium"]) {
    assert.equal(firefox.isLibraryChange({ [key]: {} }, "local"), false, key);
  }
  assert.equal(firefox.isLibraryChange({ "shorthand-usage-counts": {}, "sh:a": {} }, "local"), true);
  assert.equal(firefox.isLibraryChange({ settings: {} }, "local"), true);
  const chromeStorage = storageWith({}).storage;
  assert.equal(chromeStorage.isLibraryChange({ "sh:a": {} }, "sync"), true);
  assert.equal(chromeStorage.isLibraryChange({ "shorthand-import-journal": {} }, "local"), false, "Chrome's library is in sync storage");
});

test("paragraph completion defaults to three words, accepts off and two to six, and normalizes anything else", async () => {
  const app = storageWith(initial);
  assert.equal(app.storage.DEFAULT_SETTINGS.phraseWords, 3);
  assert.equal((await app.storage.getAll()).settings.phraseWords, 3);
  assert.deepEqual(app.calls, [], "reading the default writes nothing");
  for (const phraseWords of [0, 2, 3, 4, 5, 6]) {
    assert.equal((await app.storage.saveSettings({ phraseWords })).phraseWords, phraseWords);
    assert.equal((await app.storage.getAll()).settings.phraseWords, phraseWords);
  }
  for (const phraseWords of [1, 7, 2.5, -3, "3", null, true, NaN]) {
    assert.equal((await app.storage.saveSettings({ phraseWords })).phraseWords, 3, String(phraseWords));
  }
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"], "the library is untouched");
});

const EXAMPLES = [
  { trigger: "cool/", expansion: "That is really cool, thanks for sharing!" },
  { trigger: "sig/", expansion: "Best regards,\n{cursor}" },
  { trigger: "td/", expansion: "{date}" },
];

test("first-install examples seed an empty library under fixed ids, in both browsers", async () => {
  for (const firefox of [false, true]) {
    const app = storageWith({}, { firefox });
    assert.equal(await app.storage.seedExamples(EXAMPLES), true);
    assert.deepEqual(Object.keys(app.items).sort(), ["sh:example-cool", "sh:example-sig", "sh:example-td"]);
    assert.deepEqual(plain((await app.storage.getAll()).shorthands.map((sh) => sh.trigger)), ["cool/", "sig/", "td/"]);
    assert.ok(app.calls.every((call) => call.operation === "set"), "seeding never removes");
    assert.equal(await app.storage.seedExamples(EXAMPLES), false, "a second device's seed finds the same records and adds nothing");
  }
});

test("a library that is already there when the examples would be written is never replaced", async () => {
  // Chrome sync can deliver a library between install and seeding; the old
  // replace-mode seed removed every record it did not list.
  for (const firefox of [false, true]) {
    const synced = { "sh:mine": { trigger: "addr/", expansion: "1 Main Street", order: 0 } };
    const app = storageWith(synced, { firefox });
    assert.equal(await app.storage.seedExamples(EXAMPLES), false);
    assert.deepEqual(app.items, synced);
    assert.deepEqual(app.calls, []);
  }
});

// Recently deleted lives in storage.local in both browsers. On Firefox that is
// also the library's area, so the helper's `items` holds it there.
const TRASH = "shorthand-trash";
const trashArea = (app, firefox) => (firefox ? app.items : app.local);
const withoutTime = (entries) => plain(entries).map(({ deletedAt, ...rest }) => rest);

test("deleting keeps a copy in Recently deleted before the record is removed, in both browsers", async () => {
  for (const firefox of [false, true]) {
    let app;
    let trashWhenRemoved = "not removed";
    app = storageWith(initial, { firefox, rejectRemove() { trashWhenRemoved = structuredClone(trashArea(app, firefox)[TRASH]); } });
    const before = Date.now();
    assert.deepEqual(plain(await app.storage.deleteShorthand("sig")), { deleted: true, kept: true, trigger: "sig/" });
    const stored = trashArea(app, firefox)[TRASH];
    assert.deepEqual(withoutTime(stored), [{ id: "sig", trigger: "sig/", expansion: "Original signature", order: 1 }]);
    assert.ok(stored[0].deletedAt >= before && stored[0].deletedAt <= Date.now(), "the time of deletion is recorded");
    assert.deepEqual(trashWhenRemoved, stored, "the copy was already written when the record was removed");
    assert.equal(app.items["sh:sig"], undefined);
    assert.deepEqual(plain((await app.storage.getAll()).shorthands).map((sh) => sh.trigger), ["local/"], "the copy is not part of the library");
    assert.equal(app.storage.toExportJson((await app.storage.getAll()).shorthands).includes("Original signature"), false, "nor of its export");
    if (!firefox) assert.equal(app.items[TRASH], undefined, "Chrome never puts the copy in sync storage");
  }
});

test("Recently deleted keeps the 50 newest, newest first", async () => {
  const older = Array.from({ length: 50 }, (_, i) => ({ id: "old" + i, trigger: "old" + i + "/", expansion: "x", order: i, deletedAt: 1000 - i }));
  const app = storageWith(initial);
  app.local[TRASH] = older;
  assert.equal(app.storage.TRASH_LIMIT, 50);
  await app.storage.deleteShorthand("sig");
  const trash = await app.storage.getTrash();
  assert.equal(trash.length, 50);
  assert.equal(trash[0].id, "sig");
  assert.deepEqual(plain(trash.slice(1).map((entry) => entry.id)), older.slice(0, 49).map((entry) => entry.id), "only the oldest is dropped");
});

test("deleting the same id again replaces an identical older copy instead of listing it twice", async () => {
  const app = storageWith(initial);
  app.local[TRASH] = [{ id: "sig", trigger: "sig/", expansion: "Original signature", order: 1, deletedAt: 5 }];
  await app.storage.deleteShorthand("sig");
  // The stored list itself, not only getTrash(), which also skips repeated ids.
  assert.deepEqual(withoutTime(app.local[TRASH]), [{ id: "sig", trigger: "sig/", expansion: "Original signature", order: 1 }]);
  assert.notEqual(app.local[TRASH][0].deletedAt, 5, "the newer deletion is the one kept");
});

test("an older copy under the same id with other text is kept under a new id, not replaced", async () => {
  // Seeded examples use fixed ids and sync can bring an id back with other
  // text, so a second copy under one id can hold different words.
  const app = storageWith(initial);
  app.local[TRASH] = [{ id: "sig", trigger: "sig/", expansion: "My own signature", order: 1, deletedAt: 5 }];
  await app.storage.deleteShorthand("sig");
  const stored = app.local[TRASH];
  assert.equal(stored.length, 2);
  assert.deepEqual(withoutTime([stored[0]]), [{ id: "sig", trigger: "sig/", expansion: "Original signature", order: 1 }]);
  const { id, ...older } = stored[1];
  assert.deepEqual(older, { trigger: "sig/", expansion: "My own signature", order: 1, deletedAt: 5 });
  assert.ok(typeof id === "string" && id && id !== "sig", "the older copy has an id of its own");
  assert.deepEqual(plain(await app.storage.restoreDeleted(id)), { restored: true, id, trigger: "sig/" });
  assert.equal(app.items["sh:" + id].expansion, "My own signature");
});

test("when the copy cannot be kept nothing is deleted, unless the person agrees to delete without it", async () => {
  const notKept = (error) => error.code === "NOT_KEPT" && error.trigger === "sig/" && /could not be kept in Recently deleted: QUOTA_BYTES/.test(error.message);
  const chromeApp = storageWith(initial, { rejectLocalSet() { throw new Error("QUOTA_BYTES quota exceeded"); } });
  await assert.rejects(chromeApp.storage.deleteShorthand("sig"), notKept);
  assert.deepEqual(chromeApp.items, initial, "the library is untouched");
  assert.deepEqual(chromeApp.calls, []);
  assert.deepEqual(plain(await chromeApp.storage.deleteShorthand("sig", { withoutCopy: true })), { deleted: true, kept: false, trigger: "sig/" });
  assert.equal(chromeApp.items["sh:sig"], undefined);
  assert.equal(chromeApp.local[TRASH], undefined);

  const firefoxApp = storageWith(initial, { firefox: true, rejectSet(payload) { if (TRASH in payload) throw new Error("QUOTA_BYTES quota exceeded"); } });
  await assert.rejects(firefoxApp.storage.deleteShorthand("sig"), notKept);
  assert.deepEqual(firefoxApp.items["sh:sig"], initial["sh:sig"]);
  assert.equal(firefoxApp.calls.some((call) => call.operation === "remove"), false);
});

test("an unreadable trash also stops the delete rather than replacing it", async () => {
  const app = storageWith(initial);
  let replaced = false;
  Object.defineProperty(app.local, TRASH, {
    get() { throw new Error("local storage unavailable"); }, set() { replaced = true; }, enumerable: true, configurable: true,
  });
  await assert.rejects(app.storage.deleteShorthand("sig"), (error) => error.code === "NOT_KEPT");
  assert.equal(replaced, false, "the copies it could not read are not overwritten");
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
});

test("a delete that fails after the copy was written withdraws the copy", async () => {
  const app = storageWith(initial, { rejectRemove() { throw new Error("sync unavailable"); } });
  await assert.rejects(app.storage.deleteShorthand("sig"), /sync unavailable/);
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
  assert.deepEqual(plain(await app.storage.getTrash()), []);
});

test("deleting a shorthand that is already gone is not an error and keeps nothing", async () => {
  const app = storageWith(initial);
  assert.deepEqual(plain(await app.storage.deleteShorthand("missing")), { deleted: false, kept: false });
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.localCalls.filter((call) => call.operation === "set"), []);
});

test("restore puts the shorthand back under its id and order and drops its copy, in both browsers", async () => {
  for (const firefox of [false, true]) {
    const app = storageWith(initial, { firefox });
    await app.storage.deleteShorthand("sig");
    assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), { restored: true, id: "sig", trigger: "sig/" });
    assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
    assert.deepEqual(plain((await app.storage.getAll()).shorthands).map((sh) => sh.trigger), ["local/", "sig/"]);
    assert.deepEqual(plain(await app.storage.getTrash()), []);
    assert.equal(trashArea(app, firefox)[TRASH], undefined);
  }
});

test("restore is refused while another shorthand uses the trigger, and the entry stays", async () => {
  const app = storageWith(initial);
  await app.storage.deleteShorthand("sig");
  const id = await app.storage.saveShorthand({ trigger: "sig/", expansion: "New signature" });
  assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), {
    restored: false, trigger: "sig/", message: "sig/ is already in your library. Rename or delete that one first.",
  });
  assert.equal(app.items["sh:sig"], undefined);
  assert.equal(app.items["sh:" + id].expansion, "New signature");
  assert.deepEqual(plain((await app.storage.getTrash()).map((entry) => entry.id)), ["sig"]);
});

test("restore is refused when it would exceed the Chrome sync quota, and the entry stays", async () => {
  // Four slots: settings, the unrelated record and two shorthands.
  const app = storageWith(initial, { limits: { MAX_ITEMS: 4 } });
  await app.storage.deleteShorthand("sig");
  await app.storage.saveShorthand({ trigger: "new/", expansion: "Took the free slot" });
  assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), {
    restored: false, trigger: "sig/",
    message: "sig/ would exceed the sync item-count limit, so it stays in Recently deleted. Delete or shorten another shorthand first.",
  });
  assert.equal(app.items["sh:sig"], undefined);
  assert.equal((await app.storage.getTrash()).length, 1);
});

test("copies in Recently deleted do not count toward the sync quota", async () => {
  // 400 bytes fit the four synced records but not a 5,000-character copy.
  const app = storageWith(initial, { limits: { QUOTA_BYTES: 400 } });
  app.local[TRASH] = [{ id: "big", trigger: "big/", expansion: "x".repeat(5000), order: 9, deletedAt: 1 }];
  await app.storage.deleteShorthand("sig");
  assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), { restored: true, id: "sig", trigger: "sig/" });
});

test("restoring an id that is already back in the library with the same text only drops the copy", async () => {
  const app = storageWith(initial);
  await app.storage.deleteShorthand("sig");
  // Synced back from another device, at another place in the list.
  app.items["sh:sig"] = { trigger: "sig/", expansion: "Original signature", order: 7 };
  const writes = app.calls.length;
  assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), { restored: true, alreadyThere: true, id: "sig", trigger: "sig/" });
  assert.deepEqual(app.items["sh:sig"], { trigger: "sig/", expansion: "Original signature", order: 7 }, "the library record is not overwritten");
  assert.equal(app.calls.length, writes, "nothing is written to the library");
  assert.deepEqual(plain(await app.storage.getTrash()), []);
});

test("a copy whose id came back with other text is kept, and restores as a shorthand of its own once its trigger is free", async () => {
  // For example: the person edited the example sig/ and deleted it, then a
  // new device seeded the default example under the same fixed id.
  const app = storageWith(initial);
  await app.storage.deleteShorthand("sig");
  const synced = { trigger: "sig/", expansion: "Synced back from another device", order: 1 };
  app.items["sh:sig"] = synced;
  assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), {
    restored: false, trigger: "sig/", message: "sig/ is already in your library. Rename or delete that one first.",
  });
  assert.deepEqual(withoutTime(await app.storage.getTrash()), [{ id: "sig", trigger: "sig/", expansion: "Original signature", order: 1 }], "the copy stays");
  assert.deepEqual(app.items["sh:sig"], synced);

  app.items["sh:sig"] = { ...synced, trigger: "sig2/" };
  const result = plain(await app.storage.restoreDeleted("sig"));
  assert.ok(result.id && result.id !== "sig", "it does not overwrite the record under its old id");
  assert.deepEqual(result, { restored: true, id: result.id, trigger: "sig/" });
  assert.deepEqual(app.items["sh:" + result.id], initial["sh:sig"]);
  assert.deepEqual(app.items["sh:sig"], { ...synced, trigger: "sig2/" });
  assert.deepEqual(plain(await app.storage.getTrash()), []);
});

test("a restore whose library write fails keeps its copy", async () => {
  const app = storageWith(initial, { rejectSet(payload) { if ("sh:sig" in payload) throw new Error("MAX_WRITE_OPERATIONS_PER_MINUTE"); } });
  await app.storage.deleteShorthand("sig");
  await assert.rejects(app.storage.restoreDeleted("sig"), /MAX_WRITE_OPERATIONS_PER_MINUTE/);
  assert.equal(app.items["sh:sig"], undefined);
  assert.deepEqual(withoutTime(await app.storage.getTrash()), [{ id: "sig", trigger: "sig/", expansion: "Original signature", order: 1 }]);
});

// Holds the first read of Recently deleted, after it was taken, until the
// test releases it, so a second action can run in between unless the write
// lock makes it wait.
function holdFirstTrashRead() {
  let release, reached;
  const held = new Promise((resolve) => { release = resolve; });
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  let done = false;
  return {
    afterGet(key) {
      if (key !== TRASH || done) return undefined;
      done = true;
      reached();
      return held;
    },
    reached: reachedPromise,
    release,
  };
}

test("Recently deleted changes wait for each other under the write lock", async () => {
  const lib = { ...initial, "sh:z": { trigger: "z/", expansion: "Zed", order: 5 } };
  const copy = (id) => ({ id, trigger: id + "/", expansion: id, order: 9, deletedAt: 1 });
  async function race(trash, first, second) {
    const hold = holdFirstTrashRead();
    const app = storageWith(lib, { afterGet: hold.afterGet });
    app.local[TRASH] = trash;
    const one = first(app.storage);
    await hold.reached;
    const two = second(app.storage);
    await new Promise((resolve) => setImmediate(resolve));
    hold.release();
    await Promise.all([one, two]);
    return { app, ids: (app.local[TRASH] || []).map((entry) => entry.id) };
  }

  let { app, ids } = await race([copy("x")], (s) => s.restoreDeleted("x"), (s) => s.deleteShorthand("z"));
  assert.deepEqual(ids, ["z"], "a restore does not write back a list read before another tab's delete");
  assert.equal(app.items["sh:z"], undefined);
  assert.equal(app.items["sh:x"].expansion, "x");

  ({ ids } = await race([copy("a"), copy("b")], (s) => s.forgetDeleted("a"), (s) => s.deleteShorthand("z")));
  assert.deepEqual(ids, ["z", "b"], "Delete for good does not drop a copy kept meanwhile");

  ({ ids } = await race([copy("a")], (s) => s.deleteShorthand("z"), (s) => s.emptyTrash()));
  assert.deepEqual(ids, [], "Empty is not undone by a delete that read the list before it");
});

test("delete and restore first finish an interrupted import", async () => {
  const imported = { trigger: "sig/", expansion: "Imported signature", order: 1 };
  const deleting = storageWith({ ...initial, "sh:sig": imported });
  deleting.local["shorthand-import-journal"] = { before: library, payload: { ...library, "sh:sig": imported }, committed: false };
  await deleting.storage.deleteShorthand("sig");
  assert.deepEqual(withoutTime(await deleting.storage.getTrash()), [{ id: "sig", trigger: "sig/", expansion: "Original signature", order: 1 }],
    "the copy is of the record the import had not yet replaced");
  assert.equal(deleting.items["sh:sig"], undefined);
  assert.equal(deleting.local["shorthand-import-journal"], undefined);

  const restoring = storageWith(initial);
  await restoring.storage.deleteShorthand("sig");
  const clash = { trigger: "sig/", expansion: "From the unfinished import", order: 5 };
  restoring.items["sh:imp"] = clash;
  restoring.local["shorthand-import-journal"] = { before: { "sh:local": initial["sh:local"] }, payload: { "sh:local": initial["sh:local"], "sh:imp": clash }, committed: false };
  assert.deepEqual(plain(await restoring.storage.restoreDeleted("sig")), { restored: true, id: "sig", trigger: "sig/" },
    "the unfinished import's sig/ is rolled back before the trigger is checked");
  assert.equal(restoring.items["sh:imp"], undefined);
  assert.deepEqual(restoring.items["sh:sig"], initial["sh:sig"]);
});

test("a restore whose copy cannot be dropped still reports the restore, and the next restore drops it", async () => {
  let failCleanup = false;
  const app = storageWith(initial, { rejectLocalSet() { if (failCleanup) throw new Error("local storage unavailable"); } });
  await app.storage.deleteShorthand("local");
  await app.storage.deleteShorthand("sig");
  failCleanup = true;
  assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), { restored: true, id: "sig", trigger: "sig/" });
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
  assert.deepEqual(plain((await app.storage.getTrash()).map((entry) => entry.id)), ["sig", "local"], "the stale copy is still listed");
  failCleanup = false;
  assert.deepEqual(plain(await app.storage.restoreDeleted("sig")), { restored: true, alreadyThere: true, id: "sig", trigger: "sig/" });
  assert.deepEqual(plain((await app.storage.getTrash()).map((entry) => entry.id)), ["local"]);
});

test("restoring an entry that is no longer kept says so", async () => {
  const app = storageWith(initial);
  assert.deepEqual(plain(await app.storage.restoreDeleted("missing")), { restored: false, message: "That shorthand is no longer in Recently deleted." });
  assert.deepEqual(app.calls, []);
});

test("Delete for good removes one entry and Empty removes them all, without touching the library", async () => {
  for (const firefox of [false, true]) {
    const app = storageWith(initial, { firefox });
    await app.storage.deleteShorthand("sig");
    await app.storage.deleteShorthand("local");
    assert.deepEqual(plain((await app.storage.getTrash()).map((entry) => entry.id)), ["local", "sig"]);
    await app.storage.forgetDeleted("local");
    assert.deepEqual(plain((await app.storage.getTrash()).map((entry) => entry.id)), ["sig"]);
    await app.storage.forgetDeleted("missing");
    assert.deepEqual(plain((await app.storage.getTrash()).map((entry) => entry.id)), ["sig"]);
    await app.storage.emptyTrash();
    assert.deepEqual(plain(await app.storage.getTrash()), []);
    assert.equal(TRASH in trashArea(app, firefox), false);
    assert.deepEqual(plain((await app.storage.getAll()).shorthands), []);
    assert.deepEqual(app.items.settings, initial.settings);
  }
});

test("Recently deleted ignores malformed entries", async () => {
  const app = storageWith(initial);
  app.local[TRASH] = [
    { id: "ok", trigger: "ok/", expansion: "Fine", order: 3, deletedAt: 5 },
    null, "text", 7, [], { trigger: "noid/", expansion: "x" }, { id: "", trigger: "x/", expansion: "x" },
    { id: 9, trigger: "x/", expansion: "x" }, { id: "num", trigger: 7, expansion: "x" },
    { id: "obj", trigger: "e/", expansion: { html: "<b>x</b>" } },
    { id: "ok", trigger: "dup/", expansion: "a second entry for the same id" },
    { id: "loose", trigger: "loose/", expansion: "", order: "2", deletedAt: "yesterday" },
    // Finite, but outside what a Date can hold: the page could not show it.
    { id: "far", trigger: "far/", expansion: "x", order: 4, deletedAt: 1e16 },
    { id: "past", trigger: "past/", expansion: "x", order: 5, deletedAt: -8.64e15 - 1 },
    { id: "edge", trigger: "edge/", expansion: "x", order: 6, deletedAt: 8.64e15 },
  ];
  assert.deepEqual(plain(await app.storage.getTrash()), [
    { id: "ok", trigger: "ok/", expansion: "Fine", order: 3, deletedAt: 5 },
    { id: "loose", trigger: "loose/", expansion: "", order: 0, deletedAt: null },
    { id: "far", trigger: "far/", expansion: "x", order: 4, deletedAt: null },
    { id: "past", trigger: "past/", expansion: "x", order: 5, deletedAt: null },
    { id: "edge", trigger: "edge/", expansion: "x", order: 6, deletedAt: 8.64e15 },
  ]);
  for (const value of [{ not: "a list" }, "text", null, 3]) {
    app.local[TRASH] = value;
    assert.deepEqual(plain(await app.storage.getTrash()), []);
  }
});

test("on Chrome, nothing about Recently deleted is ever written to sync storage", async () => {
  const app = storageWith(initial);
  await app.storage.deleteShorthand("sig");
  await app.storage.restoreDeleted("sig");
  await app.storage.deleteShorthand("sig");
  await app.storage.forgetDeleted("sig");
  await app.storage.deleteShorthand("local");
  await app.storage.emptyTrash();
  for (const call of app.calls) {
    const keys = call.operation === "set" ? Object.keys(call.payload) : [].concat(call.keys);
    assert.equal(keys.includes(TRASH), false, JSON.stringify(call));
  }
  assert.equal(TRASH in app.items, false);
  assert.ok(app.localCalls.some((call) => call.operation === "set" && TRASH in call.payload), "it went to local storage instead");
});

test("Writing pad keys are never library changes", () => {
  // Firefox keeps the library in storage.local beside the pad, which autosaves
  // as the person types: those writes must not make every page reload it.
  const firefox = storageWith({}, { firefox: true }).storage;
  for (const key of ["pad-draft:abc123", "pad-trash", "pad-prefs", "pad-dismissed", "pad-anything-later"]) {
    assert.equal(firefox.isLibraryChange({ [key]: {} }, "local"), false, key);
  }
  assert.equal(firefox.isLibraryChange({ "pad-draft:abc123": {}, "pad-trash": {} }, "local"), false);
  assert.equal(firefox.isLibraryChange({ "pad-draft:abc123": {}, "sh:a": {} }, "local"), true);
  assert.equal(firefox.isLibraryChange({ "pad-prefs": {}, settings: {} }, "local"), true);
  const chromeStorage = storageWith({}).storage;
  assert.equal(chromeStorage.isLibraryChange({ "pad-draft:abc123": {} }, "local"), false);
  assert.equal(chromeStorage.isLibraryChange({ "sh:a": {} }, "sync"), true);
});

test("a Recently deleted change is not a library change", () => {
  const firefox = storageWith({}, { firefox: true }).storage;
  assert.equal(firefox.TRASH_KEY, TRASH);
  assert.equal(firefox.isLibraryChange({ [TRASH]: {} }, "local"), false);
  assert.equal(firefox.isLibraryChange({ [TRASH]: {}, "sh:a": {} }, "local"), true);
  const chromeStorage = storageWith({}).storage;
  assert.equal(chromeStorage.isLibraryChange({ [TRASH]: {} }, "local"), false);
});
