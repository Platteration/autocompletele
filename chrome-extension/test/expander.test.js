const test = require("node:test");
const assert = require("node:assert/strict");
const { findMatch, render, sanitizeList } = require("../src/expander.js");

const list = [
  { trigger: "cool/", expansion: "That is really cool!" },
  { trigger: "verycool/", expansion: "Extremely cool!" },
  { trigger: "sig/", expansion: "Best regards,\n{cursor}\nAlex" },
];

test("matches a trigger at the end of the text", () => {
  const m = findMatch("hey cool/", list);
  assert.equal(m.shorthand.trigger, "cool/");
  assert.equal(m.start, 4);
});

test("matches at the very start of the field", () => {
  const m = findMatch("cool/", list);
  assert.equal(m.start, 0);
});

test("does not fire inside a word", () => {
  assert.equal(findMatch("school/", list), null);
  assert.equal(findMatch("x_cool/", list), null);
  assert.equal(findMatch("1cool/", list), null);
});

test("punctuation counts as a boundary", () => {
  assert.ok(findMatch("(cool/", list));
  assert.ok(findMatch("hi,cool/", list));
  assert.ok(findMatch("line\ncool/", list));
});

test("does not fire when the trigger is not at the caret", () => {
  assert.equal(findMatch("cool/ and more", list), null);
});

test("longest trigger wins", () => {
  const m = findMatch("verycool/", list);
  assert.equal(m.shorthand.trigger, "verycool/");
});

test("is case sensitive", () => {
  assert.equal(findMatch("COOL/", list), null);
});

test("render substitutes date/time placeholders", () => {
  const now = new Date(2026, 8, 8, 14, 5);
  assert.equal(render("Today is {date} at {time}", now).text, "Today is 2026-09-08 at 14:05");
  assert.equal(render("{datetime}", now).text, "2026-09-08 14:05");
  assert.equal(render("{DATE}", now).text, "2026-09-08");
});

test("render handles {cursor}", () => {
  const r = render("Best regards,\n{cursor}\nAlex");
  assert.equal(r.text, "Best regards,\n\nAlex");
  assert.equal(r.cursorOffset, 14);
});

test("render without cursor puts caret at end", () => {
  const r = render("hello");
  assert.equal(r.cursorOffset, 5);
});

test("render leaves unknown placeholders and escapes alone", () => {
  assert.equal(render("{nope} {{date}} {").text, "{nope} {date} {");
});

test("sanitizeList trims, dedupes and drops junk", () => {
  const out = sanitizeList([
    { trigger: "  a/ ", expansion: "A" },
    { trigger: "a/", expansion: "dup" },
    { trigger: "", expansion: "x" },
    null,
    "str",
    { trigger: "b/", expansion: 5 },
  ]);
  assert.deepEqual(out, [
    { trigger: "a/", expansion: "A" },
    { trigger: "b/", expansion: "5" },
  ]);
  assert.deepEqual(sanitizeList("nope"), []);
});
