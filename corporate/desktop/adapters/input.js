// Global keyboard listener on top of uiohook-napi, translated into the
// engine's key model: keyTyped({text, isBackspace, resetsBuffer}) and
// focusChanged({process, title, ...}).
//
// Limits, stated plainly:
//   * uiohook observes keys; it cannot swallow them. The character that
//     completes a trigger therefore reaches the field and the engine runs
//     with swallowsTriggerKey=false so it is deleted along with the rest.
//   * Keys are mapped with a plain US layout plus Shift. Dead keys, AltGr
//     layouts and IME composition are not handled; keep triggers to ASCII.
//   * If uiohook-napi cannot be loaded (missing build, denied permission)
//     the listener reports itself unavailable; the app keeps running.
"use strict";

const { createActiveWindowLookup } = require("./active-window.js");

const POLL_MS = 1500;

const PLAIN = {
  Space: " ", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/",
  NumpadMultiply: "*", NumpadAdd: "+", NumpadSubtract: "-", NumpadDecimal: ".", NumpadDivide: "/",
};
const SHIFTED = {
  Minus: "_", Equal: "+", BracketLeft: "{", BracketRight: "}", Backslash: "|", Semicolon: ":", Quote: "\"",
  Backquote: "~", Comma: "<", Period: ">", Slash: "?",
  0: ")", 1: "!", 2: "@", 3: "#", 4: "$", 5: "%", 6: "^", 7: "&", 8: "*", 9: "(",
};
const RESET_KEYS = ["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"];

function buildTable(UiohookKey) {
  const byCode = new Map();
  const names = Object.keys(UiohookKey || {});
  for (const name of names) {
    const code = UiohookKey[name];
    if (typeof code !== "number") continue;
    let plain = null;
    let shifted = null;
    if (/^[A-Z]$/.test(name)) {
      plain = name.toLowerCase();
      shifted = name;
    } else if (/^[0-9]$/.test(name)) {
      plain = name;
      shifted = SHIFTED[name];
    } else if (/^Numpad[0-9]$/.test(name)) {
      plain = name.slice(-1);
      shifted = plain;
    } else if (name in PLAIN) {
      plain = PLAIN[name];
      shifted = SHIFTED[name] || plain;
    }
    if (plain != null) byCode.set(code, { plain, shifted });
  }
  const special = {};
  for (const name of ["Backspace", "Enter", "NumpadEnter", "Tab", "CapsLock", "Shift", "ShiftRight", "Ctrl", "CtrlRight", "Alt", "AltRight", "Meta", "MetaRight"]) {
    if (typeof UiohookKey[name] === "number") special[UiohookKey[name]] = name;
  }
  const reset = new Set();
  for (const name of RESET_KEYS) if (typeof UiohookKey[name] === "number") reset.add(UiohookKey[name]);
  for (let i = 1; i <= 24; i++) if (typeof UiohookKey["F" + i] === "number") reset.add(UiohookKey["F" + i]);
  return { byCode, special, reset };
}

/** Translate one uiohook keydown event; exported for tests and the simulator. */
function translate(event, table, capsLock) {
  const name = table.special[event.keycode];
  if (name === "Backspace") return { text: "", isBackspace: true, resetsBuffer: false };
  if (name === "Enter" || name === "NumpadEnter") return { text: "\n", isBackspace: false, resetsBuffer: true };
  if (name === "Tab") return { text: "\t", isBackspace: false, resetsBuffer: true };
  if (name) return { text: "", isBackspace: false, resetsBuffer: false }; // a modifier alone
  if (event.ctrlKey || event.metaKey || event.altKey) return { text: "", isBackspace: false, resetsBuffer: true };
  if (table.reset.has(event.keycode)) return { text: "", isBackspace: false, resetsBuffer: true };
  const entry = table.byCode.get(event.keycode);
  if (!entry) return { text: "", isBackspace: false, resetsBuffer: false };
  const letter = /^[a-z]$/.test(entry.plain);
  const upper = letter ? !!event.shiftKey !== !!capsLock : !!event.shiftKey;
  return { text: upper ? entry.shifted : entry.plain, isBackspace: false, resetsBuffer: false };
}

/**
 * @param {{onKey:Function, onFocus:Function, onStatus?:Function, platform?:string, ownProcessIds?:Set<number>}} handlers
 */
function createInputListener(handlers) {
  const settings = Object.assign({ onStatus: () => {}, platform: process.platform, pollMs: POLL_MS }, handlers || {});
  let hook = null;
  let table = null;
  let capsLock = false;
  let timer = null;
  let running = false;
  let last = null;
  let lookup = null;
  let error = null;

  try {
    const module = require("uiohook-napi");
    hook = module.uIOhook;
    table = buildTable(module.UiohookKey);
  } catch (loadError) {
    error = "keyboard listener unavailable: " + loadError.message;
  }

  function sameContext(a, b) {
    return !!a && !!b && a.process === b.process && a.title === b.title && !!a.secureInput === !!b.secureInput;
  }

  async function poll() {
    if (!running || !lookup) return;
    const context = await lookup.query();
    if (!running) return;
    const next = context || { process: "", title: "" };
    if (!sameContext(last, next)) {
      last = next;
      settings.onFocus(next);
    }
  }

  function onKeydown(event) {
    if (!running) return;
    if (table.special[event.keycode] === "CapsLock") {
      capsLock = !capsLock;
      return;
    }
    settings.onKey(translate(event, table, capsLock));
  }

  function onMousedown() {
    if (!running) return;
    // A click may move the caret within the same window; the engine resets
    // its buffer on every focus notification, so always notify.
    last = null;
    poll();
  }

  function start() {
    if (running) return true;
    if (!hook) {
      settings.onStatus({ available: false, error });
      return false;
    }
    try {
      hook.on("keydown", onKeydown);
      hook.on("mousedown", onMousedown);
      hook.start();
    } catch (startError) {
      error = "keyboard listener could not start: " + startError.message;
      settings.onStatus({ available: false, error });
      return false;
    }
    lookup = createActiveWindowLookup(settings.platform);
    running = true;
    timer = setInterval(poll, settings.pollMs);
    poll();
    settings.onStatus({ available: true, error: null });
    return true;
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(timer);
    timer = null;
    try {
      hook.off("keydown", onKeydown);
      hook.off("mousedown", onMousedown);
      hook.stop();
    } catch (stopError) {
      // Already stopped.
    }
    if (lookup) lookup.stop();
    lookup = null;
    last = null;
  }

  return {
    start,
    stop,
    poll,
    isAvailable: () => !!hook && !error,
    get error() { return error; },
    get running() { return running; },
  };
}

module.exports = { POLL_MS, buildTable, translate, createInputListener };
