const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/storage.js"), "utf8");
const old = { "sh:one": { trigger: "old/", expansion: "keep me", order: 0 } };
const clone = (value) => JSON.parse(JSON.stringify(value));

function environment(initial = old, limits = {}, { chromeKeyOrder = false } = {}) {
  const syncData = clone(initial), localData = {}, calls = [];
  let failure = null, onRead = null;
  function area(data, name) {
    return {
      ...limits,
      async get(key) {
        if (name === "sync" && onRead) onRead(data);
        const result = clone(key ? { [key]: data[key] } : data);
        // Chrome hands dictionaries back with their keys alphabetised, not in write order.
        if (chromeKeyOrder) for (const [k, v] of Object.entries(result)) if (v && typeof v === "object" && !Array.isArray(v)) result[k] = Object.fromEntries(Object.entries(v).sort());
        return result;
      },
      async set(values) {
        calls.push([name, "set", clone(values)]);
        if (name === "sync" && failure) {
          const fn = failure; failure = null; fn(data, values);
        }
        Object.assign(data, clone(values));
      },
      async remove(keys) {
        calls.push([name, "remove", keys]);
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      },
    };
  }
  const chrome = { runtime: { getManifest: () => ({}) }, storage: { sync: area(syncData, "sync"), local: area(localData, "local") } };
  const load = () => {
    const sandbox = { self: {}, chrome, TextEncoder };
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    return sandbox.self.ShorthandStorage;
  };
  return { storage: load(), load, syncData, localData, calls, fail(fn) { failure = fn; }, onRead(fn) { onRead = fn; } };
}

