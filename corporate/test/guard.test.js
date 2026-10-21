const test = require("node:test");
const assert = require("node:assert/strict");
const guard = require("../core/guard.js");

const { DETECTORS } = guard;
const DISCLAIMER = "This message is confidential and intended for the addressee only.";

const GUARD = {
  internalDomains: ["Example.com", "@corp.example.org", "not a domain"],
  internalCodes: ["\\bPRJ-[A-Z]{3,8}\\b", "("],
  packs: [
    { id: "pci", label: "Card data (PCI DSS)", rules: [
      { id: "card", detect: ["card-number"], message: "A card number is in this message.", fix: { kind: "remove", with: "[card removed]" }, severity: "block" },
    ] },
    { id: "gdpr", label: "Personal data (GDPR)", rules: [
      { id: "ids", detect: ["national-id"], countries: ["es", "FR", "DE"], message: "A national ID number is going outside.", fix: { kind: "remove" }, recipients: "external" },
      { id: "ids-and-phones", detect: ["national-id", "phone"], countries: ["FR"], message: "Personal numbers.", fix: { kind: "remove" }, severity: "fatal" },
    ] },
    { id: "legal", label: "Legal", rules: [
      { id: "contract", keywords: ["contract"], unless: ["This message is confidential"], message: "Contract without the disclaimer.", fix: { kind: "text", text: DISCLAIMER }, recipients: "external" },
      { id: "promises", detect: ["forbidden-phrase"], phrases: ["guaranteed", "refund within 24 hours"], message: "Do not promise this.", fix: { kind: "remove" }, severity: "info" },
      { id: "codes", detect: ["internal-code"], keywords: ["project", "status"], match: "all", message: "Internal project code to an outside recipient.", recipients: "external", apps: ["C:\\Program Files\\Microsoft Office\\OUTLOOK.EXE"] },
      { id: "secrets", detect: ["secret"], message: "Never send passwords.", fix: { kind: "replace" }, recipients: "outside" },
      { id: "promises", keywords: ["promise"], message: "Duplicate id.", fix: { kind: "shorthand", trigger: "promise/" } },
      { id: "typo", detect: ["credit-card"], message: "m" },
      { id: "nothing", message: "m" },
      { id: "nophrases", detect: ["forbidden-phrase"], message: "m" },
      { id: "germany", detect: ["national-id"], countries: ["DE"], message: "m" },
      { id: "nomessage", keywords: ["x"] },
      { id: "emptyfix", keywords: ["y"], message: "m", fix: { kind: "text", text: "  " } },
      { id: "notrigger", keywords: ["z"], message: "m", fix: { kind: "shorthand" } },
      null,
    ] },
    { id: "empty", rules: [{ id: "nomessage-2", keywords: ["x"] }] },
    "junk",
  ],
};

const config = guard.normalizeGuard(GUARD);
const OUTSIDE = { recipients: ["colleague@example.com", "Buyer <buyer@customer.test>"], app: "outlook" };
const INSIDE = { recipients: ["a@example.com", "Team <b@sales.example.com>", "c@corp.example.org"], app: "outlook" };
const ids = (hits) => hits.map((hit) => hit.rule.id);

