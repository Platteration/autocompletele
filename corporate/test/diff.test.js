const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenize, diff, similarity, lcsLength } = require("../core/diff.js");

test("tokenize keeps words, whitespace runs and punctuation", () => {
  assert.deepEqual(tokenize("Hi John,  it's 5pm."), ["Hi", " ", "John", ",", "  ", "it's", " ", "5pm", "."]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("café 中文"), ["café", " ", "中文"]);
});

test("diff reports equal, replace, insert and delete with anchor positions", () => {
  const ops = diff("Hi John, thanks", "Hi Mary Ann, thanks a lot");
  assert.deepEqual(ops.map((o) => o.type), ["equal", "replace", "equal", "insert"]);
  assert.deepEqual(ops[1].a, ["John"]);
  assert.deepEqual(ops[1].b, ["Mary", " ", "Ann"]);
  assert.equal(ops[1].aStart, 2);
  assert.equal(ops[1].aEnd, 3);
  assert.equal(ops[3].aStart, ops[3].aEnd);
  const removed = diff("a b c", "a c");
  assert.deepEqual(removed.map((o) => o.type), ["equal", "delete", "equal"]);
  assert.deepEqual(diff("", ""), []);
  assert.deepEqual(diff("same", "same").map((o) => o.type), ["equal"]);
});

test("similarity is symmetric, ignores whitespace and spans 0..1", () => {
  assert.equal(similarity("a b c", "a   b c"), 1);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("abc", ""), 0);
  const s = similarity("Hi John, thanks for your order", "Hi Mary, thanks for your order");
  assert.ok(s > 0.8 && s < 1);
  assert.equal(similarity("x y", "y x"), similarity("y x", "x y"));
});

test("very large inputs fall back instead of exhausting memory", () => {
  const big = Array.from({ length: 1000 }, (_, i) => "w" + i).join(" ");
  assert.equal(lcsLength(tokenize(big), tokenize(big + " more")), 0);
  const ops = diff(big, big + " more");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "replace");
});