test("oversized import skips the bad item and retains the old synced library", async () => {
  const e = environment();
  const result = await e.storage.replaceAll([{ trigger: "huge/", expansion: "x".repeat(9000) }]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(e.syncData, old);
  assert.equal(result.preservedExisting, true);
  assert.deepEqual(clone(await e.storage.getImportBackup()), [{ trigger: "old/", expansion: "keep me" }]);
});

test("an incomplete replacement imports fitting entries as a merge", async () => {
  const e = environment();
  const result = await e.storage.replaceAll([{ trigger: "huge/", expansion: "x".repeat(9000) }, { trigger: "new/", expansion: "small" }]);
  assert.equal(result.skipped.length, 1);
  assert.ok(e.syncData["sh:one"]);
  assert.ok(Object.values(e.syncData).some((s) => s.trigger === "new/"));
});

test("merge reads the current library under the lock and retains unrelated additions", async () => {
  const e = environment();
  e.syncData["sh:recent"] = { trigger: "recent/", expansion: "added in another options tab", order: 2 };
  const result = await e.storage.replaceAll([{ trigger: "old/", expansion: "updated" }], { merge: true });
  assert.equal(result.skipped.length, 0);
  assert.equal(e.syncData["sh:one"].expansion, "updated");
  assert.equal(e.syncData["sh:recent"].expansion, "added in another options tab");
});

test("serialized UTF-8 and non-snippet records count toward quotas", async () => {
  const e = environment({ ...old, settings: { enabled: true } }, { QUOTA_BYTES: 170, QUOTA_BYTES_PER_ITEM: 120, MAX_ITEMS: 2 });
  const result = await e.storage.replaceAll([{ trigger: "old/", expansion: "😀".repeat(100) }, { trigger: "new/", expansion: "small" }]);
  assert.ok(result.skipped.length >= 1);
  assert.deepEqual(e.syncData["sh:one"], old["sh:one"]);
  assert.equal(e.syncData.settings.enabled, true);
  assert.equal(Object.keys(e.syncData).length, 2);
});

test("a storage write that partially applies then rejects is rolled back", async () => {
  const e = environment();
  e.fail((data, values) => { Object.assign(data, clone(values)); throw new Error("quota or sync failure"); });
  await assert.rejects(e.storage.replaceAll([{ trigger: "new/", expansion: "replacement" }]), /sync failure/);
  assert.deepEqual(e.syncData, old);
  assert.ok(e.calls.findIndex(([area, action]) => area === "local" && action === "set") < e.calls.findIndex(([area]) => area === "sync"));
  assert.equal(e.localData["shorthand-import-journal"], undefined);
});

test("near-full imports keep a durable backup before freeing old keys", async () => {
  const e = environment(old, { MAX_ITEMS: 1 });
  e.fail(() => { throw new Error("write rejected"); });
  await assert.rejects(e.storage.replaceAll([{ trigger: "new/", expansion: "replacement" }]), /write rejected/);
  assert.deepEqual(e.syncData, old);
  const deletion = e.calls.findIndex(([area, action]) => area === "sync" && action === "remove");
  assert.ok(deletion > 0);
  assert.equal(e.calls[0][0], "local");
  assert.deepEqual(e.localData["shorthand-import-backup"], old);
});

test("an interrupted process recovers its journal in a fresh context", async () => {
  const payload = { "sh:new": { trigger: "new/", expansion: "partial", order: 0 } };
  const e = environment(payload);
  e.localData["shorthand-import-journal"] = { before: clone(old), payload: clone(payload), committed: false };
  await e.load().recoverPendingImport();
  assert.deepEqual(e.syncData, old);
  assert.equal(e.localData["shorthand-import-journal"], undefined);
});

test("successful replacement persists the complete set and keeps its recovery export", async () => {
  const e = environment();
  const result = await e.storage.replaceAll([{ trigger: "new/", expansion: "replacement" }]);
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(Object.values(e.syncData).map((s) => s.trigger), ["new/"]);
  assert.deepEqual(e.localData["shorthand-import-backup"], old);
  assert.equal(e.localData["shorthand-import-journal"], undefined);
});

test("failed rollback keeps an exportable journal and recovers on the next attempt", async () => {
  const e = environment(old, { MAX_ITEMS: 1 });
  const syncSet = e.storage;
  // Two failures: the import partially writes, then rollback hits Chrome's
  // write limit. A fresh process must still be able to recover the originals.
  const originalSet = e.load;
  e.fail((data, values) => {
    Object.assign(data, clone(values));
    e.fail(() => { throw new Error("rollback rate limited"); });
    throw new Error("import failed");
  });
  await assert.rejects(syncSet.replaceAll([{ trigger: "new/", expansion: "replacement" }]), /original library is saved locally/);
  assert.deepEqual(e.localData["shorthand-import-journal"].before, old);
  assert.deepEqual(clone(await syncSet.getImportBackup()), [{ trigger: "old/", expansion: "keep me" }]);
  await originalSet().recoverPendingImport();
  assert.deepEqual(e.syncData, old);
});

test("recovery preserves records and edits synced after an interrupted import", async () => {
  const attempted = { "sh:new": { trigger: "new/", expansion: "partial", order: 0 } };
  const remote = { trigger: "remote/", expansion: "arrived from another device", order: 2 };
  const edited = { ...old["sh:one"], expansion: "newer remote edit" };
  const e = environment({ ...attempted, "sh:one": edited, "sh:remote": remote });
  e.localData["shorthand-import-journal"] = { before: clone(old), payload: clone(attempted), committed: false };
  const recovery = await e.load().recoverPendingImport();
  assert.deepEqual(e.syncData["sh:remote"], remote);
  assert.deepEqual(e.syncData["sh:one"], edited);
  assert.equal(e.syncData["sh:new"], undefined, "only the failed import's unchanged addition is removed");
  assert.equal(recovery.conflicts.length, 1, "the preserved edit is reported for the options warning");
  assert.equal(e.localData["shorthand-import-journal"], undefined);
});

test("legacy recovery without an attempted payload preserves unknown additions", async () => {
  const remote = { trigger: "remote/", expansion: "newer record", order: 2 };
  const e = environment({ "sh:remote": remote });
  e.localData["shorthand-import-journal"] = { before: clone(old), committed: false };
  await e.load().recoverPendingImport();
  assert.deepEqual(e.syncData, { ...old, "sh:remote": remote });
});

test("rollback after a rejected sync write preserves concurrent remote edits", async () => {
  const remote = { trigger: "remote/", expansion: "arrived during write", order: 2 };
  const edited = { ...old["sh:one"], expansion: "remote revision during write" };
  const e = environment();
  e.fail((data, values) => {
    Object.assign(data, clone(values), { "sh:one": edited, "sh:remote": remote });
    throw new Error("write rejected");
  });
  await assert.rejects(e.storage.replaceAll([{ trigger: "new/", expansion: "replacement" }]), /concurrent edits.*preserved/i);
  assert.deepEqual(e.syncData, { "sh:one": edited, "sh:remote": remote });
  assert.deepEqual(e.localData["shorthand-import-backup"], old);
});

test("replace does not delete a newer edit arriving during its sync write", async () => {
  const edited = { ...old["sh:one"], expansion: "edited remotely while replacement wrote" };
  const e = environment();
  e.fail((data) => { data["sh:one"] = clone(edited); });
  await assert.rejects(e.storage.replaceAll([{ trigger: "new/", expansion: "replacement" }]), /concurrent edits.*preserved/i);
  assert.deepEqual(e.syncData, { "sh:one": edited });
  assert.deepEqual(e.localData["shorthand-import-backup"], old);
});

test("records that Chrome returns with alphabetised keys still count as persisted", async () => {
  const e = environment(old, {}, { chromeKeyOrder: true });
  const result = await e.storage.replaceAll([{ trigger: "new/", expansion: "replacement" }]);
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(Object.values(e.syncData).map((s) => s.trigger), ["new/"]);
  assert.equal(e.localData["shorthand-import-journal"], undefined);
  await e.storage.replaceAll([{ trigger: "old/", expansion: "keep me" }], { merge: true });
  assert.deepEqual(Object.values(e.syncData).map((s) => s.trigger).sort(), ["new/", "old/"]);
});

test("an import rechecks original values before overwriting a newer sync edit", async () => {
  const edited = { ...old["sh:one"], expansion: "edited remotely before import wrote" };
  const e = environment();
  let reads = 0;
  e.onRead((data) => { if (++reads === 2) data["sh:one"] = clone(edited); });
  await assert.rejects(e.storage.replaceAll([{ trigger: "old/", expansion: "imported revision" }], { merge: true }), /concurrent edits.*preserved/i);
  assert.deepEqual(e.syncData, { "sh:one": edited });
  assert.deepEqual(e.localData["shorthand-import-backup"], old);
});