test("normalizeGuard keeps usable packs and rules and explains what it dropped", () => {
  assert.deepEqual(config.internalDomains, ["example.com", "corp.example.org"]);
  assert.equal(config.internalCodes.length, 1);
  assert.deepEqual(config.packs.map((p) => [p.id, p.label]), [["pci", "Card data (PCI DSS)"], ["gdpr", "Personal data (GDPR)"], ["legal", "Legal"]]);
  assert.deepEqual(config.packs[2].rules.map((r) => r.id), ["contract", "promises", "codes", "secrets", "promises-dup", "emptyfix", "notrigger"]);
  const rule = (id) => config.packs.flatMap((p) => p.rules).find((r) => r.id === id);
  assert.deepEqual(rule("ids").options.countries, ["ES", "FR"]);
  assert.equal(rule("ids").pack, "gdpr");
  assert.equal(rule("ids-and-phones").severity, "warn");
  assert.equal(rule("card").severity, "block");
  assert.equal(rule("card").recipients, "any");
  assert.equal(rule("secrets").recipients, "any", "an unreadable recipients value widens the rule");
  assert.equal(rule("secrets").fix, null);
  assert.equal(rule("emptyfix").fix, null);
  assert.deepEqual(rule("promises-dup").fix, { kind: "shorthand", trigger: "promise/" });
  assert.deepEqual(rule("contract").fix, { kind: "text", text: DISCLAIMER, position: "end" });
  assert.deepEqual(rule("codes").apps, ["outlook"]);
  const text = config.warnings.join("\n");
  const expected = [/internal domain not a domain ignored/, /internal code \( ignored: invalid pattern/, /rule ids: unknown countries DE \(known: US, GB, ES, FR\) ignored/,
    /rule ids-and-phones: severity must be warn or info or block; using warn/, /rule secrets: recipients must be any or external; using any/, /rule secrets: fix ignored, kind must be/,
    /rule typo ignored: unknown detector credit-card/, /rule nothing ignored: no keywords or detectors/, /rule nophrases ignored: forbidden-phrase needs/,
    /rule germany ignored: no supported country: DE/, /rule nomessage ignored: a warning needs a message/,
    /rule emptyfix: fix ignored, empty text/, /rule notrigger: fix ignored, no shorthand trigger/, /rule legal\/12 ignored: not an object/,
    /rule nomessage-2 ignored/, /pack empty ignored: no usable rules/, /pack 4 ignored: not an object/];
  for (const pattern of expected) assert.match(text, pattern);
  assert.equal(config.warnings.length, expected.length);
});

test("normalizeGuard never refuses the section", () => {
  assert.deepEqual(guard.normalizeGuard(undefined).warnings, []);
  assert.deepEqual(guard.normalizeGuard(undefined).packs, []);
  assert.match(guard.normalizeGuard("nope").warnings[0], /guard section ignored: not an object/);
  assert.match(guard.normalizeGuard({ packs: "x" }).warnings[0], /packs ignored: not a list/);
  const noCodes = guard.normalizeGuard({ packs: [{ id: "p", rules: [{ id: "c", detect: ["internal-code"], message: "m" }] }] });
  assert.match(noCodes.warnings.join("\n"), /rule c ignored: internal-code needs `internalCodes`/);
  const noDomains = guard.normalizeGuard({ packs: [{ id: "p", rules: [{ id: "e", keywords: ["x"], message: "m", recipients: "external" }] }] });
  assert.deepEqual(noDomains.warnings, ["guard has no internalDomains: every recipient counts as external for e"]);
  assert.deepEqual(ids(guard.check("x", { recipients: ["a@example.com"] }, noDomains)), ["e"]);
});

test("card-number finds Luhn-valid numbers with their position, masked to the last four digits", () => {
  assert.deepEqual(DETECTORS["card-number"]("pay 4111 1111 1111 1111 now"), [{ kind: "card-number", value: "**** **** **** 1111", index: 4 }]);
  assert.deepEqual(DETECTORS["card-number"]("4111-1111-1111-1111"), [{ kind: "card-number", value: "****-****-****-1111", index: 0 }]);
  assert.deepEqual(DETECTORS["card-number"]("pay 4111 1111 1111 1112 now"), [], "fails the Luhn check");
  assert.deepEqual(DETECTORS["card-number"]("order 123456"), []);
});

test("iban checks mod 97, compact or grouped, and drops a trailing word the grouping swallowed", () => {
  assert.deepEqual(DETECTORS.iban("IBAN DE89 3704 0044 0532 0130 00 thanks"), [{ kind: "iban", value: "DE** **** **** **** **** 00", index: 5 }]);
  assert.deepEqual(DETECTORS.iban("gb82west12345698765432").map((f) => f.value), ["gb******************32"]);
  assert.deepEqual(DETECTORS.iban("BE68 5390 0754 7034 SENT").map((f) => f.value), ["BE** **** **** **34"]);
  assert.deepEqual(DETECTORS.iban("DE89 3704 0044 0532 0130 01"), [], "wrong check digits");
  assert.deepEqual(DETECTORS.iban("AB12 CDEF GHIJ"), []);
});

test("email masks the local part and keeps the domain", () => {
  assert.deepEqual(DETECTORS.email("write to jane.doe@example.com."), [{ kind: "email", value: "j***@example.com", index: 9 }]);
  assert.deepEqual(DETECTORS.email("jane@localhost and user@10.0.0.1 and @example.com"), []);
});

test("phone is loose but skips dates and short numbers", () => {
  assert.deepEqual(DETECTORS.phone("call +44 20 7946 0018 or 020 7946 0018"), [
    { kind: "phone", value: "+** ** **** **18", index: 5 },
    { kind: "phone", value: "*** **** **18", index: 25 },
  ]);
  assert.deepEqual(DETECTORS.phone("on 2026-10-21 14:30, 21.10.2026, ext 555-0100, 4111 1111 1111 1111 1"), []);
  assert.equal(DETECTORS.phone("06.12.34.56.78").length, 1, "a French number is not mistaken for a date");
});

test("national-id: US and GB by format rules, ES and FR by check digit", () => {
  const found = (text, countries) => DETECTORS["national-id"](text, { countries }).map((f) => f.country + " " + f.value);
  assert.deepEqual(found("ssn 123-45-6789"), ["US ***-**-**89"]);
  assert.deepEqual(found("666-12-3456 123-00-4567 900-12-3456 123-45-0000"), []);
  assert.deepEqual(found("NI AB 12 34 56 C"), ["GB ** ** ** *6 C"]);
  assert.deepEqual(found("BG 12 34 56 C, DA123456C, AB123456E"), []);
  assert.deepEqual(found("DNI 12345678Z, NIE X1234567L"), ["ES *******8Z", "ES *******7L"]);
  assert.deepEqual(found("12345678A X1234567T"), []);
  assert.deepEqual(found("1 84 03 76 451 089 96 and 175122A12345653"), ["FR * ** ** ** *** *** 96", "FR *************53"]);
  assert.deepEqual(found("1 84 03 76 451 089 97"), []);
  assert.deepEqual(found("ssn 123-45-6789, 12345678Z", ["ES"]), ["ES *******8Z"], "countries narrow the search");
});

test("forbidden-phrase and internal-code use the rule's phrases and the policy's patterns", () => {
  assert.deepEqual(DETECTORS["forbidden-phrase"]("It is Guaranteed. We refund within 24 hours.", { phrases: ["guaranteed", "refund within 24 hours"] }), [
    { kind: "forbidden-phrase", value: "Guaranteed", index: 6 },
    { kind: "forbidden-phrase", value: "refund within 24 hours", index: 21 },
  ]);
  assert.deepEqual(DETECTORS["forbidden-phrase"]("not guaranteedly", { phrases: ["guaranteed"] }), []);
  assert.deepEqual(DETECTORS["forbidden-phrase"]("anything", {}), []);
  assert.deepEqual(DETECTORS["internal-code"]("see PRJ-ORCA", { codes: config.internalCodes }), [{ kind: "internal-code", value: "PRJ-****", index: 4 }]);
  assert.deepEqual(DETECTORS["internal-code"]("see prj-orca", { codes: config.internalCodes }), []);
  assert.deepEqual(DETECTORS["internal-code"]("PRJ", { codes: [/(?=PRJ)/g] }), [], "an empty match is not a finding");
});

test("secret never returns any part of the secret", () => {
  const text = "password: hunter2 and token abcd1234efgh5678ijkl9012mnop, api key = s3cr3t";
  const findings = DETECTORS.secret(text);
  assert.deepEqual(findings, [
    { kind: "secret", value: "password: ****", index: 10 },
    { kind: "secret", value: "api key = ****", index: 68 },
    { kind: "secret", value: "****", index: 28 },
  ]);
  assert.deepEqual(DETECTORS.secret("token: abcd1234efgh5678ijkl9012mnop").length, 1, "a labelled token is one finding");
  assert.deepEqual(DETECTORS.secret("the password field is required"), []);
  for (const raw of ["hunter2", "abcd1234efgh5678ijkl9012mnop", "s3cr3t"]) assert.ok(!JSON.stringify(findings).includes(raw));
});

test("check returns masked findings only", () => {
  const text = "Card 4111 1111 1111 1111, NIE X1234567L, password: hunter2";
  const hits = guard.check(text, OUTSIDE, guard.normalizeGuard({ packs: [{ id: "p", rules: [{ id: "all", detect: ["card-number", "national-id", "secret"], message: "m" }] }] }));
  assert.deepEqual(hits[0].findings.map((f) => f.kind), ["card-number", "national-id", "secret"]);
  const out = JSON.stringify(hits[0].findings);
  for (const raw of ["4111 1111 1111 1111", "X1234567L", "hunter2"]) assert.ok(!out.includes(raw), raw);
});

test("external rules fire only when a recipient is outside the internal domains", () => {
  const text = "Please sign the contract. NIE X1234567L";
  assert.deepEqual(ids(guard.check(text, OUTSIDE, config)), ["ids", "contract"]);
  assert.deepEqual(ids(guard.check(text, INSIDE, config)), [], "subdomains of an internal domain are internal");
  assert.deepEqual(ids(guard.check(text, { recipients: [] }, config)), [], "no recipients known");
  assert.deepEqual(ids(guard.check(text, { recipients: ["Team chat"] }, config)), ["ids", "contract"], "an unreadable recipient counts as external");
  assert.deepEqual(ids(guard.check(text, { recipients: ["x@notexample.com"] }, config)), ["ids", "contract"]);
  assert.equal(guard.hasExternalRecipient(["a@EXAMPLE.com>"], ["example.com"]), false);
});

test("keywords with match all, apps and unless decide whether a rule fires", () => {
  const status = "Project status: PRJ-ORCA is late.";
  assert.deepEqual(ids(guard.check(status, OUTSIDE, config)), ["codes"]);
  assert.deepEqual(ids(guard.check(status, { recipients: OUTSIDE.recipients, app: "teams" }, config)), [], "apps limit the rule");
  assert.deepEqual(ids(guard.check("Project PRJ-ORCA is late.", OUTSIDE, config)), [], "match all needs every keyword");
  assert.deepEqual(ids(guard.check("Project status is late.", OUTSIDE, config)), [], "keywords alone are not enough when the rule has detectors");
  assert.deepEqual(ids(guard.check("The contract.\n\nthis   message is CONFIDENTIAL", OUTSIDE, config)), [], "unless ignores case and spacing");
});

test("each rule fires once per state until it is reset", () => {
  const state = guard.createState();
  const text = "It is guaranteed.";
  assert.deepEqual(ids(guard.check(text, {}, config, state)), ["promises"]);
  assert.deepEqual(ids(guard.check(text + " Again guaranteed.", {}, config, state)), []);
  state.reset();
  assert.deepEqual(ids(guard.check(text, {}, config, state)), ["promises"]);
  state.reset();
  state.dismiss("promises");
  assert.deepEqual(ids(guard.check(text, {}, config, state)), []);
  assert.deepEqual(ids(guard.check(text, {}, config)), ["promises"], "without a state every check reports");
  assert.deepEqual(ids(guard.check(text, {}, GUARD)), ["promises"], "a raw section is normalised on the way");
});

test("applyFix appends the disclaimer once, which also satisfies unless", () => {
  const [hit] = guard.check("Please sign the contract.", OUTSIDE, config);
  const fixed = guard.applyFix("Please sign the contract.", hit);
  assert.equal(fixed, "Please sign the contract.\n\n" + DISCLAIMER);
  assert.equal(guard.applyFix(fixed, hit), fixed, "already there");
  assert.deepEqual(guard.check(fixed, OUTSIDE, config), []);
  const start = Object.assign({}, hit, { fix: { kind: "text", text: "Hello,", position: "start" } });
  assert.equal(guard.applyFix("see the contract", start), "Hello,\n\nsee the contract");
  assert.equal(guard.applyFix("contract\n", hit), "contract\n" + DISCLAIMER, "no extra gap after whitespace");
  assert.equal(guard.applyFix("x", { fix: null }), "x");
});

test("applyFix resolves a shorthand fix through the caller, or leaves the text alone", () => {
  const hit = guard.check("I promise.", {}, config).find((h) => h.rule.id === "promises-dup");
  assert.equal(guard.applyFix("I promise.", hit, (trigger) => (trigger === "promise/" ? "We aim to deliver within a week." : null)), "I promise.\n\nWe aim to deliver within a week.");
  assert.equal(guard.applyFix("I promise.", hit), "I promise.");
  assert.equal(guard.applyFix("I promise.", hit, () => undefined), "I promise.");
});

test("applyFix removes or replaces the findings found again in the text it is given", () => {
  const promise = guard.check("Delivery is guaranteed by Friday.", {}, config)[0];
  assert.equal(guard.applyFix("Delivery is guaranteed by Friday.", promise), "Delivery is by Friday.");
  assert.equal(guard.applyFix("Note: delivery is guaranteed by Friday.", promise), "Note: delivery is by Friday.", "the text moved since the check");
  assert.equal(guard.applyFix("Delivery by Friday.", promise), "Delivery by Friday.", "nothing left to remove");
  const card = guard.check("pay 4111 1111 1111 1111 and 5555 5555 5555 4444", {}, config)[0];
  assert.equal(guard.applyFix("pay 4111 1111 1111 1111 and 5555 5555 5555 4444", card), "pay [card removed] and [card removed]");
  const both = guard.check("NIR 1 84 03 76 451 089 96 ok", {}, config).find((h) => h.rule.id === "ids-and-phones");
  assert.equal(both.findings.length, 2, "the NIR is also a loose phone number");
  assert.equal(guard.applyFix("NIR 1 84 03 76 451 089 96 ok", both), "NIR ok", "overlapping findings are removed once");
  const keywordOnly = guard.normalizeGuard({ packs: [{ id: "p", rules: [{ id: "k", keywords: ["asap"], message: "m", fix: { kind: "remove" } }] }] });
  const hit = guard.check("Reply ASAP please, asap", {}, keywordOnly)[0];
  assert.equal(guard.applyFix("Reply ASAP please, asap", hit), "Reply please, ");
  assert.equal(guard.applyFix("Reply ASAP", { rule: hit.rule, fix: { kind: "remove" } }), "Reply ", "a hand-built remove fix without `with` removes");
});

test("auditEntry and summarise keep counts only", () => {
  const [hit] = guard.check("It is guaranteed.", {}, config);
  assert.deepEqual(guard.auditEntry(hit, "raised", 1000), { rule: "promises", pack: "legal", outcome: "raised", at: 1000 });
  assert.equal(guard.auditEntry(hit, "ignored", 1000), null);
  const entries = [
    { rule: "card", pack: "pci", outcome: "raised", at: 1 },
    { rule: "card", pack: "pci", outcome: "fixed", at: 2 },
    { rule: "card", pack: "pci", outcome: "raised", at: 3 },
    { rule: "card", pack: "pci", outcome: "raised", at: 4 },
    { rule: "card", pack: "pci", outcome: "dismissed", at: 5 },
    { rule: "promises", pack: "legal", outcome: "raised", at: 6 },
    { rule: "contract", pack: "legal", outcome: "raised", at: 7 },
    { rule: "contract", pack: "legal", outcome: "fixed", at: 8 },
    { rule: "card", pack: "pci", outcome: "maybe" },
    { pack: "pci", outcome: "raised" },
    null,
    "junk",
  ];
  const summary = guard.summarise(entries);
  assert.deepEqual(summary.total, { raised: 5, accepted: 2, dismissed: 1, unanswered: 2 });
  assert.deepEqual(summary.byPack, [
    { pack: "pci", raised: 3, accepted: 1, dismissed: 1, unanswered: 1 },
    { pack: "legal", raised: 2, accepted: 1, dismissed: 0, unanswered: 1 },
  ]);
  assert.deepEqual(summary.byRule, [
    { rule: "card", pack: "pci", raised: 3, accepted: 1, dismissed: 1, unanswered: 1 },
    { rule: "contract", pack: "legal", raised: 1, accepted: 1, dismissed: 0, unanswered: 0 },
    { rule: "promises", pack: "legal", raised: 1, accepted: 0, dismissed: 0, unanswered: 1 },
  ]);
  assert.equal(summary.skipped, 4);
  assert.deepEqual(guard.summarise(undefined), { total: { raised: 0, accepted: 0, dismissed: 0, unanswered: 0 }, byPack: [], byRule: [], skipped: 0 });
});

test("assumeExternal lets external rules fire when no recipient is known; known recipients still decide", () => {
  const section = { internalDomains: ["example.com"], assumeExternal: true, packs: [{ id: "p", rules: [{ id: "e", keywords: ["contract"], message: "m", recipients: "external" }] }] };
  const assumed = guard.normalizeGuard(section);
  assert.equal(assumed.assumeExternal, true);
  assert.deepEqual(assumed.warnings, []);
  assert.deepEqual(ids(guard.check("the contract", {}, assumed)), ["e"], "no recipients known: assumed external");
  assert.deepEqual(ids(guard.check("the contract", { recipients: [] }, assumed)), ["e"]);
  assert.deepEqual(ids(guard.check("the contract", { recipients: ["a@example.com"] }, assumed)), [], "known internal recipients win over the assumption");
  assert.deepEqual(ids(guard.check("the contract", { recipients: ["a@customer.test"] }, assumed)), ["e"]);
  assert.equal(guard.normalizeGuard(Object.assign({}, section, { assumeExternal: undefined })).assumeExternal, false, "off by default");
  assert.equal(config.assumeExternal, false);
  assert.deepEqual(ids(guard.check("the contract", {}, config)), [], "off: no recipients known means no external warning");
  const odd = guard.normalizeGuard(Object.assign({}, section, { assumeExternal: "yes" }));
  assert.equal(odd.assumeExternal, false);
  assert.deepEqual(odd.warnings, ["guard assumeExternal must be true or false; using false"]);
  assert.equal(guard.treatAsExternal([], assumed), true);
  assert.equal(guard.treatAsExternal(undefined, config), false);
  assert.equal(guard.treatAsExternal(["Team chat"], config), true, "an unreadable recipient counts as external");
  assert.equal(guard.treatAsExternal(["x@corp.example.org"], GUARD), false, "a raw section is normalised on the way");
});

test("organizationItems names every rule with kind guard", () => {
  assert.deepEqual(guard.organizationItems(config), [
    { trigger: "card", kind: "guard" }, { trigger: "ids", kind: "guard" }, { trigger: "ids-and-phones", kind: "guard" },
    { trigger: "contract", kind: "guard" }, { trigger: "promises", kind: "guard" }, { trigger: "codes", kind: "guard" }, { trigger: "secrets", kind: "guard" },
    { trigger: "promises-dup", kind: "guard" }, { trigger: "emptyfix", kind: "guard" }, { trigger: "notrigger", kind: "guard" },
  ]);
  assert.deepEqual(guard.organizationItems(null), []);
  assert.deepEqual(guard.organizationItems({ packs: [{ id: "p", rules: [{ id: "k", keywords: ["x"], message: "m" }] }] }), [{ trigger: "k", kind: "guard" }], "a raw section works too");
  const report = require("../core/report.js");
  const policy = require("../core/org-policy.js").parse({ guard: { packs: [{ id: "p", rules: [{ id: "k", keywords: ["x"], message: "m" }] }] } });
  assert.deepEqual(report.organizationShortcuts(policy).filter((item) => item.kind === "guard"), [{ trigger: "k", kind: "guard" }]);
});
