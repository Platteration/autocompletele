const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function content() {
  const listeners = {}, opened = [];
  const document = { activeElement: null, addEventListener(name, fn) { listeners[name] = fn; }, execCommand() { return false; } };
  const sandbox = {
    self: {
      ShorthandExpander: require("../src/expander.js"),
      ShorthandStorage: { DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" }, async getAll() { return { shorthands: [{ trigger: "secret/", expansion: "private snippet" }], settings: {} }; } },
      ShorthandPicker: { isOpen() { return false; }, show(opts) { opened.push(opts); return true; } },
      ShorthandTemplate: require("../src/template.js"),
      ShorthandTemplateForm: { isOpen() { return false; }, show() { return false; } },
      ShorthandExpansionFeedback: { show() {}, clear() {} },
    },
    document, window: {}, location: { hostname: "page.example" }, chrome: { storage: { onChanged: { addListener() {} } } }, Event: class {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8"), sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  const field = {
    tagName: "TEXTAREA", value: "", selectionStart: 0, selectionEnd: 0,
    closest() { return null; }, getRootNode() { return document; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); }, dispatchEvent() {},
  };
  function input(text, trusted, focused = true, userEdit = true) {
    document.activeElement = focused ? field : null;
    if (trusted && userEdit) {
      field.selectionStart = 0; field.selectionEnd = field.value.length;
      listeners.paste({ target: field, type: "paste", isTrusted: true, clipboardData: { getData() { return text; } } });
    }
    field.value = text; field.selectionStart = field.selectionEnd = text.length;
    listeners.input({ target: field, isTrusted: trusted, inputType: userEdit ? "insertFromPaste" : "insertText", data: text });
  }
  return { field, document, listeners, opened, input };
}

test("fabricated input cannot expand a known snippet or open the library picker", async () => {
  const c = await content();
  c.input("secret/", false);
  assert.equal(c.field.value, "secret/");
  c.input(";;", false);
  assert.equal(c.opened.length, 0);
});

test("browser-trusted scripted edits also need a preceding trusted user edit", async () => {
  const c = await content();
  c.input("secret/", true, true, false);
  assert.equal(c.field.value, "secret/");
  c.input(";;", true, true, false);
  assert.equal(c.opened.length, 0);
});

test("trusted paste permits one edit, but its grant cannot be replayed", async () => {
  const c = await content();
  c.document.activeElement = c.field;
  c.listeners.paste({ target: c.field, type: "paste", isTrusted: true, clipboardData: { getData() { return "secret/"; } } });
  c.field.value = "secret/"; c.field.selectionStart = c.field.selectionEnd = 7;
  c.listeners.input({ target: c.field, isTrusted: true, inputType: "insertFromPaste", data: null });
  assert.equal(c.field.value, "private snippet");
  c.input("secret/", true, true, false);
  assert.equal(c.field.value, "secret/");
});

test("trusted input only expands the actively focused editable field", async () => {
  const c = await content();
  c.input("secret/", true, false);
  assert.equal(c.field.value, "secret/");
  c.input("secret/", true);
  assert.equal(c.field.value, "private snippet");
});

test("picker insertion rechecks focus, caret and the original trigger", async () => {
  const c = await content();
  c.input(";;", true);
  assert.equal(c.opened.length, 1);
  c.document.activeElement = null;
  c.opened[0].onPick({ expansion: "private snippet" });
  assert.equal(c.field.value, ";;");
  c.document.activeElement = c.field;
  c.field.value = "xx";
  c.opened[0].onPick({ expansion: "private snippet" });
  assert.equal(c.field.value, "xx");
  c.field.value = ";;";
  c.opened[0].onPick({ expansion: "private snippet" });
  assert.equal(c.field.value, "private snippet");
});

test("fabricated Backspace cannot undo a trusted expansion", async () => {
  const c = await content();
  c.input("secret/", true);
  c.listeners.keydown({ target: c.field, isTrusted: false, key: "Backspace" });
  assert.equal(c.field.value, "private snippet");
});

function picker() {
  const handlers = {}, parts = {};
  function element() {
    return {
      dataset: {}, style: {}, textContent: "", parentNode: null,
      append() {}, appendChild() {}, setAttribute() {},
      addEventListener(name, fn) { this[name] = fn; },
      querySelector() { return null; }, getBoundingClientRect() { return { width: 10, height: 10, bottom: 10, left: 0 }; },
    };
  }
  const document = {
    activeElement: null,
    createElement() {
      const el = element();
      el.attachShadow = () => ({ set innerHTML(_) {}, querySelector(selector) { return parts[selector] || (parts[selector] = element()); } });
      return el;
    },
    addEventListener(name, fn) { handlers[name] = fn; }, removeEventListener(name) { delete handlers[name]; },
    body: { appendChild(el) { el.parentNode = this; }, removeChild(el) { el.parentNode = null; } },
  };
  // The picker styles its closed shadow root with a constructed stylesheet.
  const sandbox = { self: {}, document, CSSStyleSheet: class { replaceSync() {} }, window: { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/picker.js"), "utf8"), sandbox);
  const anchor = { getRootNode() { return document; }, getBoundingClientRect() { return { width: 10, height: 10, bottom: 10, left: 0 }; } };
  document.activeElement = anchor;
  const picked = [];
  const api = sandbox.self.ShorthandPicker;
  api.show({ shorthands: [{ trigger: "secret/", expansion: "private snippet" }], anchorEl: anchor, onPick(sh) { picked.push(sh); } });
  const key = (name, trusted) => handlers.keydown({ key: name, isTrusted: trusted, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  return { api, picked, key, parts, document, anchor };
}

test("fabricated picker keys cannot reveal a snippet; a trusted selection still works", () => {
  const p = picker();
  p.key("ArrowDown", false);
  p.key("Enter", false);
  assert.equal(p.picked.length, 0);
  assert.equal(p.api.isOpen(), true);
  p.key("Enter", true);
  assert.equal(p.picked.length, 1);
});

test("picker mouse selection also requires a trusted event and unchanged focus", () => {
  const p = picker();
  const event = (trusted) => ({ isTrusted: trusted, preventDefault() {}, target: { closest() { return { dataset: { index: "0" } }; } } });
  p.parts[".list"].mousedown(event(false));
  assert.equal(p.picked.length, 0);
  p.document.activeElement = null;
  p.parts[".list"].mousedown(event(true));
  assert.equal(p.picked.length, 0);
  p.document.activeElement = p.anchor;
  p.parts[".list"].mousedown(event(true));
  assert.equal(p.picked.length, 1);
});


test("a page cannot spend a physical keystroke on a different execCommand insertion", async () => {
  const c = await content();
  c.document.activeElement = c.field;
  c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key: "a" });
  c.input("secret/", true, true, false);
  assert.equal(c.field.value, "secret/");
  assert.equal(c.opened.length, 0);
});

test("a paste grant cannot authorize a script's insertText command", async () => {
  const c = await content();
  c.document.activeElement = c.field;
  c.listeners.paste({ target: c.field, type: "paste", isTrusted: true, clipboardData: { getData() { return "ordinary text"; } } });
  c.input("secret/", true, true, false);
  assert.equal(c.field.value, "secret/");
});

test("only the full user-inserted trigger can expand, not a page-prefilled prefix", async () => {
  const c = await content();
  c.document.activeElement = c.field;
  c.field.value = "secret"; c.field.selectionStart = c.field.selectionEnd = 6;
  c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key: "/" });
  c.field.value += "/"; c.field.selectionStart = c.field.selectionEnd = 7;
  c.listeners.input({ target: c.field, isTrusted: true, inputType: "insertText", data: "/" });
  assert.equal(c.field.value, "secret/");
  c.field.value = ""; c.field.selectionStart = c.field.selectionEnd = 0;
  for (const key of "secret/") {
    c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key });
    c.field.value += key; c.field.selectionStart = c.field.selectionEnd = c.field.value.length;
    c.listeners.input({ target: c.field, isTrusted: true, inputType: "insertText", data: key });
  }
  assert.equal(c.field.value, "private snippet");
});

