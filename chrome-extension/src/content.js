// Watches editable fields on the page and expands shorthands as they are typed.
// Pressing Backspace immediately after an expansion restores the trigger.
(function () {
  "use strict";

  const { findMatch } = self.ShorthandExpander;
  const storage = self.ShorthandStorage;
  const template = self.ShorthandTemplate;
  const templateForm = self.ShorthandTemplateForm;

  let shorthands = [];
  let enabled = true;
  let hostExcluded = false;
  let pickerTrigger = storage.DEFAULT_SETTINGS.pickerTrigger;
  let suppress = false; // true while we are inserting text ourselves
  let lastExpansion = null; // details of the most recent expansion, for undo
  let templateTarget = null; // original insertion point while a fill-in form has focus

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

  // The fill-in form takes focus. Keep the original text and insertion point,
  // then check them again before restoring focus: a page may save or replace
  // its editor on blur, or receive an update while the form is being filled.
  function fieldTarget(el, start, end, trigger) {
    return { el, start, end, trigger, value: el.value };
  }

  function nodeTarget(el, node, start, end, trigger) {
    return {
      el, node, start, end, trigger,
      parent: node.parentNode,
      value: node.textContent,
      rootText: el.textContent,
    };
  }

  function targetUnchanged(target, checkSelection = true) {
    const { el, node, end } = target;
    if (!el.isConnected || isIgnored(el)) return false;
    if (!node) {
      if (!isTextInput(el) || el.value !== target.value) return false;
      return !checkSelection || (el.selectionStart === end && el.selectionEnd === end);
    }
    if (!isEditable(el) || !node.isConnected || !el.contains(node) || isIgnored(node.parentElement)
        || !isEditable(node.parentElement) || node.parentNode !== target.parent
        || node.textContent !== target.value || el.textContent !== target.rootText) return false;
    if (!checkSelection) return true;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return true;
    const range = sel.getRangeAt(0);
    // Browsers differ on whether focusing a shadow-root field moves the page
    // selection. A selection still inside the original editor must be intact.
    if (!el.contains(range.startContainer) && !el.contains(range.endContainer)) return true;
    return sel.isCollapsed && range.startContainer === node && range.startOffset === end;
  }

  function restoreTarget(target) {
    if (!targetUnchanged(target)) return false;
    target.el.focus({ preventScroll: true });
    // A focus handler can itself change or remove the editor.
    if (document.activeElement !== target.el || !targetUnchanged(target, false)) return false;
    if (target.node) {
      const sel = window.getSelection();
      if (!sel) return false;
      const range = document.createRange();
      range.setStart(target.node, target.end);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      target.el.setSelectionRange(target.end, target.end);
    }
    return true;
  }

  function fillTemplate(shorthand, target) {
    if (!template.fields(shorthand.expansion).length) return false;
    if (templateTarget || templateForm.isOpen()) return true;
    templateTarget = target;
    lastExpansion = null;
    const shown = templateForm.show({
      trigger: shorthand.trigger,
      expansion: shorthand.expansion,
      actionLabel: "Insert text",
      anchorEl: target.el,
      async onSubmit(result) {
        let settings;
        try {
          ({ settings } = await storage.getAll());
        } catch (_) {
          return "Could not check your settings. Cancel this form and try again.";
        }
        if (settings.enabled === false || (settings.excludedHosts || []).includes(location.hostname)) {
          return "Shorthand expansion is paused. Cancel this form and enable expansion before trying again.";
        }
        if (!restoreTarget(target)) {
          return "The original field changed while this form was open. Cancel and try the shorthand again.";
        }
        const { text, cursorOffset } = result;
        if (target.node) {
          replaceInNode(window.getSelection(), target.node, target.start, target.end,
            text, text.length - cursorOffset);
          lastExpansion = { el: target.el, text, cursorOffset, trigger: target.trigger };
        } else {
          replaceInField(target.el, target.start, target.end, text, cursorOffset);
          lastExpansion = { el: target.el, start: target.start, text, cursorOffset, trigger: target.trigger };
        }
        templateTarget = null;
        return true;
      },
      onCancel() {
        templateTarget = null;
        restoreTarget(target);
      },
    });
    if (!shown) templateTarget = null;
    return shown;
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
    if (!match) return false;

    if (fillTemplate(match.shorthand, fieldTarget(el, match.start, caret, match.shorthand.trigger))) return true;

    const { text, cursorOffset } = template.render(match.shorthand.expansion);
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
    if (!match) return false;

    if (fillTemplate(match.shorthand,
      nodeTarget(root, node, match.start, range.startOffset, match.shorthand.trigger))) return true;

    const { text, cursorOffset } = template.render(match.shorthand.expansion);
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
    return pickerTrigger && shorthands.length > 0 && !templateTarget
      && self.ShorthandPicker && !self.ShorthandPicker.isOpen();
  }

  function tryOpenPickerInField(el) {
    if (!pickerArmed()) return false;
    const caret = el.selectionStart;
    if (caret == null || caret !== el.selectionEnd) return false;
    if (!el.value.slice(0, caret).endsWith(pickerTrigger)) return false;
    const start = caret - pickerTrigger.length;
    const target = fieldTarget(el, start, caret, pickerTrigger);

    // The trigger text stays in the field while the picker is open; choosing a
    // shorthand replaces it in one step, and cancelling leaves what was typed.
    return self.ShorthandPicker.show({
      shorthands,
      anchorEl: el,
      onPick(sh) {
        if (fillTemplate(sh, target)) return;
        const { text, cursorOffset } = template.render(sh.expansion);
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
    const target = nodeTarget(root, node, start, end, pickerTrigger);

    return self.ShorthandPicker.show({
      shorthands,
      anchorEl: root,
      onPick(sh) {
        if (fillTemplate(sh, target)) return;
        const { text, cursorOffset } = template.render(sh.expansion);
        const liveSel = window.getSelection();
        if (!liveSel) return;
        replaceInNode(liveSel, node, start, end, text, text.length - cursorOffset);
        lastExpansion = { el: root, text, cursorOffset, trigger: pickerTrigger };
      },
    });
  }

  // ---- wiring ---------------------------------------------------------------

  function onInput(ev) {
    if (suppress || templateTarget || templateForm.isOpen()) return;
    lastExpansion = null;
    if (!enabled || hostExcluded || shorthands.length === 0) return;
    if (ev.isComposing) return; // IME composition in progress
    const t = ev.inputType;
    if (t && !t.startsWith("insert")) return; // only react to typing/pasting
    const el = ev.target;
    if (isIgnored(el)) return;
    // A user's own shorthand always wins over the picker trigger.
    if (isTextInput(el)) {
      if (!expandInField(el)) tryOpenPickerInField(el);
    } else if (isEditable(el)) {
      if (!expandInContentEditable(el)) tryOpenPickerInContentEditable(el);
    }
  }

  function onKeyDown(ev) {
    // The picker registers its own capture handler later, so this one runs
    // first; while it is open every key belongs to it.
    if (templateTarget || templateForm.isOpen()
        || (self.ShorthandPicker && self.ShorthandPicker.isOpen())) return;
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
  document.addEventListener("mousedown", () => { lastExpansion = null; }, true);

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === storage.AREA) reload();
  });

  reload();
})();
