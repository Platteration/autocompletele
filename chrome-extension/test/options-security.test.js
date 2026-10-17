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

async function options(recoveryError = null, conflicts = [], readError = null, draft = "", { firefox = false } = {}) {
  const nodes = new Map(), created = [], downloads = [], listeners = [];
  let reads = 0;
  function element(tag = "div") {
    const node = { tag, value: "", textContent: "", disabled: false, hidden: false, classList: { toggle() {}, add() {}, remove() {} }, handlers: {}, children: [],
      addEventListener(event, fn) { const previous = this.handlers[event]; this.handlers[event] = previous ? (...args) => { previous(...args); return fn(...args); } : fn; }, append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute() {}, click() {}, remove() {}, focus() {},
      querySelectorAll() { return ["editId", "trigger", "expansion", "saveBtn", "cancelBtn"].map(get); },
    };
    created.push(node); return node;
  }
  function get(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
  const document = { activeElement: null, getElementById: get, querySelector() { return get("tbody"); }, createElement: element, createTextNode: (text) => ({ textContent: text }), body: element() };
  const storage = {
    DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" },
    async recoverPendingImport() { if (recoveryError) throw new Error(recoveryError); return { conflicts }; },
    AREA: firefox ? "local" : "sync",
    isLibraryChange: libraryChangeFilter(firefox).isLibraryChange,
    async getAll() { reads++; if (readError) throw new Error(readError); return { shorthands: library, settings: { enabled: true, excludedHosts: [] } }; },
    toExportJson(shorthands) { return JSON.stringify({ shorthands }); },
    async takePendingDraft() { const text = draft; draft = ""; return text; },
  };
  const sandbox = { self: { ShorthandStorage: storage, ShorthandExpander: require("../src/expander.js"), ShorthandTemplate: require("../src/template.js"),
    ShorthandImportPlan: {}, ShorthandConflicts: { byTrigger() { return new Map(); } } }, document, Blob,
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    chrome: { storage: { onChanged: { addListener(fn) { listeners.push(fn); } } } }, setTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/options.js"), "utf8"), sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  async function storageChanged(changes, area) { for (const fn of listeners) fn(changes, area); await settle(); }
  return { get, created, downloads, document, storageChanged, settle, reads: () => reads, setDraft(text) { draft = text; }, draft: () => draft };
}

test("failed writer recovery still exports the readable library and disables all write controls", async () => {
  const page = await options("writer lock unavailable");
  page.get("exportBtn").handlers.click();
  const exported = JSON.parse(await page.downloads[0].text());
  assert.deepEqual(exported.shorthands, library, "recovery failure must not export an empty library");
  for (const id of ["enabled", "excluded", "pickerTrigger", "trigger", "expansion", "saveBtn", "importBtn", "importFile", "mergeBtn", "replaceBtn"]) {
    assert.equal(page.get(id).disabled, true, id + " must not accept edits after failed recovery");
  }
  const libraryButtons = page.created.filter((node) => node.tag === "button");
  assert.equal(libraryButtons.length, 2);
  assert.ok(libraryButtons.every((node) => node.disabled), "library Edit/Delete must also be disabled");
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