test("changing the field around an open picker trigger cancels insertion", async () => {
  const c = await content(); c.input("before;;", true);
  c.field.value = "mutate;;"; c.field.selectionStart = c.field.selectionEnd = 8;
  c.opened[0].onPick({ expansion: "private snippet" });
  assert.equal(c.field.value, "mutate;;");
});

test("matching InputEvent.data cannot disguise a substituted value or selection", async () => {
  const c = await content();
  c.document.activeElement = c.field;
  c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key: "/" });
  c.field.value = "secret/"; c.field.selectionStart = c.field.selectionEnd = 7;
  c.listeners.input({ target: c.field, isTrusted: true, inputType: "insertText", data: "/" });
  assert.equal(c.field.value, "secret/");
  c.field.value = "secret"; c.field.selectionStart = 0; c.field.selectionEnd = 6;
  c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key: "/" });
  c.field.value = "secret/"; c.field.selectionStart = c.field.selectionEnd = 7;
  c.listeners.input({ target: c.field, isTrusted: true, inputType: "insertText", data: "/" });
  assert.equal(c.field.value, "secret/");
});

test("plain text drop and physical AltGraph typing retain expansion", async () => {
  const c = await content();
  c.document.activeElement = c.field;
  c.listeners.drop({ target: c.field, type: "drop", isTrusted: true, dataTransfer: { getData() { return "secret/"; } } });
  c.field.value = "secret/"; c.field.selectionStart = c.field.selectionEnd = 7;
  c.listeners.input({ target: c.field, isTrusted: true, inputType: "insertFromDrop", data: null });
  assert.equal(c.field.value, "private snippet");
  c.field.value = ""; c.field.selectionStart = c.field.selectionEnd = 0;
  for (const key of "secret/") {
    c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key, ctrlKey: true, altKey: true, getModifierState(name) { return name === "AltGraph"; } });
    c.field.value += key; c.field.selectionStart = c.field.selectionEnd = c.field.value.length;
    c.listeners.input({ target: c.field, isTrusted: true, inputType: "insertText", data: key });
  }
  assert.equal(c.field.value, "private snippet");
});

test("IME and automatic edits cannot leave a reusable typing grant", async () => {
  const c = await content();
  c.document.activeElement = c.field;
  c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key: "a" });
  c.listeners.compositionstart({ target: c.field, isTrusted: true });
  c.input("secret/", true, true, false);
  assert.equal(c.field.value, "secret/");
});
