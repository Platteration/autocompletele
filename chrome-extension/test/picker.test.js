// Tests for the picker's ranking. picker.js attaches itself to a global, so
// give it one and load it the same way the browser does.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sandbox = { self: {} };
sandbox.self.self = sandbox.self;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "src", "picker.js"), "utf8"),
  sandbox,
  { filename: "picker.js" }
);
const score = sandbox.self.ShorthandPicker._score;

const brb = { trigger: "brb/", expansion: "Be right back" };
const addr = { trigger: "addr/", expansion: "123 Example Street" };

test("an empty query keeps everything, in the original order", () => {
  assert.equal(score(brb, ""), 0);
  assert.equal(score(addr, ""), 0);
});

test("a trigger prefix ranks highest", () => {
  assert.ok(score(brb, "br") > score(brb, "back"));
});

test("a match in the trigger beats a match in the expansion", () => {
  const inTrigger = score({ trigger: "xyz/", expansion: "nothing here" }, "xyz");
  const inExpansion = score({ trigger: "aaa/", expansion: "xyz appears here" }, "xyz");
  assert.ok(inTrigger > inExpansion);
});

test("matches the expansion, case insensitively", () => {
  assert.ok(score(brb, "right") >= 0);
  assert.ok(score(brb, "RIGHT") >= 0);
  assert.ok(score(addr, "example") >= 0);
});

test("matches a scattered subsequence of the expansion", () => {
  // "brk" appears in "Be right back" only as scattered letters.
  assert.ok(score(brb, "brk") >= 0);
});

test("shorter triggers win among prefix matches", () => {
  const short = score({ trigger: "br/", expansion: "x" }, "br");
  const long = score({ trigger: "brbrbr/", expansion: "x" }, "br");
  assert.ok(short > long);
});

test("returns -1 when nothing matches", () => {
  assert.equal(score(brb, "zzzzq"), -1);
  assert.equal(score(addr, "qqqq"), -1);
});
