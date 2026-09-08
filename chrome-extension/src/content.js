// Watches editable fields on the page and expands shorthands as they are typed.
(function () {
  "use strict";

  const { findMatch, render } = self.ShorthandExpander;
  const storage = self.ShorthandStorage;

  let shorthands = [];
  let enabled = true;
  let hostExcluded = false;
  let suppress = false; // true while we are inserting text ourselves

  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", ""]);

  function isTextInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
    return false;
  }

  function isEditable(el) {
    return !!el && el.nodeType === 1 && el.isContentEditable;
  }

  async function reload() {
    try {
      const data = await storage.getAll();
      shorthands = data.shorthands.filter((s) => s.trigger);
      enabled = data.settings.enabled !== false;
      hostExcluded = (data.settings.excludedHosts || []).includes(location.hostname);
    } catch (e) {
      // Extension context may be gone after an update/reload; stay quiet.
    }
  }

  // ---- input / textarea -----------------------------------------------------

  function expandInField(el) {
    const caret = el.selectionStart;
    if (caret == null || caret !== el.selectionEnd) return false;
    const before = el.value.slice(0, caret);
    const match = findMatch(before, shorthands);
    if (!match) return false;

    const { text, cursorOffset } = render(match.shorthand.expansion);
    suppress = true;
    try {
      el.setSelectionRange(match.start, caret);
      let ok = false;
      try {
        ok = document.execCommand("insertText", false, text);
      } catch (_) {
        ok = false;
      }
      if (!ok) {
        // Fallback for fields where execCommand is not supported.
        el.setRangeText(text, match.start, caret, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const pos = match.start + cursorOffset;
      el.setSelectionRange(pos, pos);
    } finally {
      suppress = false;
    }
    return true;
  }

  // ---- contenteditable ------------------------------------------------------

  function expandInContentEditable(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return false;

    const before = node.textContent.slice(0, range.startOffset);
    const match = findMatch(before, shorthands);
    if (!match) return false;

    const { text, cursorOffset } = render(match.shorthand.expansion);
    suppress = true;
    try {
      const target = document.createRange();
      target.setStart(node, match.start);
      target.setEnd(node, range.startOffset);
      sel.removeAllRanges();
      sel.addRange(target);
      let ok = false;
      try {
        ok = document.execCommand("insertText", false, text);
      } catch (_) {
        ok = false;
      }
      if (!ok) {
        target.deleteContents();
        const tn = document.createTextNode(text);
        target.insertNode(tn);
        const after = document.createRange();
        after.setStart(tn, tn.length);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
        root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      // Move the caret back to the {cursor} position, if one was used.
      const back = text.length - cursorOffset;
      for (let i = 0; i < back; i++) sel.modify("move", "backward", "character");
    } finally {
      suppress = false;
    }
    return true;
  }

  // ---- wiring ---------------------------------------------------------------

  function onInput(ev) {
    if (suppress || !enabled || hostExcluded || shorthands.length === 0) return;
    if (ev.isComposing) return; // IME composition in progress
    const t = ev.inputType;
    if (t && !t.startsWith("insert")) return; // only react to typing/pasting
    const el = ev.target;
    if (isTextInput(el)) {
      expandInField(el);
    } else if (isEditable(el)) {
      expandInContentEditable(el);
    }
  }

  document.addEventListener("input", onInput, true);

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "sync") reload();
  });

  reload();
})();
