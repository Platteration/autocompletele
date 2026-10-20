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

test("licensing.allowTierOverride is a boolean that a later layer may change", () => {
  assert.deepEqual(orgPolicy.parse({}).licensing, { allowTierOverride: false });
  assert.equal(orgPolicy.parse({ licensing: { allowTierOverride: true } }).licensing.allowTierOverride, true);
  const loose = orgPolicy.parse({ licensing: { allowTierOverride: "yes" } });
  assert.equal(loose.licensing.allowTierOverride, false);
  assert.ok(loose.warnings.some((w) => /licensing.allowTierOverride ignored: use true or false/.test(w)));
  assert.equal(orgPolicy.parse({ licensing: "x" }).licensing.allowTierOverride, false);
  assert.equal(orgPolicy.parse(orgPolicy.merge([{ licensing: { allowTierOverride: true } }, { licensing: { allowTierOverride: false } }])).licensing.allowTierOverride, false);
  assert.equal(orgPolicy.parse(orgPolicy.merge([{ licensing: { allowTierOverride: true } }, {}])).licensing.allowTierOverride, true);
});

test("threadMemory.enabled is a boolean, on by default, and a later layer may turn it off", () => {
  assert.deepEqual(orgPolicy.parse({}).threadMemory, { enabled: true });
  assert.equal(orgPolicy.parse({ threadMemory: { enabled: false } }).threadMemory.enabled, false);
  const loose = orgPolicy.parse({ threadMemory: { enabled: "no" } });
  assert.equal(loose.threadMemory.enabled, true);
  assert.ok(loose.warnings.some((w) => /threadMemory.enabled ignored: use true or false/.test(w)));
  assert.equal(orgPolicy.parse(orgPolicy.merge([{ threadMemory: { enabled: true } }, { threadMemory: { enabled: false } }])).threadMemory.enabled, false);
  assert.equal(orgPolicy.parse(orgPolicy.merge([{ threadMemory: { enabled: false } }, {}])).threadMemory.enabled, false);
});

test("update servers are https only, channels are plain names, and later layers replace the whole block", () => {
  assert.deepEqual(orgPolicy.parse({}).updates, { url: null, channel: "latest" });
  assert.deepEqual(orgPolicy.parse({ updates: { url: " https://updates.example/actle/ ", channel: "beta" } }).updates, { url: "https://updates.example/actle", channel: "beta" });
  const plain = orgPolicy.parse({ updates: { url: "http://updates.example/actle", channel: "Beta Channel" } });
  assert.deepEqual(plain.updates, { url: null, channel: "latest" });
  assert.ok(plain.warnings.some((w) => /updates.url ignored: only https/.test(w)));
  assert.ok(plain.warnings.some((w) => /updates.channel ignored/.test(w)));
  assert.deepEqual(orgPolicy.parse({ updates: "https://updates.example" }).updates, { url: null, channel: "latest" });
  const merged = orgPolicy.parse(orgPolicy.merge([{ updates: { url: "https://a.example", channel: "beta" } }, { updates: { url: "https://b.example" } }]));
  assert.deepEqual(merged.updates, { url: "https://b.example", channel: "latest" }, "a later layer with a url replaces the block, channel included");
  assert.equal(orgPolicy.parse(orgPolicy.merge([{ updates: { url: "https://a.example" } }, { updates: { channel: "beta" } }])).updates.url, "https://a.example", "a layer without a url leaves the block alone");
});

