const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Exercise the browser script with a storage double that rejects writes before
// mutation, as sync storage does for quota failures. Browser tests cover the
// actual API's per-item quota separately. The import journal and backup live in
// storage.local, which on Firefox is the library's own area.
function storageWith(initial, { rejectSet, rejectRemove, firefox = false, limits = {} } = {}) {
  const items = structuredClone(initial);
  const local = {};
  const calls = [];
  function area(data, library) {
    return {
      ...(library ? limits : {}),
      async get(key) { return structuredClone(key ? { [key]: data[key] } : data); },
      async set(payload) {
        if (library) calls.push({ operation: "set", payload: structuredClone(payload) });
        if (library && rejectSet) rejectSet(payload, data);
        Object.assign(data, structuredClone(payload));
      },
      async remove(keys) {
        if (library) calls.push({ operation: "remove", keys });
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
  return { storage: context.self.ShorthandStorage, items, local, calls };
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
      enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", animationMode: "expand",
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
      assert.deepEqual(app.items, { ...saved, settings: { ...saved.settings, animationMode } });
    }
    await app.storage.saveSettings({ enabled: true });
    assert.deepEqual(app.items.settings, { ...saved.settings, animationMode: "expand", enabled: true });
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
