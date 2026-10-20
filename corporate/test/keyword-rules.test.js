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

test("warning rules need a message; their fix is optional and validated", () => {
  const { rules, warnings } = keywords.normalizeRules([
    { id: "disclaimer", action: "warn", keywords: ["contract"], unless: ["This message is confidential"], message: "Add the legal disclaimer.", insert: { kind: "text", text: "This message is confidential." } },
    { id: "card", action: "warn", detect: "card-number", message: "Do not send card numbers by email." },
    { id: "silent", action: "warn", keywords: ["x"] },
    { id: "odd", action: "shout", keywords: ["x"], message: "m" },
    { id: "badfix", action: "warn", keywords: ["x"], message: "m", insert: { kind: "text", text: "" } },
    { id: "nodetector", action: "warn", detect: ["passport"], message: "m" },
    { id: "offer-needs-insert", keywords: ["x"] },
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["disclaimer", "card"]);
  assert.equal(rules[0].action, "warn");
  assert.deepEqual(rules[0].unless, ["This message is confidential"]);
  assert.equal(rules[1].insert, null);
  assert.deepEqual(rules[1].detect, ["card-number"]);
  assert.equal(rules[1].label, "card-number");
  assert.equal(warnings.length, 5);
  assert.ok(warnings.some((w) => /needs a message/.test(w)));
  assert.ok(warnings.some((w) => /offer or warn/.test(w)));
  assert.ok(warnings.some((w) => /unknown detector passport/.test(w)));
});

test("unless phrases anywhere in the field suppress a rule; detectors look at recent text", () => {
  const { rules } = keywords.normalizeRules([
    { id: "disclaimer", action: "warn", keywords: ["contract"], unless: ["This message is  confidential"], message: "Add the disclaimer." },
    { id: "card", action: "warn", detect: ["card-number"], message: "No card numbers." },
    { id: "card-in-quote", action: "warn", keywords: ["quote"], detect: ["card-number"], message: "Both." },
  ]);
  const ids = (text) => keywords.detect(text, rules).map((h) => h.rule.id);
  assert.deepEqual(ids("Please sign the contract today."), ["disclaimer"]);
  assert.deepEqual(ids("THIS MESSAGE IS\nCONFIDENTIAL.\n" + "x ".repeat(400) + "Please sign the contract today."), [], "the phrase can be far above and differently spaced");
  assert.deepEqual(ids("My card is 4111 1111 1111 1111 thanks"), ["card"]);
  assert.deepEqual(ids("Order 4111 1111 1111 1112 thanks"), [], "not a valid card number");
  assert.deepEqual(ids("quote for 4111-1111-1111-1111 "), ["card", "card-in-quote"]);
  assert.deepEqual(keywords.detect("contract", rules)[0].matched, ["contract"]);
  assert.deepEqual(keywords.detect("4111 1111 1111 1111", rules)[0].matched, ["card-number"]);
});

test("identity and bank number detectors verify check digits", () => {
  const { DETECTORS } = keywords;
  const cases = [
    ["iban", "Pay to GB82 WEST 1234 5698 7654 32 please", "Pay to GB82 WEST 1234 5698 7654 33 please"],
    ["iban", "DE89370400440532013000", "DE89370400440532013001"],
    ["uk-ni", "NI number AB 12 34 56 C", "NI number BG 12 34 56 C"],
    ["uk-ni", "ab123456a", "ab123456e"],
    ["us-ssn", "SSN 219-09-9999 on file", "SSN 666-09-9999 on file"],
    ["us-ssn", "123-45-6789", "123-00-6789"],
    ["se-personnummer", "född 811218-9876", "född 811218-9875"],
    ["se-personnummer", "19811218-9876", "811318-9876"],
    ["nl-bsn", "BSN 111222333", "BSN 111222334"],
    ["nl-bsn", "123456782", "000000000"],
  ];
  for (const [name, valid, invalid] of cases) {
    assert.equal(DETECTORS[name](valid, {}, {}), true, name + " should match " + valid);
    assert.equal(DETECTORS[name](invalid, {}, {}), false, name + " should not match " + invalid);
  }
  assert.equal(DETECTORS["nl-bsn"]("order 123456782 shipped", {}, {}), true);
  assert.equal(DETECTORS["nl-bsn"]("ref 1234567821", {}, {}), false, "ten digits are not a BSN");
});

test("external e-mail and missing-attachment detectors use rule parameters and context", () => {
  const { rules, warnings } = keywords.normalizeRules([
    { id: "ext", action: "warn", detect: ["external-email-domain"], params: { allowedDomains: ["Example.com", "partner.org"] }, message: "External address." },
    { id: "noparams", action: "warn", detect: ["external-email-domain"], message: "m" },
    { id: "attach", action: "warn", keywords: ["attached", "attachment"], detect: ["missing-attachment"], apps: ["OUTLOOK.EXE", "/Applications/Thunderbird.app"], message: "Nothing is attached yet." },
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["ext", "attach"]);
  assert.deepEqual(rules[0].params.allowedDomains, ["example.com", "partner.org"]);
  assert.deepEqual(rules[1].apps, ["outlook", "thunderbird"]);
  assert.ok(warnings.some((w) => /noparams ignored: external-email-domain needs/.test(w)));
  const ids = (text, context) => keywords.detect(text, rules, null, { context }).map((h) => h.rule.id);
  assert.deepEqual(ids("cc bob@sales.example.com and ann@partner.org", {}), []);
  assert.deepEqual(ids("cc bob@gmail.com", {}), ["ext"]);
  assert.deepEqual(ids("please find attached the file", { app: "C:/Program Files/OUTLOOK.EXE", attachments: 0 }), ["attach"]);
  assert.deepEqual(ids("please find attached the file", { app: "outlook", attachments: 2 }), []);
  assert.deepEqual(ids("please find attached the file", { app: "notepad", attachments: 0 }), [], "rule limited to mail clients");
  assert.deepEqual(ids("please find attached the file", {}), [], "no application known: an app-restricted rule stays quiet");
});