test("a warning rule without a fix is valid; a fix must point at something that exists", () => {
  const policy = orgPolicy.parse({ keywordRules: [
    { id: "card", action: "warn", detect: ["card-number"], message: "No card numbers." },
    { id: "fix", action: "warn", keywords: ["contract"], message: "Add it.", insert: { kind: "shorthand", trigger: "nope/" } },
  ] });
  assert.deepEqual(policy.keywordRules.map((r) => r.id), ["card"]);
  assert.ok(policy.warnings.some((w) => /fix ignored: shortcut nope\//.test(w)));
});

// Collections: named bundles shared with the groups in their audience.
const SHARED = {
  library: [{ trigger: "sig/", expansion: "Kind regards" }],
  keywordRules: [{ id: "refund", keywords: ["refund"], insert: "Refund policy" }, { keywords: ["nameless"], insert: "x" }],
  documents: { shortcuts: [{ trigger: "/hr", documents: [{ path: "h.pdf" }] }] },
  collections: [
    { id: "shipping-catalogue", label: "Shipping catalogue", audience: ["Shipping"], library: [{ trigger: "eta/", expansion: "ETA [[date]]" }, { trigger: "sig/", expansion: "Shipping sig" }],
      keywordRules: [{ keywords: ["customs"], insert: { kind: "shorthand", trigger: "eta/" } }],
      documents: { shortcuts: [{ trigger: "/ship", documents: [{ path: "s.pdf" }] }] },
      lookups: [{ trigger: "/cust", label: "Customer", source: { kind: "csv", path: "S:/c.csv", key: "id" }, template: "[[id]]" }] },
    { id: "shipping-contacts", label: "Shipping contacts", audience: ["engineering", "shipping"], library: [{ trigger: "shipdesk/", expansion: "shipping@example.com" }, { trigger: "eta/", expansion: "second eta" }] },
    { id: "house-style", library: [{ trigger: "brand/", expansion: "actle" }] },
  ],
};

test("collections reach only the desks whose groups are in the audience; an absent audience means everyone", () => {
  const none = orgPolicy.parse(SHARED);
  assert.deepEqual(none.groups, []);
  assert.deepEqual(none.library.map((s) => s.trigger), ["sig/", "brand/"], "no groups: shared items plus the everyone-collection");
  assert.deepEqual(none.collections.map((c) => [c.id, c.applied]), [["shipping-catalogue", false], ["shipping-contacts", false], ["house-style", true]]);
  assert.deepEqual(none.collections[0].members, { library: [], keywordRules: [], documents: [], lookups: [] }, "hidden collections carry no content");
  assert.deepEqual(none.collections[0].audience, ["shipping"], "audience names are lower-cased");
  assert.equal(none.collections[2].label, "house-style", "label defaults to the id");
  assert.deepEqual(none.warnings, [], "a desk is not warned about collections it does not receive");

  const eng = orgPolicy.parse(SHARED, { groups: ["Engineering", "ENGINEERING"] });
  assert.deepEqual(eng.groups, ["engineering"]);
  assert.deepEqual(eng.library.map((s) => s.trigger), ["sig/", "shipdesk/", "eta/", "brand/"], "shared first, then the collections it receives in policy order");
  assert.deepEqual(eng.collections.map((c) => c.applied), [false, true, true]);
  assert.equal(eng.lookups.length, 0, "the catalogue's lookup is not shared with engineering");

  const ship = orgPolicy.parse(SHARED, { groups: ["shipping"] });
  assert.deepEqual(ship.library.map((s) => s.trigger), ["sig/", "eta/", "shipdesk/", "brand/"], "shared first, then collections in policy order");
  assert.equal(ship.library.find((s) => s.trigger === "sig/").expansion, "Kind regards", "what everyone has wins over a collection");
  assert.ok(ship.warnings.includes("shortcut sig/ in collection shipping-catalogue ignored: already shared with everyone"));
  assert.ok(ship.warnings.includes("shortcut eta/ in collection shipping-contacts ignored: collection shipping-catalogue defines it first"));
  assert.deepEqual(ship.keywordRules.map((r) => r.id), ["refund", "keyword-1", "shipping-catalogue/keyword-0"], "a nameless collection rule gets its own id");
  assert.deepEqual(ship.documents.shortcuts.map((d) => d.trigger), ["/hr", "/ship"]);
  assert.deepEqual(ship.lookups.map((l) => l.trigger), ["/cust"]);
  assert.deepEqual(ship.collections[0].members, { library: ["eta/"], keywordRules: ["shipping-catalogue/keyword-0"], documents: ["/ship"], lookups: ["/cust"] });
  assert.deepEqual(orgPolicy.collectionIndex(ship), {
    library: { "brand/": "house-style", "eta/": "shipping-catalogue", "shipdesk/": "shipping-contacts" },
    keywordRules: { "shipping-catalogue/keyword-0": "shipping-catalogue" },
    documents: { "/ship": "shipping-catalogue" },
    lookups: { "/cust": "shipping-catalogue" },
  });

  const all = orgPolicy.parse(SHARED, { groups: "*" });
  assert.equal(all.groups, "*");
  assert.deepEqual(all.collections.map((c) => c.applied), [true, true, true]);
  assert.equal(all.library.length, 4);
  assert.deepEqual(orgPolicy.parse(SHARED, { groups: "everything" }).library.length, 2, "only the exact * means every collection");
  assert.deepEqual(orgPolicy.parse(SHARED, { groups: ["*"] }).library.length, 2, "a group literally named * is not valid");
});

test("collections are validated one by one, merged by id across layers, and checked for dangling references", () => {
  const bad = orgPolicy.parse({
    collections: [
      { id: "Bad Id", library: [{ trigger: "a/", expansion: "a" }] },
      { id: "ok", audience: ["Ops Team!", 5], library: [{ trigger: "b/", expansion: "b" }] },
      { id: "dup", library: [{ trigger: "c/", expansion: "c" }] },
      { id: "dup", library: [{ trigger: "d/", expansion: "d" }] },
      { id: "scoped", audience: "ops", keywordRules: [{ id: "r", keywords: ["x"], insert: { kind: "shorthand", trigger: "nowhere/" } }], library: [{ trigger: "", expansion: "" }] },
      "not an object",
    ],
  }, { groups: ["ops"] });
  assert.ok(bad.warnings.includes("collection 0 ignored: id must be lower-case letters, digits and dashes"));
  assert.ok(bad.warnings.includes("collection ok: audience group \"Ops Team!\" ignored: use lower-case letters, digits and dashes"));
  assert.ok(bad.warnings.includes("collection ok ignored: no usable audience group"), "an audience with no usable group shares with nobody, not with everyone");
  assert.ok(bad.warnings.includes("collection dup ignored: duplicate id"));
  assert.ok(bad.warnings.includes("collection 5 ignored: id must be lower-case letters, digits and dashes"));
  assert.ok(bad.warnings.includes("collection scoped: 1 library entries ignored (empty or duplicate trigger)"));
  assert.ok(bad.warnings.includes("keyword rule r ignored: shortcut nowhere/ is not in the policy library"));
  assert.deepEqual(bad.library.map((s) => s.trigger), ["c/"]);
  assert.deepEqual(bad.collections.map((c) => c.id), ["dup", "scoped"]);
  assert.deepEqual(bad.collections[1].members.keywordRules, [], "a dropped rule leaves the members list too");
  assert.ok(orgPolicy.parse({ collections: "x" }).warnings.includes("collections ignored: not a list"));

  const merged = orgPolicy.merge([
    { collections: [{ id: "a", audience: ["g"], library: [{ trigger: "a1/", expansion: "org" }] }, { id: "b", library: [{ trigger: "b1/", expansion: "org" }] }] },
    { collections: [{ id: "a", audience: ["g"], library: [{ trigger: "a2/", expansion: "team" }] }, { trigger: "loose" }] },
  ]);
  assert.deepEqual(merged.collections.map((c) => c.id), ["a", "b", undefined], "a later layer replaces the collection in its first-seen slot; keyless ones go last");
  assert.deepEqual(orgPolicy.parse(merged, { groups: ["g"] }).library.map((s) => s.trigger), ["a2/", "b1/"], "the whole collection is replaced in its slot, a1/ is gone");
  assert.equal("collections" in orgPolicy.merge([{ library: [] }]), false, "no layer with collections: the key is not emitted");

  // A rule in a hidden collection is never checked; the same policy under "*" reports it.
  const hiddenBad = { collections: [{ id: "h", audience: ["other"], keywordRules: [{ id: "r", keywords: ["x"], insert: { kind: "shorthand", trigger: "gone/" } }] }] };
  assert.deepEqual(orgPolicy.parse(hiddenBad).warnings, []);
  assert.ok(orgPolicy.parse(hiddenBad, { groups: "*" }).warnings.some((w) => /keyword rule r ignored/.test(w)));
  // The example policy is clean for every desk.
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "shared", "org-policy.example.json"), "utf8"));
  assert.deepEqual(orgPolicy.parse(example).warnings, []);
  assert.deepEqual(orgPolicy.parse(example, { groups: "*" }).warnings, []);
});
