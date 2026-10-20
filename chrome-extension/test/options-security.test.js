const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const library = [{ id: "one", trigger: "old/", expansion: "keep me", order: 0 }];

// The real predicate deciding which storage changes reload the page.
function libraryChangeFilter(firefox) {
  const context = vm.createContext({ self: {}, TextEncoder, chrome: {
    runtime: { getManifest: () => firefox ? { browser_specific_settings: { gecko: { id: "test@example.test" } } } : {} },
    storage: firefox ? { local: {} } : { sync: {}, local: {} },
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/storage.js"), "utf8"), context);
  return context.self.ShorthandStorage;
}

async function options(recoveryError = null, conflicts = [], readError = null, draft = "", { firefox = false, trash = [], storageOverrides = {}, confirmAnswer = true } = {}) {
  const nodes = new Map(), created = [], downloads = [], listeners = [], calls = [], confirms = [];
  let reads = 0;
  function element(tag = "div") {
    const node = { tag, value: "", textContent: "", disabled: false, hidden: false, classList: { toggle() {}, add() {}, remove() {} }, handlers: {}, children: [], attributes: {},
      addEventListener(event, fn) { const previous = this.handlers[event]; this.handlers[event] = previous ? (...args) => { previous(...args); return fn(...args); } : fn; }, append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute(name, value) { this.attributes[name] = String(value); }, click() {}, remove() {}, focus() { document.activeElement = this; }, scrollIntoView() {},
      querySelectorAll() { return ["editId", "trigger", "expansion", "saveBtn", "cancelBtn"].map(get); },
    };
    created.push(node); return node;
  }
  function get(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
  const document = { activeElement: null, getElementById: get, querySelector() { return get("tbody"); }, createElement: element, createTextNode: (text) => ({ textContent: text }), body: element() };
  const real = libraryChangeFilter(firefox);
  const storage = {
    DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" },
    async recoverPendingImport() { if (recoveryError) throw new Error(recoveryError); return { conflicts }; },
    AREA: firefox ? "local" : "sync",
    TRASH_KEY: real.TRASH_KEY,
    isLibraryChange: real.isLibraryChange,
    async getAll() { reads++; if (readError) throw new Error(readError); return { shorthands: library, settings: { enabled: true, excludedHosts: [] } }; },
    async getTrash() { return typeof trash === "function" ? trash() : trash; },
    async deleteShorthand(...args) { calls.push(["delete", ...args]); return { deleted: true, kept: true, trigger: "old/" }; },
    async restoreDeleted(id) { calls.push(["restore", id]); return { restored: true, trigger: "old/" }; },
    toExportJson(shorthands) { return JSON.stringify({ shorthands }); },
    async takePendingDraft() { const text = draft; draft = ""; return text; },
    ...storageOverrides,
  };
  const sandbox = { self: { ShorthandStorage: storage, ShorthandExpander: require("../src/expander.js"), ShorthandTemplate: require("../src/template.js"),
    ShorthandImportPlan: require("../src/import-plan.js"), ShorthandConflicts: { byTrigger() { return new Map(); } } }, document, Blob,
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    chrome: { storage: { onChanged: { addListener(fn) { listeners.push(fn); } } } }, setTimeout() {},
    window: { confirm(message) { confirms.push(message); return confirmAnswer; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/options.js"), "utf8"), sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  async function storageChanged(changes, area) { for (const fn of listeners) fn(changes, area); await settle(); }
  // The newest button with this text: a re-render replaces the old ones.
  const button = (text) => created.filter((node) => node.tag === "button" && node.textContent === text).pop();
  const named = (label) => created.filter((node) => node.tag === "button" && node.attributes["aria-label"] === label).pop();
  return { get, created, downloads, document, storageChanged, settle, button, named, calls, confirms, reads: () => reads, setDraft(text) { draft = text; }, draft: () => draft };
}

const deletedEntry = { id: "gone", trigger: "gone/", expansion: "Deleted\n  earlier", order: 2, deletedAt: Date.UTC(2026, 9, 18, 12) };

test("failed writer recovery still exports the readable library and disables all write controls", async () => {
  const page = await options("writer lock unavailable", [], null, "", { trash: [deletedEntry] });
  page.get("exportBtn").handlers.click();
  const exported = JSON.parse(await page.downloads[0].text());
  assert.deepEqual(exported.shorthands, library, "recovery failure must not export an empty library");
  for (const id of ["enabled", "excluded", "pickerTrigger", "phraseWords", "trigger", "expansion", "saveBtn", "importBtn", "importFile", "mergeBtn", "replaceBtn", "undoBtn", "emptyTrashBtn"]) {
    assert.equal(page.get(id).disabled, true, id + " must not accept edits after failed recovery");
  }
  // Edit and Delete for the one shorthand, Restore and Delete for good for the
  // one Recently deleted entry.
  const libraryButtons = page.created.filter((node) => node.tag === "button");
  assert.deepEqual(libraryButtons.map((node) => node.textContent), ["Edit", "Delete", "Restore", "Delete for good"]);
  assert.ok(libraryButtons.every((node) => node.disabled), "library Edit/Delete and Recently deleted actions must also be disabled");
  assert.equal(page.get("trashCount").textContent, "1", "Recently deleted is still shown, read-only");
  assert.equal(page.get("exportBtn").disabled, false);
  assert.equal(page.get("backupBtn").disabled, false);
  assert.match(page.get("ioMsg").textContent, /writer lock unavailable/);
});

test("a saved selection draft prefills the pristine create form once", async () => {
  const page = await options(null, [], null, "Selected on a page");
  assert.equal(page.get("expansion").value, "Selected on a page");
  assert.equal(page.get("trigger").value, "");
  assert.match(page.get("formMsg").textContent, /Selection added as a draft/);
});

test("Firefox use counts and drafts in the library's area do not reload an open library page", async () => {
  const page = await options(null, [], null, "", { firefox: true });
  const reads = page.reads();
  page.document.activeElement = null;
  page.get("excluded").value = "typing.example";
  await page.storageChanged({ "shorthand-usage-counts": { newValue: { one: 1 } } }, "local");
  await page.storageChanged({ "shorthand-pending-draft": { oldValue: { expansion: "x" } } }, "local");
  await page.storageChanged({ "actle-premium": { newValue: {} } }, "local");
  assert.equal(page.reads(), reads, "an expansion in another tab must not reload the library");
  assert.equal(page.get("excluded").value, "typing.example");
  await page.storageChanged({ "sh:one": { newValue: library[0] } }, "local");
  assert.equal(page.reads(), reads + 1, "a library change in local storage still reloads on Firefox");
});

test("a library reload from another tab keeps excluded hosts still being typed", async () => {
  const page = await options();
  const excluded = page.get("excluded");
  page.document.activeElement = excluded;
  excluded.value = "half-typed.exam";
  await page.storageChanged({ "sh:one": { newValue: library[0] } }, "sync");
  assert.equal(excluded.value, "half-typed.exam");
  page.document.activeElement = null;
  await page.storageChanged({ "sh:one": { newValue: library[0] } }, "sync");
  assert.equal(excluded.value, "", "an unfocused list still shows the saved hosts");
});

test("a selection arriving mid-edit waits, says so, and fills the form after cancel", async () => {
  const page = await options();
  page.get("expansion").value = "my unsaved text";
  page.setDraft("Selected on a page");
  await page.storageChanged({ "shorthand-pending-draft": { newValue: { expansion: "Selected on a page" } } }, "local");
  assert.equal(page.get("expansion").value, "my unsaved text", "an edit in progress is never replaced");
  assert.equal(page.draft(), "Selected on a page", "the draft stays stored while it waits");
  assert.match(page.get("formMsg").textContent, /selection from a webpage is waiting/);
  page.get("cancelBtn").handlers.click();
  await page.settle();
  assert.equal(page.get("expansion").value, "Selected on a page");
  assert.equal(page.draft(), "", "the draft is consumed once");
  assert.match(page.get("formMsg").textContent, /Selection added as a draft/);
});

test("clearing a new shorthand's text lets a waiting selection in", async () => {
  const page = await options();
  const expansion = page.get("expansion");
  expansion.value = "x";
  page.setDraft("Selected on a page");
  await page.storageChanged({ "shorthand-pending-draft": { newValue: { expansion: "Selected on a page" } } }, "local");
  assert.equal(expansion.value, "x");
  expansion.value = "";
  expansion.handlers.input();
  await page.settle();
  assert.equal(expansion.value, "Selected on a page");
});

test("a waiting notice clears when another library tab already took the draft", async () => {
  const page = await options();
  page.get("expansion").value = "x";
  page.setDraft("taken elsewhere");
  await page.storageChanged({ "shorthand-pending-draft": { newValue: { expansion: "taken elsewhere" } } }, "local");
  page.setDraft("");
  page.get("cancelBtn").handlers.click();
  await page.settle();
  assert.equal(page.get("expansion").value, "");
  assert.equal(page.get("formMsg").textContent, "");
});

test("successful recovery loads the library and reports preserved concurrent edits", async () => {
  const page = await options(null, ["sh:one"]);
  assert.equal(page.get("shorthandCount").textContent, "1");
  assert.equal(page.get("enabled").disabled, false);
  assert.match(page.get("ioMsg").textContent, /preserved newer edits to 1 snippet/);
});

test("unreadable sync storage reports the failure and retains the local backup export", async () => {
  const page = await options("recovery interrupted", [], "sync storage unavailable");
  assert.equal(page.get("exportBtn").disabled, true, "an unread library must not appear to export successfully as empty");
  assert.equal(page.get("backupBtn").disabled, false);
  assert.match(page.get("ioMsg").textContent, /Current library could not be read: sync storage unavailable/);
});

test("Delete says what it deleted and offers Undo, which restores it and returns focus to the row", async () => {
  const page = await options();
  await page.button("Delete").handlers.click();
  assert.deepEqual(page.calls, [["delete", "one"]]);
  assert.equal(page.get("libraryMsg").textContent, "Deleted old/.");
  assert.equal(page.get("undoBtn").hidden, false);
  assert.equal(page.get("undoBtn").disabled, false);
  assert.equal(page.document.activeElement, page.get("undoBtn"), "focus moves to Undo, not to the page");
  await page.get("undoBtn").handlers.click();
  assert.deepEqual(page.calls, [["delete", "one"], ["restore", "one"]]);
  assert.equal(page.get("libraryMsg").textContent, "Restored old/.");
  assert.equal(page.get("undoBtn").hidden, true);
  assert.equal(page.document.activeElement, page.button("Edit"), "focus returns to the restored row");
});

test("Undo stays until the next library action, with no timeout", async () => {
  const page = await options(null, [], null, "", { storageOverrides: { async saveShorthand() { return "new"; } } });
  await page.button("Delete").handlers.click();
  await page.storageChanged({ "sh:one": { oldValue: library[0] } }, "sync");
  assert.equal(page.get("undoBtn").hidden, false, "a reload from another tab keeps the offer");
  page.get("trigger").value = "new/";
  page.get("expansion").value = "New";
  await page.get("editor").handlers.submit({ preventDefault() {} });
  await page.settle();
  assert.equal(page.get("undoBtn").hidden, true, "saving a shorthand is the next library action");
  assert.equal(page.get("libraryMsg").textContent, "");
});

test("a refused Undo keeps the entry, says why and moves focus to it in Recently deleted", async () => {
  const message = "old/ is already in your library. Rename or delete that one first.";
  const page = await options(null, [], null, "", {
    trash: [{ ...deletedEntry, id: "one", trigger: "old/" }],
    storageOverrides: { async restoreDeleted() { return { restored: false, trigger: "old/", message }; } },
  });
  await page.button("Delete").handlers.click();
  await page.get("undoBtn").handlers.click();
  assert.equal(page.get("libraryMsg").textContent, message);
  assert.equal(page.get("undoBtn").hidden, true);
  assert.equal(page.get("trash").open, true);
  assert.equal(page.document.activeElement, page.button("Restore"));
});

test("when a copy cannot be kept, Delete asks first and deletes without one only on OK", async () => {
  for (const answer of [false, true]) {
    const options_ = [];
    const page = await options(null, [], null, "", {
      confirmAnswer: answer,
      storageOverrides: {
        async deleteShorthand(id, opts) {
          options_.push(opts === undefined ? null : JSON.parse(JSON.stringify(opts)));
          if (!opts) throw Object.assign(new Error("old/ could not be kept in Recently deleted: full"), { code: "NOT_KEPT", trigger: "old/" });
          return { deleted: true, kept: false, trigger: "old/" };
        },
      },
    });
    await page.button("Delete").handlers.click();
    assert.deepEqual(page.confirms, ["old/ could not be kept in Recently deleted, so deleting it cannot be undone. Delete it anyway?"]);
    assert.deepEqual(options_, answer ? [null, { withoutCopy: true }] : [null], String(answer));
    assert.equal(page.get("libraryMsg").textContent, answer ? "Deleted old/. It was not kept in Recently deleted." : "old/ was not deleted.");
    assert.equal(page.get("undoBtn").hidden, true, "there is nothing to undo from");
  }
});

test("any other delete failure is reported without offering to delete without a copy", async () => {
  const page = await options(null, [], null, "", {
    storageOverrides: { async deleteShorthand() { throw new Error("sync unavailable"); } },
  });
  await page.button("Delete").handlers.click();
  assert.deepEqual(page.confirms, []);
  assert.equal(page.get("libraryMsg").textContent, "Could not delete old/: sync unavailable");
});

test("Recently deleted lists each entry with Restore and Delete for good, built as text", async () => {
  const forgotten = [];
  let trash = [deletedEntry];
  const page = await options(null, [], null, "", {
    trash: () => trash,
    storageOverrides: { async forgetDeleted(id) { forgotten.push(id); trash = []; } },
  });
  assert.equal(page.get("trashCount").textContent, "1");
  assert.equal(page.get("trashEmpty").hidden, true);
  assert.equal(page.get("emptyTrashBtn").hidden, false);
  assert.ok(page.created.some((node) => node.className === "trash-trigger" && node.textContent === "gone/"));
  assert.ok(page.created.some((node) => node.className === "trash-preview" && node.textContent === "Deleted earlier"), "one line");
  assert.ok(page.created.some((node) => node.className === "trash-time" && /^Deleted .*2026/.test(node.textContent)));
  // Each accessible name starts with the visible label (WCAG 2.5.3), so speech input finds it.
  assert.equal(page.button("Restore").attributes["aria-label"], "Restore gone/");
  assert.equal(page.button("Delete for good").attributes["aria-label"], "Delete for good: gone/");
  await page.button("Delete for good").handlers.click();
  assert.deepEqual(forgotten, ["gone"]);
  assert.equal(page.get("libraryMsg").textContent, "Deleted gone/ for good.");
  assert.equal(page.get("trashCount").textContent, "0");
  assert.equal(page.get("trashEmpty").hidden, false);
  assert.equal(page.get("emptyTrashBtn").hidden, true);
  assert.equal(page.document.activeElement, page.get("trashSummary"));
});

test("Empty Recently deleted asks first", async () => {
  for (const answer of [false, true]) {
    let emptied = 0;
    const page = await options(null, [], null, "", {
      trash: [deletedEntry], confirmAnswer: answer,
      storageOverrides: { async emptyTrash() { emptied++; } },
    });
    await page.get("emptyTrashBtn").handlers.click();
    assert.deepEqual(page.confirms, ["Empty Recently deleted? The shorthand in it will be deleted for good."]);
    assert.equal(emptied, answer ? 1 : 0);
  }
});

test("a Recently deleted change from another tab refreshes that section without reloading the library", async () => {
  for (const firefox of [false, true]) {
    let trash = [];
    const page = await options(null, [], null, "", { firefox, trash: () => trash });
    const reads = page.reads();
    page.get("excluded").value = "typing.example";
    trash = [deletedEntry];
    await page.storageChanged({ "shorthand-trash": { newValue: trash } }, "local");
    assert.equal(page.reads(), reads, "the library is not reloaded");
    assert.equal(page.get("excluded").value, "typing.example");
    assert.equal(page.get("trashCount").textContent, "1", firefox ? "Firefox" : "Chrome");
  }
});

test("an unreadable Recently deleted says so instead of looking empty", async () => {
  const page = await options(null, [], null, "", { storageOverrides: { async getTrash() { throw new Error("local storage unavailable"); } } });
  assert.equal(page.get("trashEmpty").textContent, "Recently deleted could not be read: local storage unavailable");
  assert.equal(page.get("trashEmpty").hidden, false);
  assert.equal(page.get("trashCount").hidden, true);
  assert.equal(page.get("shorthandCount").textContent, "1", "the library still loads");
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a second click on Delete while it runs is ignored, so its message and Undo stay", async () => {
  let deletes = 0;
  const page = await options(null, [], null, "", {
    storageOverrides: {
      async deleteShorthand() {
        const n = ++deletes;
        await tick();
        return n === 1 ? { deleted: true, kept: true, trigger: "old/" } : { deleted: false, kept: false };
      },
    },
  });
  const del = page.button("Delete");
  await Promise.all([del.handlers.click(), del.handlers.click()]);
  assert.equal(deletes, 1);
  assert.equal(page.get("libraryMsg").textContent, "Deleted old/.");
  assert.equal(page.get("undoBtn").hidden, false);
  assert.equal(page.document.activeElement, page.get("undoBtn"));
});

test("a second click on Restore while it runs is ignored", async () => {
  let restores = 0;
  let trash = [deletedEntry];
  const page = await options(null, [], null, "", {
    trash: () => trash,
    storageOverrides: {
      async restoreDeleted(id) {
        const n = ++restores;
        await tick();
        if (n > 1) return { restored: true, alreadyThere: true, id, trigger: "gone/" };
        trash = [];
        return { restored: true, id, trigger: "gone/" };
      },
    },
  });
  const restore = page.button("Restore");
  await Promise.all([restore.handlers.click(), restore.handlers.click()]);
  assert.equal(restores, 1);
  assert.equal(page.get("libraryMsg").textContent, "Restored gone/.");
});

test("Delete and Restore say when there was nothing left to do", async () => {
  const page = await options(null, [], null, "", {
    trash: [deletedEntry],
    storageOverrides: {
      async deleteShorthand() { return { deleted: false, kept: false }; },
      async restoreDeleted(id) { return { restored: true, alreadyThere: true, id, trigger: "gone/" }; },
    },
  });
  await page.button("Delete").handlers.click();
  assert.equal(page.get("libraryMsg").textContent, "old/ was already deleted.");
  assert.equal(page.get("undoBtn").hidden, true);
  await page.button("Restore").handlers.click();
  assert.equal(page.get("libraryMsg").textContent, "gone/ is already back in your library.");
});

test("after Restore, focus moves to the next entry in Recently deleted", async () => {
  const later = { id: "b", trigger: "b/", expansion: "Bee", order: 3, deletedAt: deletedEntry.deletedAt - 1000 };
  let trash = [deletedEntry, later];
  const page = await options(null, [], null, "", {
    trash: () => trash,
    storageOverrides: { async restoreDeleted(id) { trash = trash.filter((entry) => entry.id !== id); return { restored: true, id, trigger: "gone/" }; } },
  });
  await page.named("Restore gone/").handlers.click();
  assert.equal(page.get("libraryMsg").textContent, "Restored gone/.");
  assert.equal(page.document.activeElement, page.named("Restore b/"));
});

test("Undo of a copy restored under a new id focuses that row", async () => {
  // The id came back holding other text, so the copy returned under "two".
  let shorthands = library;
  const page = await options(null, [], null, "", {
    storageOverrides: {
      async getAll() { return { shorthands, settings: { enabled: true, excludedHosts: [] } }; },
      async restoreDeleted() {
        shorthands = [{ ...library[0], expansion: "other text" }, { id: "two", trigger: "old/", expansion: "keep me", order: 1 }];
        return { restored: true, id: "two", trigger: "old/" };
      },
    },
  });
  await page.button("Delete").handlers.click();
  await page.get("undoBtn").handlers.click();
  const edits = page.created.filter((node) => node.tag === "button" && node.textContent === "Edit");
  assert.equal(page.document.activeElement, edits[edits.length - 1], "the row of the restored copy, not the row under the old id");
  assert.notEqual(page.document.activeElement, edits[edits.length - 2]);
});

test("Empty Recently deleted counts the shorthands it will delete", async () => {
  const page = await options(null, [], null, "", {
    trash: [deletedEntry, { ...deletedEntry, id: "b", trigger: "b/" }], confirmAnswer: false,
  });
  await page.get("emptyTrashBtn").handlers.click();
  assert.deepEqual(page.confirms, ["Empty Recently deleted? The 2 shorthands in it will be deleted for good."]);
});

test("the Undo offer clears as soon as Delete for good, Empty or an import starts", async () => {
  const pending = [];
  const wait = () => new Promise((resolve) => pending.push(resolve));
  const page = await options(null, [], null, "", {
    trash: [deletedEntry],
    storageOverrides: {
      async forgetDeleted() { await wait(); },
      async emptyTrash() { await wait(); },
      async replaceAll() { return { skipped: [] }; },
    },
  });
  const undoOffered = async () => {
    await page.button("Delete").handlers.click();
    assert.equal(page.get("undoBtn").hidden, false);
  };

  await undoOffered();
  const forgetting = page.button("Delete for good").handlers.click();
  assert.equal(page.get("undoBtn").hidden, true, "Delete for good is the next library action");
  pending.shift()();
  await forgetting;
  assert.equal(page.get("libraryMsg").textContent, "Deleted gone/ for good.");

  await undoOffered();
  const emptying = page.get("emptyTrashBtn").handlers.click();
  assert.equal(page.get("undoBtn").hidden, true, "Empty is the next library action");
  pending.shift()();
  await emptying;
  assert.equal(page.get("libraryMsg").textContent, "Emptied Recently deleted.");

  await undoOffered();
  await page.get("importFile").handlers.change({ target: { value: "", files: [{ text: async () => JSON.stringify({ shorthands: [{ trigger: "new/", expansion: "New" }] }) }] } });
  await page.get("mergeBtn").handlers.click();
  assert.match(page.get("ioMsg").textContent, /^Merged 1 shorthand/);
  assert.equal(page.get("undoBtn").hidden, true, "an import is the next library action");
  assert.equal(page.get("libraryMsg").textContent, "");
});

test("Recently deleted is still listed, read-only, when the library itself cannot be read", async () => {
  const page = await options("recovery interrupted", [], "sync storage unavailable", "", { trash: [deletedEntry] });
  assert.equal(page.get("trashCount").textContent, "1");
  assert.equal(page.get("trashEmpty").hidden, true);
  const buttons = page.created.filter((node) => node.tag === "button");
  assert.deepEqual(buttons.map((node) => node.textContent), ["Restore", "Delete for good"]);
  assert.ok(buttons.every((node) => node.disabled));
  assert.equal(page.get("emptyTrashBtn").disabled, true);
});
