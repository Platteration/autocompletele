const test = require("node:test");
const assert = require("node:assert/strict");
const { find, byTrigger } = require("../src/conflicts.js");

const kinds = (list, trigger) =>
  find(list).filter((c) => c.trigger === trigger).map((c) => c.kind).sort();

test("a trigger shadowed by a shorter prefix is unreachable", () => {
  const list = [{ trigger: "sig" }, { trigger: "sig/" }];
  const unreachable = find(list).filter((c) => c.kind === "unreachable");
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0].trigger, "sig/");
  assert.equal(unreachable[0].other, "sig");
});

test("names the shortest prefix, since that is the one that wins", () => {
  const list = [{ trigger: "a" }, { trigger: "ab" }, { trigger: "abc/" }];
  const forAbc = find(list).find((c) => c.trigger === "abc/" && c.kind === "unreachable");
  assert.equal(forAbc.other, "a");
});

test("a shared suffix is not a conflict, because the boundary rule handles it", () => {
  // Typing "verycool/" cannot fire "cool/": the character before it is a letter.
  const list = [{ trigger: "cool/" }, { trigger: "verycool/" }];
  assert.deepEqual(find(list).filter((c) => c.kind === "unreachable"), []);
});

test("a word-only trigger is flagged as firing mid-word", () => {
  assert.deepEqual(kinds([{ trigger: "sig" }], "sig"), ["fires-mid-word"]);
  assert.deepEqual(kinds([{ trigger: "addr2" }], "addr2"), ["fires-mid-word"]);
  assert.deepEqual(kinds([{ trigger: "my_sig" }], "my_sig"), ["fires-mid-word"]);
});

test("a trigger ending in punctuation is not flagged", () => {
  assert.deepEqual(find([{ trigger: "sig/" }]), []);
  assert.deepEqual(find([{ trigger: "sig;" }]), []);
  assert.deepEqual(find([{ trigger: ";;" }]), []);
});

test("a non-Latin word-only trigger is still flagged", () => {
  assert.deepEqual(kinds([{ trigger: "привет" }], "привет"), ["fires-mid-word"]);
});

test("one trigger can raise both warnings", () => {
  assert.deepEqual(kinds([{ trigger: "si" }, { trigger: "sig" }], "sig"), [
    "fires-mid-word",
    "unreachable",
  ]);
});

test("a healthy list produces no warnings", () => {
  assert.deepEqual(find([{ trigger: "cool/" }, { trigger: "brb/" }, { trigger: "addr/" }]), []);
});

test("handles junk input without throwing", () => {
  assert.deepEqual(find(null), []);
  assert.deepEqual(find(undefined), []);
  assert.deepEqual(find([]), []);
  assert.deepEqual(find([null, { trigger: "" }, {}]), []);
});

test("two shorthands with one trigger get one duplicate warning that says which one expands", () => {
  const found = find([{ trigger: "sig/" }, { trigger: "brb/" }, { trigger: "sig/" }]);
  assert.deepEqual(found.map((c) => [c.trigger, c.kind, c.count]), [["sig/", "duplicate", 2]]);
  assert.equal(found[0].message,
    'Two shorthands use "sig/". Typing it expands only one of them: the one used most in this browser, ' +
    "or the first in the list when they are tied. Rename or delete the other.");
});

test("three shorthands with one trigger are counted", () => {
  const found = find([{ trigger: "x/" }, { trigger: "x/" }, { trigger: "x/" }]);
  assert.deepEqual(found.map((c) => [c.kind, c.count]), [["duplicate", 3]]);
  assert.match(found[0].message, /^3 shorthands use "x\/"\. .* Rename or delete the others\.$/);
});

test("triggers that differ only in case are not duplicates", () => {
  assert.deepEqual(find([{ trigger: "Sig/" }, { trigger: "sig/" }]), []);
});

test("a duplicated trigger reports each of its other warnings once", () => {
  const map = byTrigger([{ trigger: "sig" }, { trigger: "si" }, { trigger: "sig" }]);
  assert.deepEqual(map.get("sig").map((c) => c.kind).sort(), ["duplicate", "fires-mid-word", "unreachable"]);
  assert.deepEqual(map.get("si").map((c) => c.kind), ["fires-mid-word"]);
});

test("byTrigger groups the warnings", () => {
  const map = byTrigger([{ trigger: "si" }, { trigger: "sig" }]);
  assert.equal(map.get("sig").length, 2);
  assert.equal(map.get("si").length, 1);
  assert.equal(map.has("nope"), false);
});
