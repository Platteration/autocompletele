const test = require("node:test");
const assert = require("node:assert/strict");
const keywords = require("../core/keyword-rules.js");

test("normalizeRules validates and labels rules, skipping unusable ones", () => {
  const { rules, warnings } = keywords.normalizeRules([
    { keywords: ["refund", " returns "], insert: { kind: "text", text: "Policy..." } },
    { id: "docs", keywords: "customs", match: "all", caseSensitive: true, insert: { kind: "document", shortcut: "/sld" } },
    { id: "sh", keywords: ["hours"], insert: { kind: "shorthand", trigger: "hrs/" } },
    { id: "plain", keywords: ["hi"], insert: "Just a string" },
    { id: "nokeys", keywords: [], insert: { kind: "text", text: "x" } },
    { id: "notext", keywords: ["x"], insert: { kind: "text", text: "" } },
    { id: "notrigger", keywords: ["x"], insert: { kind: "shorthand" } },
    { id: "noshortcut", keywords: ["x"], insert: { kind: "document" } },
    null,
    { id: "sh", keywords: ["dup"], insert: "dup" },
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["keyword-0", "docs", "sh", "plain", "sh-dup"]);
  assert.equal(rules[0].label, "refund, returns");
  assert.deepEqual(rules[0].keywords, ["refund", "returns"]);
  assert.equal(rules[0].match, "any");
  assert.equal(rules[1].caseSensitive, true);
  assert.deepEqual(rules[3].insert, { kind: "text", text: "Just a string" });
  assert.equal(warnings.length, 5);
});

test("detect matches whole words, any or all, case-insensitively by default", () => {
  const { rules } = keywords.normalizeRules([
    { id: "any", keywords: ["refund", "return"], insert: "a" },
    { id: "all", keywords: ["customs", "shipment"], match: "all", insert: "b" },
    { id: "cs", keywords: ["ID"], caseSensitive: true, insert: "c" },
    { id: "accent", keywords: ["café"], insert: "d" },
  ]);
  const hits = (text) => keywords.detect(text, rules).map((h) => h.rule.id);
  assert.deepEqual(hits("I want a Refund please"), ["any"]);
  assert.deepEqual(hits("returns are open"), []);
  assert.deepEqual(hits("the shipment cleared customs"), ["all"]);
  assert.deepEqual(hits("the shipment is late"), []);
  assert.deepEqual(hits("my id is 5"), []);
  assert.deepEqual(hits("my ID is 5"), ["cs"]);
  assert.deepEqual(hits("meet at the café now"), ["accent"]);
  assert.deepEqual(hits("meet at the cafés now"), []);
  assert.deepEqual(keywords.detect("refund", { rules }).map((h) => h.matched), [["refund"]]);
});

test("detect offers each rule once per field session and looks only at recent text", () => {
  const { rules } = keywords.normalizeRules([{ id: "r", keywords: ["refund"], insert: "a" }]);
  const state = keywords.createState();
  assert.equal(keywords.detect("about the refund ", rules, state).length, 1);
  assert.equal(keywords.detect("about the refund again ", rules, state).length, 0);
  state.reset();
  assert.equal(keywords.detect("about the refund again ", rules, state).length, 1);
  state.reset();
  state.dismiss("r");
  assert.equal(keywords.detect("refund ", rules, state).length, 0);
  const old = "refund " + "x".repeat(600);
  assert.equal(keywords.detect(old, rules, keywords.createState()).length, 0);
  assert.equal(keywords.detect(old, rules, keywords.createState(), { windowChars: 1000 }).length, 1);
});
