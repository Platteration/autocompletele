// Global keyboard listener on top of uiohook-napi, translated into the
// engine's key model: keyTyped({text, isBackspace, resetsBuffer}) and
// focusChanged({process, title, ...}).
//
// Limits, stated plainly:
//   * uiohook observes keys; it cannot swallow them. The character that
//     completes a trigger therefore reaches the field and the engine runs
//     with swallowsTriggerKey=false so it is deleted along with the rest.
//   * Keys are mapped through a layout table (adapters/layouts.js): plain,
//     Shift, AltGr and Shift+AltGr levels, with dead-key composition. en-US
//     is exact; other layouts are best effort. IME composition is not
//     handled; keep triggers to characters the layout types directly.
//   * If uiohook-napi cannot be loaded (missing build, denied permission)
//     the listener reports itself unavailable; the app keeps running.
"use strict";

const { createActiveWindowLookup } = require("./active-window.js");
const layouts = require("./layouts.js");

const POLL_MS = 1500;

const RESET_KEYS = ["Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"];

function buildTable(UiohookKey, layoutId) {
  const layout = layouts.expand(layoutId || "en-US");
  const byCode = new Map();
  for (const [name, levels] of Object.entries(layout.keys)) {
    const code = UiohookKey ? UiohookKey[name] : undefined;
    if (typeof code === "number") byCode.set(code, levels);
  }
  const special = {};
  for (const name of ["Backspace", "Enter", "NumpadEnter", "Tab", "CapsLock", "Shift", "ShiftRight", "Ctrl", "CtrlRight", "Alt", "AltRight", "Meta", "MetaRight"]) {
    if (UiohookKey && typeof UiohookKey[name] === "number") special[UiohookKey[name]] = name;
  }
  const reset = new Set();
  for (const name of RESET_KEYS) if (UiohookKey && typeof UiohookKey[name] === "number") reset.add(UiohookKey[name]);
  for (let i = 1; i <= 24; i++) if (UiohookKey && typeof UiohookKey["F" + i] === "number") reset.add(UiohookKey["F" + i]);
  return { byCode, special, reset, layout: layout.id, layoutName: layout.name, compose: layout.compose };
}

/** Fresh per-listener state for AltGr tracking and dead-key composition. */
function createState() {
  return { deadKey: null, rightAlt: false };
}

const NONE = Object.freeze({ text: "", isBackspace: false, resetsBuffer: false });

function isLowerLetter(value) {
  return typeof value === "string" && value.length > 0 && /^\p{Ll}$/u.test(value);
}

/**
 * Translate one uiohook keydown event; exported for tests and the simulator.
 * `state` carries the pending dead key and whether right Alt is held
 * (updated by the listener on keyup).
 */
function translate(event, table, capsLock, state) {
  const st = state || createState();
  const name = table.special[event.keycode];
  if (name === "Backspace") {
    st.deadKey = null;
    return { text: "", isBackspace: true, resetsBuffer: false };
  }
  if (name === "Enter" || name === "NumpadEnter") {
    st.deadKey = null;
    return { text: "\n", isBackspace: false, resetsBuffer: true };
  }
  if (name === "Tab") {
    st.deadKey = null;
    return { text: "\t", isBackspace: false, resetsBuffer: true };
  }
  if (name === "AltRight") {
    st.rightAlt = true;
    return NONE;
  }
  if (name) return NONE; // a modifier alone
  // AltGr: right Alt, which Windows also reports as Ctrl+Alt.
  const altGr = st.rightAlt || (!!event.ctrlKey && !!event.altKey);
  if (!altGr && (event.ctrlKey || event.metaKey || event.altKey)) {
    st.deadKey = null;
    return { text: "", isBackspace: false, resetsBuffer: true };
  }
  if (table.reset.has(event.keycode)) {
    st.deadKey = null;
    return { text: "", isBackspace: false, resetsBuffer: true };
  }
  const levels = table.byCode.get(event.keycode);
  if (!levels) return NONE;
  const shift = !!event.shiftKey;
  let level = altGr ? (shift ? 3 : 2) : (shift ? 1 : 0);
  // Caps Lock inverts Shift for letters only.
  if (!altGr && capsLock && isLowerLetter(levels[0]) && levels[1] === levels[0].toUpperCase()) level = shift ? 0 : 1;
  let value = levels[level];
  if (value == null && altGr && level === 3) value = levels[2];
  if (value == null) return NONE;
  if (layouts.isDead(value)) {
    const mark = layouts.deadMark(value);
    const pending = st.deadKey;
    st.deadKey = mark;
    // Two dead keys in a row: the first one is typed as itself.
    return pending ? { text: pending, isBackspace: false, resetsBuffer: false } : NONE;
  }
  if (st.deadKey) {
    const mark = st.deadKey;
    st.deadKey = null;
    const composed = table.compose[mark] && table.compose[mark][value];
    if (composed) return { text: composed, isBackspace: false, resetsBuffer: false };
    if (value === " ") return { text: mark, isBackspace: false, resetsBuffer: false };
    return { text: mark + value, isBackspace: false, resetsBuffer: false };
  }
  return { text: value, isBackspace: false, resetsBuffer: false };
}

/**
 * @param {{onKey:Function, onFocus:Function, onStatus?:Function, platform?:string, ownProcessIds?:Set<number>}} handlers
 */
function createInputListener(handlers) {
  const settings = Object.assign({ onStatus: () => {}, platform: process.platform, pollMs: POLL_MS, layout: "en-US" }, handlers || {});
  let hook = null;
  let table = null;
  let keyNames = null;
  let capsLock = false;
  const state = createState();
  let timer = null;
  let running = false;
  let last = null;
  let lookup = null;
  let error = null;

  try {
    const module = require("uiohook-napi");
    hook = module.uIOhook;
    keyNames = module.UiohookKey;
    table = buildTable(keyNames, settings.layout);
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
    settings.onKey(translate(event, table, capsLock, state));
  }

  function onKeyup(event) {
    if (table && table.special[event.keycode] === "AltRight") state.rightAlt = false;
  }

  /** Switch layouts while running; returns the layout actually in use. */
  function setLayout(id) {
    settings.layout = layouts.LAYOUTS[id] ? id : "en-US";
    if (keyNames) table = buildTable(keyNames, settings.layout);
    state.deadKey = null;
    return settings.layout;
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
      hook.on("keyup", onKeyup);
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
      hook.off("keyup", onKeyup);
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
    setLayout,
    get layout() { return settings.layout; },
    isAvailable: () => !!hook && !error,
    get error() { return error; },
    get running() { return running; },
  };
}

module.exports = { POLL_MS, buildTable, translate, createState, createInputListener };
