const test = require("node:test");
const assert = require("node:assert/strict");
const { score, search } = require("../src/palette.js");

const list = [
  { trigger: "sig/", expansion: "Kind regards, Alex" },
  { trigger: "ty/", expansion: "Thank you!" },
  { trigger: "addr/", expansion: "123 Example Street" },
  { trigger: "thanks/", expansion: "Thanks so much" },
];

test("exact and prefix trigger matches rank ahead of expansion matches", () => {
  assert.deepEqual(search(list, "ty", 4).map((item) => item.trigger), ["ty/"]);
  assert.ok(score(list[1], "ty/") > score(list[3], "thanks"));
});

test("searches expansion text", () => {
  assert.deepEqual(search(list, "example", 4).map((item) => item.trigger), ["addr/"]);
});

test("uses a trigger subsequence fallback", () => {
  const result = search([{ trigger: "thanks/", expansion: "Thank you" }], "thk", 4);
  assert.equal(result.length, 1);
});

test("empty query preserves storage order and obeys the limit", () => {
  assert.deepEqual(search(list, "", 2), list.slice(0, 2));
});

test("handles junk input and zero limits", () => {
  assert.deepEqual(search(null, "x", 4), []);
  assert.deepEqual(search(list, "x", 0), []);
});
