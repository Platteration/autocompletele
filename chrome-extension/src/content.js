// Watches editable fields on the page and expands shorthands as they are typed.
// Pressing Backspace immediately after an expansion restores the trigger.
(function () {
  "use strict";

  const { findMatch } = self.ShorthandExpander;
  const storage = self.ShorthandStorage;
  const template = self.ShorthandTemplate;
  const templateForm = self.ShorthandTemplateForm;
  const fieldSafety = self.ShorthandFieldSafety;
  const suggestions = self.ShorthandSuggestions;
  const premium = self.ActlePremium;

  let shorthands = [];
  let usageCounts = {}; // local per-snippet use counts, for ranking only
  let enabled = true;
  let hostExcluded = false;
  let pickerTrigger = storage.DEFAULT_SETTINGS.pickerTrigger;
  let animationMode = storage.DEFAULT_SETTINGS.animationMode;
  let suggestionsEnabled = storage.DEFAULT_SETTINGS.suggestionsEnabled;
  let suggestionTarget = null;
  let dismissedSuggestion = null;
  let suggestionFrame = 0;
  let suppress = false; // true while we are inserting text ourselves
  let lastExpansion = null; // details of the most recent expansion, for undo
  let templateTarget = null; // original insertion point while a fill-in form has focus
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
    return !!(el && el.closest && el.closest("[" + IGNORE_ATTR + "]")) || fieldSafety.isProtected(el);
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
    if (isIgnored(node.nodeType === Node.TEXT_NODE ? node.parentElement : node)) return null;
    if (node.nodeType !== Node.TEXT_NODE) {
      return el.textContent === "" && sel.isCollapsed ? { value: "", start: 0, end: 0, node: null, rootValue: "", offset: 0 } : null;
    }
    const before = document.createRange();
    before.selectNodeContents(el);
    before.setEnd(node, range.startOffset);
    return { value: node.textContent, start: range.startOffset, end: range.endOffset,
      node, rootValue: el.textContent, offset: before.toString().length - range.startOffset };
  }

  // ---- what the person actually typed --------------------------------------
  //
  // An expansion is the person's own text, and the page can read whatever lands
  // in its fields. So a trigger only fires when the person typed it: a page
  // script that writes "addr/" into a field, dispatches an input event, or calls
  // execCommand("insertText") produces an input event too (execCommand's is even
  // marked trusted), and without this it got the expansion back to read. The
  // grant/consumeEdit pair below is the gate: a trigger must sit inside an edit
  // that an exact trusted key press, paste or drop produced.

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

  // Rich editors store a trailing space as U+00A0 and turn it back into U+0020
  // once more text follows. Both are boundaries and neither can be part of a
  // trigger, so treating them alike cannot change which shorthand matched.
  function sameText(a, b) {
    return a.replace(/\u00a0/g, " ") === b.replace(/\u00a0/g, " ");
  }

  function consumeEdit(grant, ev, el) {
    if (!grant || grant.el !== el || grant.until < Date.now() || ev.isComposing || ev.inputType !== grant.inputType) return false;
    // Browser-trusted execCommand input must not substitute another edit for a physical key,
    // paste or drop. Text, original selection and the resulting value must all agree.
    if (grant.inputType === "insertText" && ev.data !== grant.data) return false;
    const before = grant.before;
    const expected = before.value.slice(0, before.start) + grant.data + before.value.slice(before.end);
    const live = editSnapshot(el);
    if (!live || !sameText(live.value, expected) || live.start !== before.start + grant.data.length || live.end !== live.start) return false;
    if (isEditable(el)) {
      if (before.node && live.node !== before.node) return false;
      const rootExpected = before.rootValue.slice(0, before.offset + before.start) + grant.data + before.rootValue.slice(before.offset + before.end);
      if (!sameText(el.textContent, rootExpected)) return false;
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
      usageCounts = storage.getUsageCounts ? await storage.getUsageCounts() : {};
      shorthands = sortByUsage(data.shorthands.filter((s) => s.trigger));
      enabled = data.settings.enabled !== false;
      hostExcluded = (data.settings.excludedHosts || []).includes(location.hostname);
      pickerTrigger = typeof data.settings.pickerTrigger === "string"
        ? data.settings.pickerTrigger
        : storage.DEFAULT_SETTINGS.pickerTrigger;
      const previousMode = animationMode;
      animationMode = data.settings.animationMode;
      suggestionsEnabled = data.settings.suggestionsEnabled;
      closeSuggestions();
      if (previousMode !== animationMode || !enabled || hostExcluded) {
        self.ShorthandExpansionFeedback.clear();
      }
    } catch (e) {
      // Extension context may be gone after an update/reload; stay quiet.
    }
  }

  function usageOf(sh) {
    const count = sh && usageCounts[sh.id];
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  // Most-used first, library order breaking ties. The picker inherits this
  // order; suggestions receive the counts and rank with them directly.
  function sortByUsage(list) {
    return list.map((sh, index) => ({ sh, index }))
      .sort((a, b) => usageOf(b.sh) - usageOf(a.sh) || a.index - b.index)
      .map((entry) => entry.sh);
  }

  function noteUse(id) {
    if (!id) return;
    usageCounts[id] = usageOf({ id }) + 1;
    shorthands = sortByUsage(shorthands);
    if (storage.recordUse) storage.recordUse(id);
  }

  function insertText(text) {
    try {
      return document.execCommand("insertText", false, text);
    } catch (_) {
      return false;
    }
  }

  function showExpansionFeedback(el, detail) {
    // Visual feedback must never interrupt insertion or the undo window.
    try {
      self.ShorthandExpansionFeedback.show(el, detail);
    } catch (_) {}
  }

  function nodeFeedback(el, node, start, text, trigger, mode = animationMode) {
    let offset = null;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.setEnd(node, start);
      offset = range.toString().length;
    } catch (_) { /* An unsupported editor can still use the outline cue. */ }
    return { mode, start: offset, text, trigger };
  }

  // The fill-in form takes focus. Keep the original text and insertion point,
  // then check them again before restoring focus: a page may save or replace
  // its editor on blur, or receive an update while the form is being filled.
  function fieldTarget(el, start, end, trigger, shorthandId = null) {
    return { el, start, end, trigger, shorthandId, value: el.value };
  }

  function nodeTarget(el, node, start, end, trigger, shorthandId = null) {
    return {
      el, node, start, end, trigger, shorthandId,
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

  function insertionReady(target, needsFocus = true) {
    if (!enabled || hostExcluded || !targetUnchanged(target)) return false;
    if (!needsFocus) return true; // The fill-in form owns focus until confirmation.
    if (!isFocused(target.el)) return false;
    if (!target.node) return true;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    return range.startContainer === target.node && range.startOffset === target.end;
  }

  // Reserve usage only for an actual insertion. Undo uses the low-level edit
  // helpers directly. Recheck the target after any asynchronous quota decision.
  function insertExpansion(target, result, fromForm = false, mode = animationMode) {
    const { text, cursorOffset } = result;
    return premium.execute(() => {
      if (!insertionReady(target, !fromForm)) return false;
      if (fromForm && !restoreTarget(target)) return false;
      const feedback = target.node
        ? nodeFeedback(target.el, target.node, target.start, text, target.trigger, mode)
        : { mode, start: target.start, text, trigger: target.trigger };
      if (target.node) {
        replaceInNode(window.getSelection(), target.node, target.start, target.end, text, text.length - cursorOffset);
        if (target.el.textContent === target.rootText && text !== target.trigger) return false;
        lastExpansion = { el: target.el, text, cursorOffset, trigger: target.trigger };
      } else {
        replaceInField(target.el, target.start, target.end, text, cursorOffset);
        const expected = target.value.slice(0, target.start) + text + target.value.slice(target.end);
        if (target.el.value !== expected) return false;
        lastExpansion = { el: target.el, start: target.start, text, cursorOffset, trigger: target.trigger };
      }
      showExpansionFeedback(target.el, feedback);
      noteUse(target.shorthandId);
      return true;
    }, () => {
      if (!insertionReady(target, !fromForm)) return false;
      if (!self.ActlePremiumConfig.enforceDailyLimit) return true;
      // A quota request yields to other tabs. Read pause/site settings again,
      // then validate the original target once more immediately before editing.
      return storage.getAll().then(({ settings }) => settings.enabled !== false
        && !(settings.excludedHosts || []).includes(location.hostname)
        && insertionReady(target, !fromForm));
    }, { notice: !fromForm });
  }

  function fillTemplate(shorthand, target) {
    target.shorthandId = shorthand.id;
    if (!template.requiresInput(shorthand.expansion)) return false;
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
        if (!insertionReady(target, false)) {
          return "The original field changed while this form was open. Cancel and try the shorthand again.";
        }
        if (!await insertExpansion(target, result, true, settings.animationMode)) return premium.lastError()
          || "The original field changed while this form was open. Cancel and try the shorthand again.";
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
    if (!match || !typedTrigger(el, match.start, caret)) return false;

    if (fillTemplate(match.shorthand, fieldTarget(el, match.start, caret, match.shorthand.trigger, match.shorthand.id))) return true;

    insertExpansion(fieldTarget(el, match.start, caret, match.shorthand.trigger, match.shorthand.id), template.render(match.shorthand.expansion));
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
      // Rendered offsets and DOM text offsets both count UTF-16 code units.
      // Selection.modify counts graphemes instead, so an emoji or combining
      // sequence after {cursor} would otherwise move the caret too far back.
      const inserted = sel.rangeCount ? sel.getRangeAt(0) : null;
      if (caretBack && inserted && inserted.collapsed
          && inserted.startContainer.nodeType === Node.TEXT_NODE
          && inserted.startOffset >= text.length
          && inserted.startContainer.textContent.slice(inserted.startOffset - text.length, inserted.startOffset) === text) {
        sel.collapse(inserted.startContainer, inserted.startOffset - caretBack);
      } else {
        // Some rich editors split multiline insertions into separate nodes.
        for (let i = 0; i < caretBack; i++) sel.modify("move", "backward", "character");
      }
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
    if (isIgnored(node.parentElement)) return false;

    const before = node.textContent.slice(0, range.startOffset);
    const match = findMatch(before, shorthands);
    if (!match || !typedTrigger(root, match.start, range.startOffset, node)) return false;

    if (fillTemplate(match.shorthand,
      nodeTarget(root, node, match.start, range.startOffset, match.shorthand.trigger, match.shorthand.id))) return true;

    insertExpansion(nodeTarget(root, node, match.start, range.startOffset, match.shorthand.trigger, match.shorthand.id), template.render(match.shorthand.expansion));
    return true;
  }

  function undoInContentEditable(u) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !u.el.contains(node)) return false;
    if (isIgnored(node.parentElement)) return false;
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
    if (!typedTrigger(el, start, caret)) return false;
    const target = fieldTarget(el, start, caret, pickerTrigger);

    // The trigger text stays in the field while the picker is open; choosing a
    // shorthand replaces it in one step, and cancelling leaves what was typed.
    return self.ShorthandPicker.show({
      shorthands,
      anchorEl: el,
      onPick(sh) {
        // A page may change the field or move focus while the panel is open.
        if (!isFocused(el) || isIgnored(el) || !isTextInput(el) || el.value !== target.value || el.selectionStart !== caret || el.selectionEnd !== caret || el.value.slice(start, caret) !== target.trigger) return;
        if (fillTemplate(sh, target)) return;
        insertExpansion(target, template.render(sh.expansion));
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
    if (isIgnored(node.parentElement)) return false;
    const end = range.startOffset;
    if (!node.textContent.slice(0, end).endsWith(pickerTrigger)) return false;
    const start = end - pickerTrigger.length;
    if (!typedTrigger(root, start, end, node)) return false;
    const target = nodeTarget(root, node, start, end, pickerTrigger);

    return self.ShorthandPicker.show({
      shorthands,
      anchorEl: root,
      onPick(sh) {
        if (!isFocused(root) || isIgnored(root) || isIgnored(node.parentElement) || root.textContent !== target.rootText || !node.isConnected || !root.contains(node) || node.textContent.slice(start, end) !== target.trigger) return;
        const liveSel = window.getSelection();
        if (!liveSel || !liveSel.isCollapsed || !liveSel.rangeCount) return;
        const liveRange = liveSel.getRangeAt(0);
        if (liveRange.startContainer !== node || liveRange.startOffset !== end) return;
        if (fillTemplate(sh, target)) return;
        insertExpansion(target, template.render(sh.expansion));
      },
    });
  }

  // ---- suggestions ----------------------------------------------------------

  function closeSuggestions() {
    suggestionTarget = null;
    if (suggestionFrame) window.cancelAnimationFrame(suggestionFrame);
    suggestionFrame = 0;
    suggestions.close();
  }

  function activeSuggestion(target) {
    if (!enabled || hostExcluded || !suggestionsEnabled || !isFocused(target.el) || !targetUnchanged(target)) return false;
    if (!target.node) return true;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    return range.startContainer === target.node && range.startOffset === target.end;
  }

  function acceptSuggestion(sh, target) {
    closeSuggestions();
    if (!activeSuggestion(target) || !shorthands.some((saved) => saved.id === sh.id
        && saved.trigger === sh.trigger && saved.expansion === sh.expansion)) return;
    if (fillTemplate(sh, target)) return;
    insertExpansion(target, template.render(sh.expansion));
  }

  function offerSuggestions(el) {
    if (!suggestionsEnabled || templateTarget || templateForm.isOpen()) return;
    const snapshot = editSnapshot(el);
    if (!snapshot || snapshot.start == null || snapshot.start !== snapshot.end) return;
    const match = suggestions.find(snapshot.value.slice(0, snapshot.end), shorthands, usageCounts);
    if (!match || !typedTrigger(el, match.start, snapshot.end, snapshot.node)) {
      dismissedSuggestion = null;
      return;
    }
    if (dismissedSuggestion && dismissedSuggestion.el === el
        && dismissedSuggestion.node === snapshot.node && dismissedSuggestion.start === match.start) return;
    const target = snapshot.node
      ? nodeTarget(el, snapshot.node, match.start, snapshot.end, match.query)
      : fieldTarget(el, match.start, snapshot.end, match.query);
    if (!activeSuggestion(target)) return;
    suggestionTarget = target;
    const shown = suggestions.show({
      query: match.query, items: match.items, anchorEl: el,
      onPick(sh) { acceptSuggestion(sh, target); },
      onDismiss() {
        dismissedSuggestion = { el, node: snapshot.node, start: match.start };
        closeSuggestions();
      },
    });
    if (!shown) { closeSuggestions(); return; }
    function watch() {
      suggestionFrame = 0;
      if (suggestionTarget !== target) return;
      if (!activeSuggestion(target) || templateForm.isOpen() || self.ShorthandPicker.isOpen()) {
        closeSuggestions();
        return;
      }
      suggestionFrame = window.requestAnimationFrame(watch);
    }
    suggestionFrame = window.requestAnimationFrame(watch);
  }

  // ---- wiring ---------------------------------------------------------------

  function onInput(ev) {
    // dispatchEvent() on a page-owned field must never release stored text.
    if (suppress || !ev.isTrusted) return;
    // execCommand can produce browser-trusted input without a real user
    // edit. Require, and consume, a recent exact trusted typing/paste/drop edit.
    const grant = inputGrant;
    inputGrant = null;
    closeSuggestions();
    // While a fill-in form has focus, its own typing is not page editing.
    if (templateTarget || templateForm.isOpen()) return;
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
      if (!expandInField(el) && !tryOpenPickerInField(el)) offerSuggestions(el);
    } else if (isEditable(el)) {
      if (!expandInContentEditable(el) && !tryOpenPickerInContentEditable(el)) offerSuggestions(el);
    }
  }

  function onKeyDown(ev) {
    if (!ev.isTrusted || !isFocused(ev.target)) return;
    if (isIgnored(ev.target)) {
      inputGrant = null;
      lastExpansion = null;
      trustedEdits.delete(editableTarget(ev.target));
      closeSuggestions();
      self.ShorthandPicker.close();
      return;
    }
    if (suggestionTarget) {
      if (!activeSuggestion(suggestionTarget) || ev.isComposing) closeSuggestions();
      else if (suggestions.handleKeyDown(ev)) { inputGrant = null; return; }
    }
    // The picker registers its own capture handler later, so this one runs
    // first; while it is open every key belongs to it.
    if (templateTarget || templateForm.isOpen()
        || (self.ShorthandPicker && self.ShorthandPicker.isOpen())) return;
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
  for (const event of ["compositionstart", "compositionupdate", "compositionend"]) document.addEventListener(event, () => {
    inputGrant = null;
    closeSuggestions();
  }, true);
  document.addEventListener("mousedown", (ev) => {
    lastExpansion = null;
    if (!suggestions.isHost(ev.target)) {
      dismissedSuggestion = null;
      closeSuggestions();
    }
  }, true);
  document.addEventListener("focusout", () => {
    dismissedSuggestion = null;
    closeSuggestions();
  }, true);
  document.addEventListener("selectionchange", () => {
    if (suggestionTarget && !activeSuggestion(suggestionTarget)) closeSuggestions();
  });
  document.addEventListener("scroll", (ev) => {
    if (!suggestions.isHost(ev.target)) closeSuggestions();
  }, true);
  for (const event of ["resize", "blur", "pagehide"]) window.addEventListener(event, closeSuggestions);

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local" && _changes["shorthand-usage-counts"]) {
      usageCounts = _changes["shorthand-usage-counts"].newValue || {};
      shorthands = sortByUsage(shorthands);
      return;
    }
    if (area === storage.AREA && Object.keys(_changes).some((key) => key !== "actle-premium")) reload();
  });

  reload();
})();
