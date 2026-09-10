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

test("byTrigger groups the warnings", () => {
  const map = byTrigger([{ trigger: "si" }, { trigger: "sig" }]);
  assert.equal(map.get("sig").length, 2);
  assert.equal(map.get("si").length, 1);
  assert.equal(map.has("nope"), false);
});
