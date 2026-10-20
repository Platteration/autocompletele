const test = require("node:test");
const assert = require("node:assert/strict");
const docs = require("../src/google-docs.js");

const type = (tracker, ...keys) => keys.map((key) => tracker.key(typeof key === "string" ? { key } : key));

test("only Google Docs documents and Slides presentations use the bridge", () => {
  assert.equal(docs.supports({ hostname: "docs.google.com", pathname: "/document/d/abc/edit" }), true);
  assert.equal(docs.supports({ hostname: "docs.google.com", pathname: "/presentation/d/abc/edit" }), true);
  for (const location of [
    { hostname: "docs.google.com", pathname: "/spreadsheets/d/abc/edit" },
    { hostname: "docs.google.com", pathname: "/forms/d/abc/edit" },
    { hostname: "drive.google.com", pathname: "/document/d/abc" },
    { hostname: "docs.google.com.example", pathname: "/document/d/abc" },
    null,
  ]) assert.equal(docs.supports(location), false, JSON.stringify(location));
});

test("the tracker keeps physically typed characters and Backspace removes the last", () => {
  const tracker = docs.createTracker();
  assert.deepEqual(type(tracker, "c", "o", "x", "Backspace", "o", "l", "/"), [true, true, true, false, true, true, true]);
  assert.equal(tracker.text, "cool/");
  type(tracker, { key: "Shift" }, "😀");
  assert.equal(tracker.text, "cool/😀", "a modifier alone changes nothing; one emoji key is one character");
});

test("caret moves, shortcuts, composition and dead keys forget what came before", () => {
  for (const reset of ["Enter", "Tab", "ArrowLeft", "Delete", "Home", "Dead", { key: "v", ctrlKey: true },
    { key: "z", metaKey: true }, { key: "a", isComposing: true }]) {
    const tracker = docs.createTracker();
    type(tracker, "c", "o", reset);
    assert.equal(tracker.text, "", JSON.stringify(reset));
  }
  const altGr = docs.createTracker();
  type(altGr, { key: "@", ctrlKey: true, altKey: true });
  assert.equal(altGr.text, "@", "AltGr characters are typed text, not shortcuts");
});

test("every key except a lone modifier changes the version, so a later key cancels a pending expansion", () => {
  const tracker = docs.createTracker();
  type(tracker, "a");
  const before = tracker.version;
  type(tracker, { key: "Shift" });
  assert.equal(tracker.version, before);
  type(tracker, "Backspace");
  assert.notEqual(tracker.version, before);
  const afterKey = tracker.version;
  tracker.reset();
  assert.notEqual(tracker.version, afterKey);
});

test("the tracker remembers a bounded run of recent characters", () => {
  const tracker = docs.createTracker();
  for (let i = 0; i < 250; i++) tracker.key({ key: "x" });
  type(tracker, "c", "o", "o", "l", "/");
  assert.equal(tracker.text.length, 200);
  assert.ok(tracker.text.endsWith("cool/"));
});

function fakeFrame() {
  const events = [];
  const target = { focus() { events.push("focus"); }, dispatchEvent(event) { events.push(event); return true; } };
  const inner = { body: {}, activeElement: target, querySelector() { return null; } };
  return { events, frame: { contentDocument: inner, contentWindow: { focus() {} } } };
}

test("replace removes each trigger character, pastes the text once and places the cursor marker", () => {
  const saved = { KeyboardEvent: global.KeyboardEvent, ClipboardEvent: global.ClipboardEvent, DataTransfer: global.DataTransfer };
  global.KeyboardEvent = class { constructor(type, init) { Object.assign(this, init, { type }); } };
  global.ClipboardEvent = class { constructor(type, init) { Object.assign(this, init, { type }); } };
  global.DataTransfer = class { constructor() { this.data = {}; } setData(kind, value) { this.data[kind] = value; } };
  try {
    const { events, frame } = fakeFrame();
    assert.equal(docs.replace(frame, "sig😀/", { text: "Regards,\nAl👍ex", cursorOffset: 11 }), true);
    const summary = events.map((event) => event.type === "paste"
      ? "paste:" + event.clipboardData.data["text/plain"] : `${event.type}:${event.key}:${event.keyCode}`);
    assert.deepEqual(summary, [
      ...Array(5).fill(["keydown:Backspace:8", "keyup:Backspace:8"]).flat(),
      "paste:Regards,\nAl👍ex",
      ...Array(3).fill(["keydown:ArrowLeft:37", "keyup:ArrowLeft:37"]).flat(),
    ], "five characters removed (one emoji), cursor moved back over 'ex' and the emoji");
    assert.ok(events.every((event) => event.bubbles && event.cancelable));
  } finally {
    Object.assign(global, saved);
  }
});

test("replace refuses a frame without a document", () => {
  assert.equal(docs.replace({ contentDocument: null }, "cool/", { text: "x", cursorOffset: 1 }), false);
});
