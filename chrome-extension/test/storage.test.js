const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { mergeImport } = require("../src/import-plan.js");

// Exercise the browser script with a storage double that rejects writes before
// mutation, as sync storage does for quota failures. Browser tests cover the
// actual API's per-item quota separately.
function storageWith(initial, { rejectSet, rejectRemove, firefox = false } = {}) {
  const items = structuredClone(initial);
  const calls = [];
  const dataStore = {
    async get() { return structuredClone(items); },
    async set(payload) {
      calls.push({ operation: "set", payload: structuredClone(payload) });
      if (rejectSet) rejectSet(payload, items);
      Object.assign(items, structuredClone(payload));
    },
    async remove(keys) {
      calls.push({ operation: "remove", keys });
      if (rejectRemove) rejectRemove();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete items[key];
    },
  };
  const chrome = {
    runtime: { getManifest: () => firefox ? { browser_specific_settings: { gecko: { id: "test@example.test" } } } : {} },
    storage: { [firefox ? "local" : "sync"]: dataStore },
  };
  const context = vm.createContext({ chrome, self: {} });
  vm.runInContext(fs.readFileSync(require.resolve("../src/storage.js"), "utf8"), context);
  return { storage: context.self.ShorthandStorage, items, calls };
}

const initial = {
  "sh:local": { trigger: "local/", expansion: "Keep me", order: 0 },
  "sh:sig": { trigger: "sig/", expansion: "Original signature", order: 1 },
  settings: { enabled: false },
  unrelated: "preserve this too",
};
const plain = (value) => JSON.parse(JSON.stringify(value));

test("Firefox uses local storage for its library and settings", async () => {
  // No sync API is provided: every read, write and delete must use local storage.
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
});

test("Chrome keeps using sync storage", async () => {
  const app = storageWith(initial);
  assert.equal(app.storage.AREA, "sync");
  assert.equal((await app.storage.getAll()).shorthands.length, 2);
});

test("a failed import leaves the entire saved library intact", async () => {
  const app = storageWith(initial, {
    rejectSet() { throw new Error("MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded"); },
  });
  const result = await app.storage.replaceAll([
    { trigger: "sig/", expansion: "Updated signature" },
    { trigger: "new/", expansion: "New entry" },
  ]);
  assert.deepEqual(app.items, initial);
  assert.equal(result.savedCount, 0);
  assert.deepEqual(plain(result.failures).map((failure) => failure.trigger), ["sig/", "new/"]);
  assert.match(result.failures[0].message, /quota exceeded/);
  assert.equal(app.calls.some((call) => call.operation === "remove"), false);
});

test("a rejected item does not prevent good imports or erase prior entries", async () => {
  const app = storageWith(initial, {
    rejectSet(payload) {
      if (Object.values(payload).some((item) => item.expansion.length > 50)) {
        throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      }
    },
  });
  const result = await app.storage.replaceAll([
    { trigger: "sig/", expansion: "x".repeat(100) },
    { trigger: "new/", expansion: "New entry" },
  ]);
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
  assert.equal(Object.values(app.items).some((item) => item.trigger === "new/"), true);
  assert.equal(result.savedCount, 1);
  assert.deepEqual(plain(result.failures), [
    { trigger: "sig/", message: "QUOTA_BYTES_PER_ITEM quota exceeded" },
  ]);
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
  assert.equal(result.savedCount, 2);
  assert.deepEqual(plain(result.failures), []);
});

test("successful replacement writes before removing old entries and retains settings", async () => {
  const app = storageWith(initial);
  const result = await app.storage.replaceAll([{ trigger: "new/", expansion: "New entry" }]);
  assert.equal(result.savedCount, 1);
  assert.deepEqual(plain(result.failures), []);
  assert.equal(result.cleanupError, null);
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
  const { shorthands } = await app.storage.getAll();
  const result = await app.storage.replaceAll(mergeImport(shorthands, [
    { trigger: "sig/", expansion: "Updated signature" },
    { trigger: "new/", expansion: "New entry" },
  ]));
  assert.equal(result.savedCount, 3);
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.equal(app.items["sh:sig"].expansion, "Updated signature");
  assert.equal((await app.storage.getAll()).shorthands.length, 3);
});

test("cleanup failure reports retained old entries after saving valid imports", async () => {
  const app = storageWith(initial, {
    rejectRemove() { throw new Error("Storage unavailable during cleanup"); },
  });
  const result = await app.storage.replaceAll([{ trigger: "new/", expansion: "New entry" }]);
  assert.equal(result.savedCount, 1);
  assert.equal(result.cleanupError, "Storage unavailable during cleanup");
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.deepEqual(app.items["sh:sig"], initial["sh:sig"]);
  assert.equal(Object.values(app.items).some((item) => item.trigger === "new/"), true);
});

test("total quota pressure preserves the old library and reports additions that do not fit", async () => {
  const app = storageWith(initial, {
    rejectSet(payload, items) {
      if (Object.keys({ ...items, ...payload }).filter((key) => key.startsWith("sh:")).length > 2) {
        throw new Error("MAX_ITEMS quota exceeded");
      }
    },
  });
  const result = await app.storage.replaceAll([
    { trigger: "new/", expansion: "No room until old entries are removed" },
    { trigger: "sig/", expansion: "Update fits in existing slot" },
  ]);
  assert.equal(result.savedCount, 1);
  assert.deepEqual(plain(result.failures), [
    { trigger: "new/", message: "MAX_ITEMS quota exceeded" },
  ]);
  assert.deepEqual(app.items["sh:local"], initial["sh:local"]);
  assert.equal(app.items["sh:sig"].expansion, "Update fits in existing slot");
  assert.equal(app.calls.some((call) => call.operation === "remove"), false);
});
