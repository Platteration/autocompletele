const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const library = [{ id: "one", trigger: "old/", expansion: "keep me", order: 0 }];

async function options(recoveryError = null, conflicts = [], readError = null) {
  const nodes = new Map(), created = [], downloads = [];
  function element(tag = "div") {
    const node = { tag, value: "", textContent: "", disabled: false, hidden: false, classList: { toggle() {}, add() {}, remove() {} }, handlers: {}, children: [],
      addEventListener(event, fn) { this.handlers[event] = fn; }, append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, setAttribute() {}, click() {}, remove() {}, focus() {},
      querySelectorAll() { return ["editId", "trigger", "expansion", "fieldName", "addFieldBtn", "variableToken", "addVariableBtn", "saveBtn", "cancelBtn"].map(get); },
    };
    created.push(node); return node;
  }
  function get(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
  const document = { activeElement: null, getElementById: get, querySelector() { return get("tbody"); }, createElement: element, createTextNode: (text) => ({ textContent: text }), body: element() };
  const storage = {
    DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" },
    async recoverPendingImport() { if (recoveryError) throw new Error(recoveryError); return { conflicts }; },
    async getAll() { if (readError) throw new Error(readError); return { shorthands: library, settings: { enabled: true, excludedHosts: [] } }; },
    toExportJson(shorthands) { return JSON.stringify({ shorthands }); },
  };
  const sandbox = { self: { ShorthandStorage: storage, ShorthandExpander: require("../src/expander.js"), ShorthandTemplate: require("../src/template.js"),
    ShorthandImportPlan: {}, ShorthandConflicts: { byTrigger() { return new Map(); } } }, document, Blob,
    URL: { createObjectURL(blob) { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    chrome: { storage: { onChanged: { addListener() {} } } }, setTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/options.js"), "utf8"), sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  return { get, created, downloads };
}

test("failed writer recovery still exports the readable library and disables all write controls", async () => {
  const page = await options("writer lock unavailable");
  page.get("exportBtn").handlers.click();
  const exported = JSON.parse(await page.downloads[0].text());
  assert.deepEqual(exported.shorthands, library, "recovery failure must not export an empty library");
  for (const id of ["enabled", "excluded", "pickerTrigger", "animationMode", "suggestionsEnabled", "trigger", "expansion", "fieldName", "addFieldBtn", "variableToken", "addVariableBtn", "saveBtn", "importBtn", "importFile", "mergeBtn", "replaceBtn"]) {
    assert.equal(page.get(id).disabled, true, id + " must not accept edits after failed recovery");
  }
  const libraryButtons = page.created.filter((node) => node.tag === "button");
  assert.equal(libraryButtons.length, 2);
  assert.ok(libraryButtons.every((node) => node.disabled), "library Edit/Delete must also be disabled");
  assert.equal(page.get("exportBtn").disabled, false);
  assert.equal(page.get("backupBtn").disabled, false);
  assert.match(page.get("ioMsg").textContent, /writer lock unavailable/);
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
