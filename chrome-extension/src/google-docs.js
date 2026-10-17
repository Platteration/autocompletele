// Experimental Google Docs and Slides support. Their editors draw text on a
// canvas and take typing through a hidden same-origin iframe, so the field and
// rich-editor paths in content.js never see it. This bridge remembers what was
// physically typed since the caret last moved another way; when that ends in a
// trigger, it removes the trigger with simulated Backspaces and pastes the
// expansion, the same events Docs receives from a real keyboard and clipboard.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ShorthandGoogleDocs = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FRAME_SELECTOR = "iframe.docs-texteventtarget-iframe";
  const MAX_TYPED = 200;
  // Docs inserts a typed character while handling its key events. Waiting a
  // moment before removing the trigger leaves it time to, and a further key in
  // that moment cancels the expansion instead of racing the person's typing.
  const SETTLE_MS = 40;
  const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Fn", "OS"]);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  function graphemeCount(text) {
    return Array.from(segmenter.segment(String(text))).length;
  }

  function supports(location) {
    return !!location && location.hostname === "docs.google.com"
      && /^\/(document|presentation)\//.test(location.pathname || "");
  }

  /** Characters typed since the caret last moved some other way. */
  function createTracker() {
    let typed = [];
    let version = 0;
    return {
      get text() { return typed.join(""); },
      get version() { return version; },
      reset() { typed = []; version++; },
      // Returns true when the key typed one character.
      key(ev) {
        if (MODIFIERS.has(ev.key)) return false;
        version++;
        // Ctrl or Cmd chords are shortcuts; AltGr (Ctrl+Alt) still types.
        if (ev.isComposing || ev.metaKey || (ev.ctrlKey && !ev.altKey)) {
          typed = [];
          return false;
        }
        if (ev.key === "Backspace") {
          typed.pop();
          return false;
        }
        if (typeof ev.key === "string" && Array.from(ev.key).length === 1) {
          typed.push(ev.key);
          if (typed.length > MAX_TYPED) typed.shift();
          return true;
        }
        // Enter, Tab, arrows, Delete, Home and the like move the caret or
        // change text out of view: what came before is no longer known.
        typed = [];
        return false;
      },
    };
  }

  function editable(frame) {
    const inner = frame.contentDocument;
    if (!inner) return null;
    const active = inner.activeElement;
    return active && active !== inner.body ? active : inner.querySelector("[contenteditable]") || inner.body;
  }

  function press(target, key, code, keyCode) {
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }));
    }
  }

  /** Remove the trigger just typed and paste the rendered expansion. */
  function replace(frame, trigger, result) {
    const target = editable(frame);
    if (!target) return false;
    for (let i = graphemeCount(trigger); i > 0; i--) press(target, "Backspace", "Backspace", 8);
    const data = new DataTransfer();
    data.setData("text/plain", result.text);
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
    for (let i = graphemeCount(result.text.slice(result.cursorOffset)); i > 0; i--) press(target, "ArrowLeft", "ArrowLeft", 37);
    return true;
  }

  function focus(frame) {
    try {
      frame.contentWindow.focus();
      const target = editable(frame);
      if (target) target.focus();
    } catch (_) { /* The frame has gone; nothing to return focus to. */ }
  }

  /** Watch the editor's typing frame; onTyped(text, frame) after each character. */
  function attach(doc, onTyped) {
    const tracker = createTracker();
    const hooked = new WeakSet();
    const reset = () => tracker.reset();
    function hook() {
      for (const frame of doc.querySelectorAll(FRAME_SELECTOR)) {
        let inner = null;
        try { inner = frame.contentDocument; } catch (_) { /* Not same-origin: not the editor. */ }
        if (!inner || hooked.has(inner)) continue;
        hooked.add(inner);
        inner.addEventListener("keydown", (ev) => {
          if (!ev.isTrusted || !tracker.key(ev)) return;
          const { text, version } = tracker;
          setTimeout(() => { if (tracker.version === version) onTyped(text, frame); }, SETTLE_MS);
        }, true);
        for (const type of ["mousedown", "paste", "cut", "drop", "compositionstart"]) inner.addEventListener(type, reset, true);
      }
    }
    // Clicking the page moves the caret; the frame then loses track of it.
    doc.addEventListener("mousedown", reset, true);
    doc.defaultView.addEventListener("blur", reset);
    hook();
    // Docs creates and may recreate its typing frame after the page loads.
    const timer = setInterval(hook, 1000);
    return { tracker, stop() { clearInterval(timer); } };
  }

  return { supports, createTracker, graphemeCount, replace, focus, attach, SETTLE_MS };
});
