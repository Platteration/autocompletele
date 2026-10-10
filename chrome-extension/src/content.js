// Watches editable fields on the page and expands shorthands as they are typed.
// Pressing Backspace immediately after an expansion restores the trigger.
(function () {
  "use strict";

  const { findMatch, render } = self.ShorthandExpander;
  const storage = self.ShorthandStorage;

  let shorthands = [];
  let enabled = true;
  let hostExcluded = false;
  let pickerTrigger = storage.DEFAULT_SETTINGS.pickerTrigger;
  let suppress = false; // true while we are inserting text ourselves
  let lastExpansion = null; // details of the most recent expansion, for undo
  let inputGrant = null;
  const trustedEdits = new WeakMap();

  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", ""]);
  const IGNORE_ATTR = "data-shorthand-ignore";

  function isTextInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
    return false;
  }

  function isEditable(el) {
    return !!el && el.nodeType === 1 && el.isContentEditable;
  }

  function isIgnored(el) {
    return !!(el && el.closest && el.closest("[" + IGNORE_ATTR + "]"));
  }

  function isFocused(el) {
    const tree = el && el.getRootNode ? el.getRootNode() : document;
    const active = tree.activeElement;
    return !!el && (active === el || (isEditable(el) && el.contains(active)));
  }

  function editableTarget(el) {
    if (isEditable(el)) while (isEditable(el.parentElement)) el = el.parentElement;
    return el;
  }

  function editSnapshot(el) {
    if (isTextInput(el)) return { value: el.value, start: el.selectionStart, end: el.selectionEnd, node: null };
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node !== range.endContainer || !el.contains(node)) return null;
    if (node.nodeType !== Node.TEXT_NODE) {
      return el.textContent === "" && sel.isCollapsed ? { value: "", start: 0, end: 0, node: null, rootValue: "", offset: 0 } : null;
    }
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(node, range.startOffset);
    return { value: node.textContent, start: range.startOffset, end: range.endOffset,
      node, rootValue: el.textContent, offset: before.toString().length - range.startOffset };
  }

  function grantUserInput(ev) {
    inputGrant = null;
    if (!ev.isTrusted || ev.isComposing) return;
    const el = editableTarget(ev.target);
    if ((!isTextInput(el) && !isEditable(el)) || !isFocused(el) || isIgnored(el)) return;
    let data, inputType;
    if (ev.type === "paste" || ev.type === "drop") {
      const transfer = ev.clipboardData || ev.dataTransfer;
      if (!transfer) return;
      data = transfer.getData("text/plain");
      if (!data) return;
      if (isTextInput(el)) data = data.replace(/\r\n?/g, "\n");
      inputType = ev.type === "paste" ? "insertFromPaste" : "insertFromDrop";
    } else {
      if (!ev.key || Array.from(ev.key).length !== 1) return;
      data = ev.key;
      inputType = "insertText";
    }
    const before = editSnapshot(el);
    if (!before || before.start == null || before.end == null) return;
    inputGrant = { el, before, data, inputType, until: Date.now() + 1000 };
  }

  function consumeEdit(grant, ev, el) {
    if (!grant || grant.el !== el || grant.until < Date.now() || ev.isComposing || ev.inputType !== grant.inputType) return false;
    // Browser-trusted execCommand input must not substitute another edit for a physical key,
    // paste or drop. Text, original selection and the resulting value must all agree.
    if (grant.inputType === "insertText" && ev.data !== grant.data) return false;
    const before = grant.before;
    const expected = before.value.slice(0, before.start) + grant.data + before.value.slice(before.end);
    const live = editSnapshot(el);
    if (!live || live.value !== expected || live.start !== before.start + grant.data.length || live.end !== live.start) return false;
    if (isEditable(el)) {
      if (before.node && live.node !== before.node) return false;
      const rootExpected = before.rootValue.slice(0, before.offset + before.start) + grant.data + before.rootValue.slice(before.offset + before.end);
      if (el.textContent !== rootExpected) return false;
    }
    const previous = trustedEdits.get(el);
    const continuing = previous && previous.value === before.value && previous.node === before.node &&
      before.start >= previous.start && before.end <= previous.end;
    const start = continuing ? previous.start : before.start;
    const end = continuing ? previous.end + grant.data.length - (before.end - before.start) : live.start;
    trustedEdits.set(el, { value: live.value, node: live.node, start, end });
    return true;
  }

  function typedTrigger(el, start, end, node = null) {
    const edit = trustedEdits.get(el);
    return !!edit && edit.node === node && start >= edit.start && end <= edit.end;
  }

  async function reload() {
    try {
      const data = await storage.getAll();
      shorthands = data.shorthands.filter((s) => s.trigger);
      enabled = data.settings.enabled !== false;
      hostExcluded = (data.settings.excludedHosts || []).includes(location.hostname);
      pickerTrigger = typeof data.settings.pickerTrigger === "string"
        ? data.settings.pickerTrigger
        : storage.DEFAULT_SETTINGS.pickerTrigger;
    } catch (e) {
      // Extension context may be gone after an update/reload; stay quiet.
    }
  }

  function insertText(text) {
    try {
      return document.execCommand("insertText", false, text);
    } catch (_) {
      return false;
    }
  }

  // ---- input / textarea -----------------------------------------------------

  function replaceInField(el, start, end, text, caretOffset) {
    suppress = true;
    try {
      el.setSelectionRange(start, end);
      if (!insertText(text)) {
        // Fallback for fields where execCommand is not supported.
        el.setRangeText(text, start, end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const pos = start + caretOffset;
      el.setSelectionRange(pos, pos);
    } finally {
      suppress = false;
    }
  }

  function expandInField(el) {
    const caret = el.selectionStart;
    if (caret == null || caret !== el.selectionEnd) return false;
    const before = el.value.slice(0, caret);
    const match = findMatch(before, shorthands);
    if (!match || !typedTrigger(el, match.start, caret)) return false;

    const { text, cursorOffset } = render(match.shorthand.expansion);
    replaceInField(el, match.start, caret, text, cursorOffset);
    lastExpansion = { el, start: match.start, text, cursorOffset, trigger: match.shorthand.trigger };
    return true;
  }

  function undoInField(u) {
    const el = u.el;
    const caret = el.selectionStart;
    if (caret == null || caret !== el.selectionEnd) return false;
    if (caret !== u.start + u.cursorOffset) return false;
    if (el.value.slice(u.start, u.start + u.text.length) !== u.text) return false;
    replaceInField(el, u.start, u.start + u.text.length, u.trigger, u.trigger.length);
    return true;
  }

  // ---- contenteditable ------------------------------------------------------

  function replaceInNode(sel, node, start, end, text, caretBack) {
    suppress = true;
    try {
      const target = document.createRange();
      target.setStart(node, start);
      target.setEnd(node, end);
      sel.removeAllRanges();
      sel.addRange(target);
      if (!insertText(text)) {
        target.deleteContents();
        const tn = document.createTextNode(text);
        target.insertNode(tn);
        const after = document.createRange();
        after.setStart(tn, tn.length);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
        const root = node.parentElement && node.parentElement.closest("[contenteditable]");
        if (root) root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      // Move the caret back to the {cursor} position, if one was used.
      for (let i = 0; i < caretBack; i++) sel.modify("move", "backward", "character");
    } finally {
      suppress = false;
    }
  }

  function expandInContentEditable(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return false;

    const before = node.textContent.slice(0, range.startOffset);
    const match = findMatch(before, shorthands);
    if (!match || !typedTrigger(root, match.start, range.startOffset, node)) return false;

    const { text, cursorOffset } = render(match.shorthand.expansion);
    replaceInNode(sel, node, match.start, range.startOffset, text, text.length - cursorOffset);
    lastExpansion = { el: root, text, cursorOffset, trigger: match.shorthand.trigger };
    return true;
  }

  function undoInContentEditable(u) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !u.el.contains(node)) return false;
    // Only undo when the inserted text still sits, unchanged, around the caret in one text node.
    const head = u.text.slice(0, u.cursorOffset);
    const tail = u.text.slice(u.cursorOffset);
    const content = node.textContent;
    const start = range.startOffset - head.length;
    if (start < 0) return false;
    if (content.slice(start, range.startOffset) !== head) return false;
    if (content.slice(range.startOffset, range.startOffset + tail.length) !== tail) return false;
    replaceInNode(sel, node, start, range.startOffset + tail.length, u.trigger, 0);
    return true;
  }

  // ---- picker ---------------------------------------------------------------

  // The picker trigger is matched literally, with no word-boundary rule: it is
  // punctuation that does not occur naturally, and requiring a boundary would
  // stop it firing straight after a word.
  function pickerArmed() {
    return pickerTrigger && shorthands.length > 0 && self.ShorthandPicker && !self.ShorthandPicker.isOpen();
  }

  function tryOpenPickerInField(el) {
    if (!pickerArmed()) return false;
    const caret = el.selectionStart;
    if (caret == null || caret !== el.selectionEnd) return false;
    if (!el.value.slice(0, caret).endsWith(pickerTrigger)) return false;
    const start = caret - pickerTrigger.length;
    if (!typedTrigger(el, start, caret)) return false;
    const originalValue = el.value;

    // The trigger text stays in the field while the picker is open; choosing a
    // shorthand replaces it in one step, and cancelling leaves what was typed.
    return self.ShorthandPicker.show({
      shorthands,
      anchorEl: el,
      onPick(sh) {
        // A page may change the field or move focus while the panel is open.
        if (!isFocused(el) || isIgnored(el) || !isTextInput(el) || el.value !== originalValue || el.selectionStart !== caret || el.selectionEnd !== caret || el.value.slice(start, caret) !== pickerTrigger) return;
        const { text, cursorOffset } = render(sh.expansion);
        replaceInField(el, start, caret, text, cursorOffset);
        lastExpansion = { el, start, text, cursorOffset, trigger: pickerTrigger };
      },
    });
  }

  function tryOpenPickerInContentEditable(root) {
    if (!pickerArmed()) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return false;
    const end = range.startOffset;
    if (!node.textContent.slice(0, end).endsWith(pickerTrigger)) return false;
    const start = end - pickerTrigger.length;
    if (!typedTrigger(root, start, end, node)) return false;
    const originalValue = root.textContent;

    return self.ShorthandPicker.show({
      shorthands,
      anchorEl: root,
      onPick(sh) {
        if (!isFocused(root) || isIgnored(root) || root.textContent !== originalValue || !node.isConnected || !root.contains(node) || node.textContent.slice(start, end) !== pickerTrigger) return;
        const { text, cursorOffset } = render(sh.expansion);
        const liveSel = window.getSelection();
        if (!liveSel || !liveSel.isCollapsed || !liveSel.rangeCount) return;
        const liveRange = liveSel.getRangeAt(0);
        if (liveRange.startContainer !== node || liveRange.startOffset !== end) return;
        replaceInNode(liveSel, node, start, end, text, text.length - cursorOffset);
        lastExpansion = { el: root, text, cursorOffset, trigger: pickerTrigger };
      },
    });
  }

  // ---- wiring ---------------------------------------------------------------

  function onInput(ev) {
    // dispatchEvent() on a page-owned field must never release stored text.
    if (suppress || !ev.isTrusted) return;
    // execCommand can produce browser-trusted input without a real user
    // edit. Require, and consume, a recent exact trusted typing/paste/drop edit.
    const grant = inputGrant;
    inputGrant = null;
    lastExpansion = null;
    const el = editableTarget(ev.target);
    if (!isFocused(el) || isIgnored(el) || !consumeEdit(grant, ev, el)) {
      if (el) trustedEdits.delete(el);
      return;
    }
    if (self.ShorthandPicker && self.ShorthandPicker.isOpen()) return;
    if (!enabled || hostExcluded || shorthands.length === 0) return;
    if (ev.isComposing) return; // IME composition in progress
    const t = ev.inputType;
    if (t && !t.startsWith("insert")) return; // only react to typing/pasting
    // A user's own shorthand always wins over the picker trigger.
    if (isTextInput(el)) {
      if (!expandInField(el)) tryOpenPickerInField(el);
    } else if (isEditable(el)) {
      if (!expandInContentEditable(el)) tryOpenPickerInContentEditable(el);
    }
  }

  function onKeyDown(ev) {
    if (!ev.isTrusted || !isFocused(ev.target)) return;
    // The picker registers its own capture handler later, so this one runs
    // first; while it is open every key belongs to it.
    if (self.ShorthandPicker && self.ShorthandPicker.isOpen()) return;
    const altGraph = ev.getModifierState && ev.getModifierState("AltGraph");
    inputGrant = null;
    if ((!ev.ctrlKey && !ev.metaKey && !ev.altKey || altGraph) && !ev.isComposing && Array.from(ev.key).length === 1) grantUserInput(ev);
    const u = lastExpansion;
    if (!u) return;
    if (ev.key !== "Backspace" || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) {
      // Any other key (except plain modifiers) means the user moved on.
      if (!["Shift", "Control", "Alt", "Meta"].includes(ev.key)) lastExpansion = null;
      return;
    }
    if (ev.target !== u.el) { lastExpansion = null; return; }
    lastExpansion = null;
    const done = isTextInput(u.el) ? undoInField(u) : undoInContentEditable(u);
    if (done) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  document.addEventListener("input", onInput, true);
  document.addEventListener("keydown", onKeyDown, true);
  for (const event of ["paste", "drop"]) document.addEventListener(event, grantUserInput, true);
  // Composition changes and rich/automatic edits cannot be tied to an exact physical insertion.
  for (const event of ["compositionstart", "compositionupdate", "compositionend"]) document.addEventListener(event, () => { inputGrant = null; }, true);
  document.addEventListener("mousedown", () => { lastExpansion = null; }, true);

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "sync") reload();
  });

  reload();
})();
