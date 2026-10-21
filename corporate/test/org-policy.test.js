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
  assert.equal(policy.keywordRules.length, 5);
  assert.deepEqual(policy.keywordRules.filter((r) => r.action === "warn").map((r) => r.id), ["contract-disclaimer", "card-numbers"]);
  assert.equal(policy.documents.shortcuts.length, 2);
  assert.equal(policy.typing.charsPerMinute, 200);
  assert.equal(policy.typing.secondsPerFiling, 45);
  assert.equal(policy.retention.corpusDays, 90);
  assert.deepEqual(policy.filing.rules.map((r) => r.id), ["invoice", "purchase-order", "contract", "packing-list"]);
  assert.equal(policy.filing.fallback.label, "Other documents");
  assert.deepEqual(policy.filing.watch.map((w) => w.label), ["Downloads", "Finance scanner"]);
  assert.deepEqual(Object.keys(policy.filing.fields), ["client", "ref"]);
});

test("the filing section is parsed with warnings and merged across layers", () => {
  const empty = orgPolicy.parse({});
  assert.deepEqual(empty.filing, { watch: [], fields: {}, rules: [], fallback: null, dateOrder: "dmy" });
  assert.equal(empty.typing.secondsPerFiling, 45);
  const bad = orgPolicy.parse({ typing: { secondsPerFiling: -2 }, filing: { rules: [{ id: "x", when: { keywords: ["a"] } }], dateOrder: "ymd" } });
  assert.equal(bad.typing.secondsPerFiling, 45);
  assert.deepEqual(bad.filing.rules, []);
  assert.ok(bad.warnings.some((w) => /filing rule x ignored/.test(w)));
  assert.ok(bad.warnings.some((w) => /dateOrder/.test(w)));
  const merged = orgPolicy.merge([
    { filing: { watch: ["~/Downloads"], fields: { client: { values: ["Org Ltd"] } }, rules: [{ id: "invoice", when: { keywords: ["invoice"] }, name: "org_[[date]]" }], fallback: { name: "[[date]]_[[original]]" }, dateOrder: "mdy" } },
    { filing: { watch: [{ path: "~/Downloads", recursive: true }, { path: "S:/Scans" }], fields: { ref: { pattern: "X-\\d+" } }, rules: [{ id: "invoice", when: { keywords: ["invoice"] }, name: "team_[[date]]" }, { id: "memo", when: { keywords: ["memo"] }, name: "memo" }], fallback: null } },
  ]);
  assert.deepEqual(merged.filing.rules.map((r) => r.name), ["team_[[date]]", "memo"]);
  assert.deepEqual(merged.filing.watch, [{ path: "~/Downloads", recursive: true }, { path: "S:/Scans" }]);
  assert.deepEqual(Object.keys(merged.filing.fields), ["client", "ref"]);
  assert.equal(merged.filing.fallback, null, "a later layer may remove the fallback");
  assert.equal(merged.filing.dateOrder, "mdy");
  const parsed = orgPolicy.parse(merged);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.filing.rules.length, 2);
  assert.equal(orgPolicy.merge([{ library: [] }]).filing, undefined);
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

test("the suite sections (WIP) are parsed with warnings and merged across layers", () => {
  const empty = orgPolicy.parse({});
  assert.deepEqual(empty.warnings, []);
  assert.deepEqual(empty.reply.replies, []);
  assert.deepEqual(empty.sheets.vocabularies, {});
  assert.deepEqual(empty.forms.records, []);
  assert.deepEqual(empty.guard.packs, []);
  assert.deepEqual(empty.notes.documents, []);
  for (const section of ["reply", "sheets", "forms", "guard", "notes"]) assert.equal(Object.hasOwn(empty[section], "warnings"), false);
  const bad = orgPolicy.parse({ reply: { replies: [{ id: "x" }] }, sheets: { blocks: [{ trigger: "nope" }] }, forms: { records: [{ id: "r" }] }, guard: { packs: [{ id: "p", rules: [{ id: "q" }] }] }, notes: { documents: [{ id: "d" }] } });
  assert.ok(bad.warnings.some((w) => /reply x ignored/.test(w)), bad.warnings.join("; "));
  assert.ok(bad.warnings.some((w) => /sheets|block/.test(w)));
  assert.ok(bad.warnings.some((w) => /form record r ignored/.test(w)));
  assert.ok(bad.warnings.some((w) => /guard|pack|rule q/.test(w)));
  assert.ok(bad.warnings.some((w) => /notes|document/.test(w)));
  const merged = orgPolicy.merge([
    { reply: { max: 2, extract: { customer: { after: "Customer" } }, replies: [{ id: "late", keywords: ["late"], text: "Org late" }, { id: "ack", keywords: ["ticket"], text: "Org ack" }] },
      sheets: { vocabularies: { customers: ["Acme"] }, blocks: [{ trigger: "/vat", formula: "=1" }] },
      forms: { records: [{ id: "refund", fields: { category: "Refund" } }] },
      guard: { internalDomains: ["example.com"], packs: [{ id: "pci", rules: [{ id: "card", detect: ["card-number"], message: "No cards." }] }] },
      notes: { documents: [{ id: "mins", trigger: "/mins", sections: ["Attendees"] }] } },
    { reply: { replies: [{ id: "late", keywords: ["late", "delayed"], text: "Team late" }] },
      sheets: { vocabularies: { centres: ["CC-1"] }, blocks: [{ trigger: "/vat", formula: "=2" }, { trigger: "/exp", rows: [["a"]] }] },
      forms: { records: [{ id: "memo", fields: { category: "Memo" } }] },
      guard: { internalDomains: ["example.com", "corp.example"], packs: [{ id: "gdpr", rules: [{ id: "ids", detect: ["national-id"], message: "No IDs." }] }] },
      notes: { author: "author", documents: [{ id: "handover", trigger: "/handover", sections: ["Risks"] }] } },
  ]);
  assert.deepEqual(merged.reply.replies.map((r) => r.text), ["Team late", "Org ack"]);
  assert.equal(merged.reply.max, 2);
  assert.deepEqual(Object.keys(merged.sheets.vocabularies), ["customers", "centres"]);
  assert.deepEqual(merged.sheets.blocks.map((b) => b.trigger + b.formula), ["/vat=2", "/expundefined"]);
  assert.deepEqual(merged.forms.records.map((r) => r.id), ["refund", "memo"]);
  assert.deepEqual(merged.guard.internalDomains, ["example.com", "corp.example"]);
  assert.deepEqual(merged.guard.packs.map((p) => p.id), ["pci", "gdpr"]);
  assert.deepEqual(merged.notes.documents.map((d) => d.id), ["mins", "handover"]);
  const parsed = orgPolicy.parse(merged);
  assert.deepEqual(parsed.warnings, [], parsed.warnings.join("; "));
  assert.equal(parsed.reply.replies.length, 2);
  assert.equal(parsed.guard.packs.length, 2);
  assert.equal(orgPolicy.merge([{ library: [] }]).guard, undefined);
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
  assert.deepEqual(orgPolicy.parse({}).reporting, { team: "", hourlyRate: null, currency: null, includeApps: false, period: "week", periods: 12 });
  assert.deepEqual(orgPolicy.parse({ reporting: { team: " Ops ", hourlyRate: "45", currency: "USD", includeApps: true, period: "month", periods: 999 } }).reporting,
    { team: "Ops", hourlyRate: 45, currency: "USD", includeApps: true, period: "month", periods: 366 });
  assert.deepEqual(orgPolicy.parse({ reporting: { hourlyRate: -3, includeApps: "yes", period: "year" } }).reporting,
    { team: "", hourlyRate: null, currency: null, includeApps: false, period: "week", periods: 12 });
});

test("a warning rule without a fix is valid; a fix must point at something that exists", () => {
  const policy = orgPolicy.parse({ keywordRules: [
    { id: "card", action: "warn", detect: ["card-number"], message: "No card numbers." },
    { id: "fix", action: "warn", keywords: ["contract"], message: "Add it.", insert: { kind: "shorthand", trigger: "nope/" } },
  ] });
  assert.deepEqual(policy.keywordRules.map((r) => r.id), ["card"]);
  assert.ok(policy.warnings.some((w) => /fix ignored: shortcut nope\//.test(w)));
});
