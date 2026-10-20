const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const premiumConfig = { enforceDailyLimit: false };
function previewClient() {
  return require("../src/premium-client.js").createClient({
    config: premiumConfig,
    chrome: { runtime: { async sendMessage() { return { ok: true, result: {} }; } } },
    notice() {},
  });
}

async function content({ premium = previewClient(), config = premiumConfig, storage, form, feedback, runtime = { id: "actle-test" } } = {}) {
  const listeners = {}, opened = [];
  const document = { activeElement: null, addEventListener(name, fn) { listeners[name] = fn; }, execCommand() { return false; } };
  const sandbox = {
    self: {
      ActlePremium: premium, ActlePremiumConfig: config,
      ShorthandExpander: require("../src/expander.js"),
      ShorthandFieldSafety: require("../src/field-safety.js"),
      ShorthandSuggestions: require("../src/suggestions.js"),
      ShorthandTemplate: require("../src/template.js"),
      ShorthandTemplateForm: form || { isOpen() { return false; }, show() { return false; } },
      ShorthandExpansionFeedback: feedback || { show() {}, clear() {} },
      ShorthandStorage: storage || { DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" }, async getAll() { return { shorthands: [{ trigger: "secret/", expansion: "private snippet" }], settings: {} }; } },
      ShorthandPicker: { isOpen() { return false; }, show(opts) { opened.push(opts); return true; } },
    },
    document, window: { addEventListener() {} }, location: { hostname: "page.example" }, chrome: { runtime, storage: { onChanged: { addListener() {} } } }, Event: class {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8"), sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  const field = {
    tagName: "TEXTAREA", value: "", selectionStart: 0, selectionEnd: 0, isConnected: true,
    focus() { document.activeElement = this; },
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

test("a page left open after actle is updated or removed stops expanding and asks once for a reload", async () => {
  // Chrome keeps the old script running in open pages, cut off from storage:
  // its cached library and pause or site choices may no longer be true.
  const notices = [];
  const premium = require("../src/premium-client.js").createClient({
    config: premiumConfig, chrome: { runtime: {} }, notice(message) { notices.push(message); },
  });
  const runtime = { id: "actle-test" };
  const c = await content({ premium, runtime });
  delete runtime.id;
  c.input("secret/", true);
  assert.equal(c.field.value, "secret/", "a disconnected script inserts nothing");
  c.input(";;", true);
  assert.equal(c.opened.length, 0, "nor opens the library picker");
  assert.deepEqual(notices, ["actle was updated or turned off. Reload this page to use your shortcuts here."]);
  c.input("x secret/", true);
  assert.equal(notices.length, 1, "the reload message appears once per page");

  const quiet = [];
  const unrelated = await content({ premium: require("../src/premium-client.js").createClient({
    config: premiumConfig, chrome: { runtime: {} }, notice(message) { quiet.push(message); } }), runtime: {} });
  unrelated.input("hello there", true);
  assert.deepEqual(quiet, [], "ordinary typing in a stale page shows nothing");
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

test("a successful expansion records one local use for ranking", async () => {
  const recorded = [];
  const c = await content({
    storage: {
      DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" },
      async getAll() { return { shorthands: [{ id: "s1", trigger: "secret/", expansion: "private snippet" }], settings: {} }; },
      async getUsageCounts() { return {}; },
      recordUse(id) { recorded.push(id); },
    },
  });
  c.input("secret/", true);
  assert.equal(c.field.value, "private snippet");
  assert.deepEqual(recorded, ["s1"]);
  c.input("secret/", false);
  assert.equal(c.field.value, "secret/");
  assert.deepEqual(recorded, ["s1"], "fabricated input must not record a use");
});

// The library page's duplicate-trigger warning (src/conflicts.js) describes
// this: the most used of the two in this browser expands, the first in library
// order when their counts are tied, and never the other one.
test("of two shorthands with one trigger, the most used expands, else the first in the library", async () => {
  const library = [
    { id: "first", trigger: "dup/", expansion: "first one", order: 0 },
    { id: "second", trigger: "dup/", expansion: "second one", order: 1 },
  ];
  for (const [counts, expected] of [[{}, "first one"], [{ first: 2, second: 2 }, "first one"], [{ first: 1, second: 3 }, "second one"]]) {
    const c = await content({
      storage: {
        DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" },
        async getAll() { return { shorthands: library, settings: {} }; },
        async getUsageCounts() { return counts; },
        recordUse() {},
      },
    });
    c.input("dup/", true);
    assert.equal(c.field.value, expected, JSON.stringify(counts));
  }
});

test("the final DOM check stops changes queued after asynchronous quota validation", async (t) => {
  const scenarios = [
    { name: "the page replaces the draft", change(field) {
      field.value = "Updated page draft";
      field.selectionStart = field.selectionEnd = field.value.length;
    }, expected: "Updated page draft" },
    { name: "the page identifies a credential field", change(field) {
      field.getAttribute = (name) => name === "autocomplete" ? "username" : "";
    }, expected: "secret/" },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async () => {
    const config = { enforceDailyLimit: true };
    const messages = [];
    const client = require("../src/premium-client.js").createClient({
      config,
      chrome: { runtime: { async sendMessage(message) {
        messages.push(message);
        return { ok: true, result: message.action === "claim"
          ? { approved: true, id: "reserved-use" } : { finished: true } };
      } } },
      notice() {},
    });
    let c, completion, validations = 0, lastValidation;
    const premium = { execute(action, validate, options) {
      completion = client.execute(action, async () => {
        const valid = await validate();
        if (++validations === 2) {
          lastValidation = valid;
          // The original validation already read the live settings, metadata
          // and selection. A page microtask runs before insertion resumes.
          queueMicrotask(() => scenario.change(c.field));
        }
        return valid;
      }, options);
      return completion;
    } };
    c = await content({ premium, config });
    let writes = 0;
    const setRangeText = c.field.setRangeText;
    c.field.setRangeText = function (...args) { writes++; return setRangeText.apply(this, args); };
    c.input("secret/", true);
    const inserted = await completion;
    assert.equal(validations, 2);
    assert.equal(lastValidation, true, "the asynchronous validation accepted the original target");
    assert.equal(writes, 0, "the final synchronous guard must prevent the editor mutation");
    assert.equal(c.field.value, scenario.expected);
    assert.equal(inserted, false);
    assert.deepEqual(messages, [
      { type: "actle-premium", action: "claim" },
      { type: "actle-premium", action: "finish", id: "reserved-use", success: false },
    ]);
  });
});

test("template confirmation uses freshly saved animation settings without a storage event", async (t) => {
  for (const [cachedMode, savedMode] of [["casino", "off"], ["off", "casino"]]) {
    await t.test(`${cachedMode} changes to ${savedMode} while the form is open`, async () => {
      let animationMode = cachedMode, reads = 0, formOptions;
      const snippet = { trigger: "hello/", expansion: "Hi [[name]]!" };
      const shown = [];
      const c = await content({
        storage: {
          DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" },
          async getAll() {
            reads++;
            return { shorthands: [snippet], settings: { animationMode } };
          },
        },
        form: {
          isOpen() { return !!formOptions; },
          show(options) { formOptions = options; return true; },
        },
        feedback: { show(element, details) { shown.push({ element, details }); }, clear() {} },
      });
      c.input("hello/", true);
      assert.equal(reads, 1, "the content script cached the original animation setting");
      assert.equal(c.field.value, "hello/");
      assert.equal(shown.length, 0);
      assert.equal(formOptions.expansion, snippet.expansion);
      c.document.activeElement = { tagName: "INPUT" }; // The template form owns focus.
      animationMode = savedMode; // No storage.onChanged event updates the cached mode.
      const result = require("../src/template.js").render(snippet.expansion, { name: "Maya" });
      assert.equal(await formOptions.onSubmit(result), true);
      assert.equal(reads, 2, "confirmation reads the newly saved settings");
      assert.equal(c.field.value, "Hi Maya!");
      assert.equal(c.field.selectionStart, 8);
      assert.equal(c.field.selectionEnd, 8);
      assert.equal(c.document.activeElement, c.field);
      assert.equal(shown.length, 1);
      assert.equal(shown[0].element, c.field);
      assert.equal(shown[0].details.mode, savedMode);
      assert.equal(shown[0].details.text, "Hi Maya!");
      assert.equal(shown[0].details.trigger, "hello/");
    });
  }
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

// A rich editor with one text node, the way Chrome edits a plain contenteditable:
// a trailing space is stored as U+00A0 and becomes U+0020 once more text follows.
async function richContent() {
  const listeners = {};
  let textNode = { nodeType: 3, textContent: "", isConnected: true };
  const root = { nodeType: 1, tagName: "DIV", isContentEditable: true, parentElement: null, isConnected: true,
    get textContent() { return textNode.textContent; }, contains(node) { return node === textNode || node === root; },
    closest() { return null; }, getRootNode() { return document; }, dispatchEvent() {}, focus() {} };
  textNode.parentElement = textNode.parentNode = root;
  let selStart = 0, selEnd = 0;
  const selection = {
    rangeCount: 1, get isCollapsed() { return selStart === selEnd; },
    getRangeAt() { return { startContainer: textNode, endContainer: textNode, startOffset: selStart, endOffset: selEnd, collapsed: selStart === selEnd }; },
    removeAllRanges() {}, addRange(range) { selStart = range.start; selEnd = range.end; },
    collapse(_node, offset) { selStart = selEnd = offset; }, modify() {},
  };
  const document = {
    activeElement: root, addEventListener(name, fn) { listeners[name] = fn; },
    createRange() {
      const range = { start: 0, end: 0,
        setStart(_node, offset) { range.start = offset; }, setEnd(_node, offset) { range.end = offset; },
        selectNodeContents() { range.start = 0; range.end = textNode.textContent.length; },
        collapse(toStart) { if (toStart) range.end = range.start; else range.start = range.end; },
        toString() { return textNode.textContent.slice(range.start, range.end); } };
      return range;
    },
    execCommand(name, _ui, text) {
      if (name !== "insertText") return false;
      textNode.textContent = textNode.textContent.slice(0, selStart) + text + textNode.textContent.slice(selEnd);
      selStart = selEnd = selStart + text.length;
      return true;
    },
  };
  const sandbox = {
    self: {
      ActlePremium: previewClient(), ActlePremiumConfig: premiumConfig,
      ShorthandExpander: require("../src/expander.js"),
      ShorthandFieldSafety: require("../src/field-safety.js"),
      ShorthandSuggestions: require("../src/suggestions.js"),
      ShorthandStorage: { DEFAULT_SETTINGS: { pickerTrigger: ";;", animationMode: "expand" }, async getAll() { return { shorthands: [{ trigger: "cool/", expansion: "That is really cool!" }], settings: {} }; } },
      ShorthandPicker: { isOpen() { return false; }, show() { return true; } },
      ShorthandTemplate: require("../src/template.js"),
      ShorthandTemplateForm: { isOpen() { return false; }, show() { return false; } },
      ShorthandExpansionFeedback: { show() {}, clear() {} },
    },
    document, window: { getSelection() { return selection; }, addEventListener() {} }, location: { hostname: "page.example" },
    chrome: { runtime: { id: "actle-test" }, storage: { onChanged: { addListener() {} } } }, Event: class {}, InputEvent: class {}, Node: { TEXT_NODE: 3 },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8"), sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  // One physical key: the browser then rewrites the text node to `resulting`.
  function type(key, resulting) {
    listeners.keydown({ target: root, type: "keydown", isTrusted: true, key });
    textNode.textContent = resulting;
    selStart = selEnd = selStart + 1;
    listeners.input({ target: root, isTrusted: true, inputType: "insertText", data: key });
  }
  // The page replaces the text node with a copy, as ProseMirror does after the
  // first character of a line. `keepOld` leaves the typed node on the page.
  function redraw(text = textNode.textContent, keepOld = false) {
    const old = textNode;
    textNode = { nodeType: 3, textContent: text, isConnected: true, parentElement: root, parentNode: root };
    if (!keepOld) old.isConnected = false;
  }
  // A Backspace key press; the browser then leaves `resulting` with the caret
  // `removed` characters further left. `trusted` false models a page's own key.
  function erase(resulting, removed = 1, trusted = true) {
    listeners.keydown({ target: root, type: "keydown", isTrusted: trusted, key: "Backspace" });
    textNode.textContent = resulting;
    selStart = selEnd = selStart - removed;
    listeners.input({ target: root, isTrusted: true, inputType: "deleteContentBackward", data: null });
  }
  // Text the page itself wrote, with the caret placed after it.
  function prefill(text) {
    textNode.textContent = text;
    selStart = selEnd = text.length;
  }
  return { get textNode() { return textNode; }, type, redraw, erase, prefill };
}

test("a trigger typed after a space in a rich editor still expands despite the browser's nbsp rewriting", async () => {
  const c = await richContent();
  c.type("a", "a");
  c.type(" ", "a\u00a0");
  c.type("c", "a c");
  for (const [key, text] of [["o", "a co"], ["o", "a coo"], ["l", "a cool"], ["/", "a cool/"]]) c.type(key, text);
  assert.equal(c.textNode.textContent, "a That is really cool!");
});

test("a trigger typed first in an editor that redraws the line after its first character still expands", async () => {
  const c = await richContent();
  c.type("c", "c");
  c.redraw();
  for (const [key, text] of [["o", "co"], ["o", "coo"], ["l", "cool"], ["/", "cool/"]]) c.type(key, text);
  assert.equal(c.textNode.textContent, "That is really cool!");
});

test("a redraw continues typing only when the typed node left the page with its text unchanged", async () => {
  const kept = await richContent();
  kept.type("c", "c");
  kept.redraw("c", true);
  for (const [key, text] of [["o", "co"], ["o", "coo"], ["l", "cool"], ["/", "cool/"]]) kept.type(key, text);
  assert.equal(kept.textNode.textContent, "cool/", "a second node beside the typed one is not the typed text");

  const changed = await richContent();
  changed.type("x", "x");
  changed.redraw("c");
  for (const [key, text] of [["o", "co"], ["o", "coo"], ["l", "cool"], ["/", "cool/"]]) changed.type(key, text);
  assert.equal(changed.textNode.textContent, "cool/", "a page-written first character is not typed text");
});

test("a typo corrected with Backspace still lets the trigger expand", async () => {
  const c = await richContent();
  for (const [key, text] of [["c", "c"], ["o", "co"], ["x", "cox"]]) c.type(key, text);
  c.erase("co");
  for (const [key, text] of [["o", "coo"], ["l", "cool"], ["/", "cool/"]]) c.type(key, text);
  assert.equal(c.textNode.textContent, "That is really cool!");
});

test("only a physical Backspace that removed exactly one character keeps the typed run", async () => {
  const fabricated = await richContent();
  for (const [key, text] of [["c", "c"], ["o", "co"], ["x", "cox"]]) fabricated.type(key, text);
  fabricated.erase("co", 1, false);
  for (const [key, text] of [["o", "coo"], ["l", "cool"], ["/", "cool/"]]) fabricated.type(key, text);
  assert.equal(fabricated.textNode.textContent, "cool/", "a page's own Backspace event grants nothing");

  const extra = await richContent();
  for (const [key, text] of [["c", "c"], ["o", "co"], ["o", "coo"], ["x", "coox"]]) extra.type(key, text);
  extra.erase("co", 2);
  for (const [key, text] of [["o", "coo"], ["l", "cool"], ["/", "cool/"]]) extra.type(key, text);
  assert.equal(extra.textNode.textContent, "cool/", "a key press cannot cover a page deleting more than one character");
});

test("a page cannot swap in its own text during a physical Backspace in a text field", async () => {
  const c = await content();
  const key = (k, value) => {
    c.document.activeElement = c.field;
    c.listeners.keydown({ target: c.field, type: "keydown", isTrusted: true, key: k });
    c.field.value = value; c.field.selectionStart = c.field.selectionEnd = value.length;
    c.listeners.input({ target: c.field, isTrusted: true, inputType: k === "Backspace" ? "deleteContentBackward" : "insertText", data: k === "Backspace" ? null : k });
  };
  let typed = "";
  for (const k of "zzzzzz") key(k, typed += k);
  key("Backspace", "secre"); // the caret moved back one, but the page rewrote the rest
  key("t", "secret");
  key("/", "secret/");
  assert.equal(c.field.value, "secret/", "page-written letters never become a trusted trigger");
});

test("Backspace cannot stretch the typed run over text the page wrote", async () => {
  const c = await richContent();
  c.prefill("co");
  c.type("x", "cox");
  c.erase("co");
  c.erase("c");
  for (const [key, text] of [["o", "co"], ["o", "coo"], ["l", "cool"], ["/", "cool/"]]) c.type(key, text);
  assert.equal(c.textNode.textContent, "cool/", "the page-written c stays outside the trusted run");
});

test("the nbsp allowance does not let a page swap in different text for a keystroke", async () => {
  const c = await richContent();
  c.type("a", "a");
  c.type(" ", "a\u00a0");
  for (const [key, text] of [["c", "a c"], ["o", "a co"], ["o", "a coo"], ["l", "a cool"]]) c.type(key, text);
  c.type("/", "a cool/x");
  assert.equal(c.textNode.textContent, "a cool/x");
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
  const sandbox = { self: {}, document, window: { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} }, CSSStyleSheet: class { replaceSync() {} } };
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
