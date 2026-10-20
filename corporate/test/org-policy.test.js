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
  assert.equal(policy.keywordRules.length, 8);
  assert.deepEqual(policy.keywordRules.filter((r) => r.action === "warn").map((r) => r.id), ["contract-disclaimer", "card-numbers", "bank-details", "attachment-reminder", "external-recipients"]);
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

test("layers merge field by field, team rules first, shortcuts and rules by key", () => {
  const merged = orgPolicy.merge([
    {
      organization: "Org", serial: 3, typing: { charsPerMinute: 200, secondsPerAttachment: 20 },
      capture: { defaultMode: "triggers", apps: [{ id: "mail", match: { process: "outlook" }, mode: "learn" }] },
      library: { version: 1, shorthands: [{ trigger: "sig/", expansion: "Org sig" }, { trigger: "hrs/", expansion: "9-5" }] },
      keywordRules: [{ id: "returns", keywords: ["refund"], insert: "Org returns text" }],
      documents: { shortcuts: [{ trigger: "/hr", documents: [{ path: "S:/hr.pdf" }] }] },
    },
    null,
    {
      typing: { charsPerMinute: 260 },
      capture: { apps: [{ id: "chat", match: { process: "teams" }, mode: "off" }] },
      library: [{ trigger: "sig/", expansion: "Team sig" }],
      keywordRules: [{ id: "returns", keywords: ["return"], insert: "Team returns text" }, { keywords: ["hello"], insert: "x" }],
      documents: { shortcuts: [{ trigger: "/sld", documents: [{ path: "S:/sld.pdf" }] }] },
    },
  ]);
  assert.equal(merged.organization, "Org");
  assert.deepEqual(merged.typing, { charsPerMinute: 260, secondsPerAttachment: 20 });
  assert.equal(merged.capture.defaultMode, "triggers");
  assert.deepEqual(merged.capture.apps.map((a) => a.id), ["chat", "mail"]);
  assert.deepEqual(merged.library.shorthands.map((s) => [s.trigger, s.expansion]), [["sig/", "Team sig"], ["hrs/", "9-5"]]);
  assert.deepEqual(merged.keywordRules.map((r) => r.insert), ["Team returns text", "x"]);
  assert.deepEqual(merged.documents.shortcuts.map((s) => s.trigger), ["/hr", "/sld"]);
  assert.equal(merged.serial, undefined, "serials belong to each signed layer, not the merge");
  const policy = orgPolicy.parse(merged);
  assert.deepEqual(policy.warnings, []);
  assert.equal(policy.typing.charsPerMinute, 260);
  assert.deepEqual(orgPolicy.merge([]), {});
  assert.deepEqual(orgPolicy.merge("nope"), {});
});

test("the kill switch pauses from any layer and carries a message", () => {
  assert.deepEqual(orgPolicy.parse({}).paused, { active: false, message: "" });
  assert.deepEqual(orgPolicy.parse({ paused: true }).paused, { active: true, message: "" });
  assert.deepEqual(orgPolicy.parse({ paused: { message: " Under review " } }).paused, { active: true, message: "Under review" });
  assert.deepEqual(orgPolicy.parse({ paused: { active: false, message: "x" } }).paused, { active: false, message: "" });
  assert.deepEqual(orgPolicy.parse({ paused: "yes" }).paused, { active: false, message: "" });
  const merged = orgPolicy.merge([{ paused: { message: "Org-wide pause" } }, { paused: { active: false } }]);
  assert.deepEqual(orgPolicy.parse(merged).paused, { active: true, message: "Org-wide pause" });
  assert.equal(orgPolicy.parse(orgPolicy.merge([{}, { paused: true }])).paused.active, true);
  assert.equal(orgPolicy.parse({ serial: 12 }).serial, 12);
  assert.equal(orgPolicy.parse({ serial: -1 }).serial, null);
});

test("reporting settings are validated with safe defaults", () => {
  const base = { team: "", hourlyRate: null, currency: null, includeApps: false, period: "week", periods: 12, endpoint: null, uploadEvery: "week", uploadToken: null };
  assert.deepEqual(orgPolicy.parse({}).reporting, base);
  assert.deepEqual(orgPolicy.parse({ reporting: { team: " Ops ", hourlyRate: "45", currency: "USD", includeApps: true, period: "month", periods: 999, endpoint: " https://collect.example/actle ", uploadEvery: "day", uploadToken: " s3cret " } }).reporting,
    { team: "Ops", hourlyRate: 45, currency: "USD", includeApps: true, period: "month", periods: 366, endpoint: "https://collect.example/actle", uploadEvery: "day", uploadToken: "s3cret" });
  assert.deepEqual(orgPolicy.parse({ reporting: { hourlyRate: -3, includeApps: "yes", period: "year", uploadEvery: "hour" } }).reporting, base);
  const plain = orgPolicy.parse({ reporting: { endpoint: "http://collect.example/actle" } });
  assert.equal(plain.reporting.endpoint, null);
  assert.ok(plain.warnings.some((w) => /reporting.endpoint ignored: only https/.test(w)));
});

test("a warning rule without a fix is valid; a fix must point at something that exists", () => {
  const policy = orgPolicy.parse({ keywordRules: [
    { id: "card", action: "warn", detect: ["card-number"], message: "No card numbers." },
    { id: "fix", action: "warn", keywords: ["contract"], message: "Add it.", insert: { kind: "shorthand", trigger: "nope/" } },
  ] });
  assert.deepEqual(policy.keywordRules.map((r) => r.id), ["card"]);
  assert.ok(policy.warnings.some((w) => /fix ignored: shortcut nope\//.test(w)));
});
