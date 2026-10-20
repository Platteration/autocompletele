const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const orgPolicy = require("../core/org-policy.js");

test("the shipped example policy parses without warnings", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "shared", "org-policy.example.json"), "utf8");
  const policy = orgPolicy.parse(raw);
  assert.deepEqual(policy.warnings, []);
  assert.equal(policy.organization, "Example Logistics Ltd");
  assert.equal(policy.capture.apps.length, 4);
  assert.equal(policy.library.length, 4);
  assert.equal(policy.keywordRules.length, 3);
  assert.equal(policy.documents.shortcuts.length, 2);
  assert.equal(policy.typing.charsPerMinute, 200);
  assert.equal(policy.retention.corpusDays, 90);
});

test("an empty or missing policy is valid and uses defaults", () => {
  for (const input of [undefined, null, {}, "{}"]) {
    const policy = orgPolicy.parse(input);
    assert.deepEqual(policy.warnings, []);
    assert.equal(policy.capture.defaultMode, "triggers");
    assert.equal(policy.learning.minCount, 3);
  }
});

test("bad input degrades with warnings instead of refusing", () => {
  assert.match(orgPolicy.parse("{not json").warnings[0], /not valid JSON/);
  assert.match(orgPolicy.parse("[]").warnings[0], /not an object/);
  assert.match(orgPolicy.parse(42).warnings[0], /not an object/);
  const policy = orgPolicy.parse({
    version: 2,
    typing: { charsPerMinute: -1 },
    capture: { apps: [{ id: "x", mode: "learn" }] },
    library: [{ trigger: "a/", expansion: "A" }, { trigger: "a/", expansion: "dup" }, { trigger: "" }],
    keywordRules: [
      { id: "ok", keywords: ["a"], insert: { kind: "shorthand", trigger: "a/" } },
      { id: "missing", keywords: ["b"], insert: { kind: "shorthand", trigger: "nope/" } },
      { id: "nodoc", keywords: ["c"], insert: { kind: "document", shortcut: "/none" } },
    ],
    learning: { minCount: 1 },
    retention: { metricsDays: "soon" },
  });
  assert.equal(policy.typing.charsPerMinute, 200);
  assert.deepEqual(policy.keywordRules.map((r) => r.id), ["ok"]);
  assert.equal(policy.library.length, 1);
  assert.equal(policy.learning.minCount, 2);
  assert.equal(policy.retention.metricsDays, 365);
  assert.ok(policy.warnings.some((w) => /version 2/.test(w)));
  assert.ok(policy.warnings.some((w) => /capture rule x/.test(w)));
  assert.ok(policy.warnings.some((w) => /2 library entries ignored/.test(w)));
  assert.ok(policy.warnings.some((w) => /nope\//.test(w)));
  assert.ok(policy.warnings.some((w) => /\/none/.test(w)));
});
