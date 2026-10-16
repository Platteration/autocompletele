const test = require("node:test");
const assert = require("node:assert/strict");
const { find } = require("../src/suggestions.js");

const brb = { trigger: "brb/", expansion: "Be right back" };
const brief = { trigger: "brief/", expansion: "Here is the brief" };

test("suggestions need at least two complete graphemes", () => {
  assert.equal(find("", [brb]), null);
  assert.equal(find("b", [brb]), null);
  const emoji = { trigger: "👨‍👩‍👧‍👦a/", expansion: "Family" };
  assert.equal(find("👨‍👩‍👧‍👦", [emoji]), null);
  assert.deepEqual(find("👨‍👩‍👧‍👦a", [emoji]), {
    start: 0, query: "👨‍👩‍👧‍👦a", items: [emoji],
  });
});

test("suggestions return the typed prefix and its UTF-16 replacement start", () => {
  assert.deepEqual(find("Hello 👋 br", [brief, brb]), {
    start: 9, query: "br", items: [brb, brief],
  });
});

test("prefix matching is case-sensitive and does not search expansion text", () => {
  assert.equal(find("BR", [brb]), null);
  assert.equal(find("right", [brb]), null);
  assert.equal(find("rb", [brb]), null);
});

test("suggestions use the same word boundaries as automatic expansion", () => {
  for (const before of ["schoolbr", "2br", "_br", "ébr"]) {
    assert.equal(find(before, [brb]), null, before);
  }
  for (const before of [" br", "/br", "(br", "\nbr"]) {
    assert.equal(find(before, [brb]).start, 1, before);
  }
});

test("an exact trigger is excluded, while a longer trigger can still match", () => {
  assert.equal(find("brb/", [brb]), null);
  const longer = { trigger: "brb/more", expansion: "Later" };
  assert.deepEqual(find("brb/", [brb, longer]).items, [longer]);
});

test("the longest valid prefix gives every result one replacement extent", () => {
  const long = { trigger: "hello brb/", expansion: "Hello and goodbye" };
  assert.deepEqual(find("hello br", [brb, long, brief]), {
    start: 0, query: "hello br", items: [long],
  });
});

test("prefixes may include whitespace and punctuation from a saved trigger", () => {
  const spaced = { trigger: "be right/", expansion: "Back soon" };
  assert.deepEqual(find("be ", [spaced]), { start: 0, query: "be ", items: [spaced] });
  const punctuated = { trigger: ";;hello", expansion: "Hello" };
  assert.deepEqual(find(";;", [punctuated]), { start: 0, query: ";;", items: [punctuated] });
});

test("shortest remaining trigger ranks first, with saved order breaking ties", () => {
  const list = ["bravo", "brd", "brc", "brxyz", "brf", "brg", "brh"]
    .map((trigger) => ({ trigger, expansion: trigger }));
  assert.deepEqual(find("br", list).items, [list[1], list[2], list[4], list[5], list[6]]);
});

test("most-used suggestions rank first, with previous ranking as fallback", () => {
  const used = [
    { id: "brb", trigger: "brb/", expansion: "Be right back" },
    { id: "brief", trigger: "brief/", expansion: "Here is the brief" },
  ];
  assert.deepEqual(find("br", used, { brief: 5 }).items, [used[1], used[0]]);
  assert.deepEqual(find("br", used, { brb: 2, brief: 2 }).items, [used[0], used[1]]);
  assert.deepEqual(find("br", used, {}).items, [used[0], used[1]]);
  assert.deepEqual(find("br", used, { brief: "many" }).items, [used[0], used[1]]);
});

test("remaining length counts graphemes, including emoji and combining marks", () => {
  const family = { trigger: "br👨‍👩‍👧‍👦", expansion: "Family" };
  const mark = { trigger: "bré", expansion: "Accent" };
  const ascii = { trigger: "braa", expansion: "Two" };
  assert.deepEqual(find("br", [ascii, family, mark]).items, [family, mark, ascii]);
});

test("a partial combining mark or joined emoji cannot split a trigger grapheme", () => {
  const mark = { trigger: "abé/", expansion: "Accent" };
  assert.equal(find("abe", [mark]), null);
  assert.equal(find("a👨", [{ trigger: "a👨‍👩‍👧‍👦/", expansion: "Family" }]), null);
  assert.deepEqual(find("abé", [mark]).items, [mark]);
});

test("matching is local to the text immediately before the caret", () => {
  assert.equal(find("br no", [brb]), null);
  assert.equal(find("br ", [brb]), null);
});

test("invalid input and missing snippets produce no suggestions", () => {
  for (const text of [null, undefined, 12, "br"]) {
    assert.equal(find(text, null), null);
  }
  assert.equal(find("br", [null, {}, { trigger: 2 }, { trigger: "" }]), null);
});

test("finding suggestions preserves the saved list and snippet objects", () => {
  const saved = Object.freeze([Object.freeze(brief), Object.freeze(brb)]);
  assert.deepEqual(find("br", saved).items, [brb, brief]);
  assert.deepEqual(saved, [brief, brb]);
});
