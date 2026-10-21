const test = require("node:test");
const assert = require("node:assert/strict");
const forms = require("../core/forms.js");

const FORMS = {
  records: [
    { id: "refund", label: "Refund case", trigger: "refund/", fields: { category: "Refund", priority: "P2", sla: 48, notes: "Hi [[customer]], refund for [[orderRef]] is on its way. [[reason]]", queue: "Billing" } },
    { id: "complaint", trigger: "cmp/", fields: { category: "Complaint", priority: "P1", bad: { x: 1 } } },
    { id: "refund", label: "Second refund", trigger: "refund/", fields: { category: "Refund" } },
    { id: "empty", fields: {} },
    "junk",
  ],
  lookups: [
    { id: "orders", key: "orderRef", keyPattern: "A-\\d{5}", rows: [
      { orderRef: "A-12345", customer: "Mary Jones", email: "mary@example.com", total: 120.5, tags: ["x"] },
      { orderRef: "a-12345", customer: "Duplicate" },
      { customer: "No key" },
      { orderRef: "A-54321", customer: "John Smith", email: "john@example.com" },
    ] },
    { id: "badpattern", key: "ref", keyPattern: "(", rows: [{ ref: "R1", customer: "Kept" }] },
    { id: "norows", key: "ref", rows: [] },
    { id: "nokey", rows: [{ ref: "R2" }] },
  ],
  forms: [
    { id: "ticket", label: "Zendesk ticket", match: { title: "new ticket", process: ["Zendesk.exe", "C:\\Apps\\chrome.exe"] }, fields: [
      { name: "category", label: "Category", selector: "combobox:Category" },
      { name: "priority", selector: "combobox:Priority" },
      { name: "customer", selector: "edit:Requester" },
      { name: "email", selector: "edit:Email" },
      { name: "notes", selector: "document:Internal note" },
      { name: "sla", selector: "edit:SLA" },
      { name: "priority", selector: "dup" },
      { name: "noselector" },
    ] },
    { id: "anywhere", fields: [{ name: "a", selector: "x" }] },
    { id: "badtitle", match: { title: "(" }, fields: [{ name: "a", selector: "x" }] },
    { id: "nofields", match: { process: "crm" }, fields: [] },
    { id: "crm", match: { process: "crm" }, fields: [{ name: "category", selector: "edit:Category" }] },
  ],
};

const config = forms.normalizeForms(FORMS);

test("normalizeForms keeps usable parts, skips the rest with a warning, never refuses", () => {
  assert.deepEqual(config.records.map((r) => [r.id, r.trigger]), [["refund", "refund/"], ["complaint", "cmp/"], ["refund-dup", undefined]]);
  assert.equal(config.records[0].fields.sla, "48", "numbers are written as text");
  assert.equal(config.records[1].label, "complaint");
  assert.deepEqual(Object.keys(config.records[1].fields), ["category", "priority"]);
  assert.deepEqual(config.lookups.map((l) => [l.id, l.keyPattern, l.rows.length]), [["orders", "A-\\d{5}", 2], ["badpattern", null, 1]]);
  assert.deepEqual(config.lookups[0].rows[0], { orderRef: "A-12345", customer: "Mary Jones", email: "mary@example.com", total: "120.5" }, "a list value has no text form");
  assert.deepEqual(config.forms.map((f) => f.id), ["ticket", "crm"]);
  assert.deepEqual(config.forms[0].match.process, ["zendesk", "chrome"]);
  assert.deepEqual(config.forms[0].fields.map((f) => f.name), ["category", "priority", "customer", "email", "notes", "sla"]);
  assert.equal(config.forms[0].fields[0].label, "Category");
  assert.equal(config.forms[0].fields[1].label, "priority");
  const text = config.warnings.join("\n");
  const expected = [
    /record complaint field bad ignored/, /record refund renamed: duplicate id/, /record refund-dup trigger refund\/ ignored: duplicate trigger/,
    /record empty ignored: no fields/, /record 4 ignored: not an object/,
    /lookup orders row a-12345 ignored: duplicate key/, /lookup orders row 2 ignored: no orderRef/,
    /lookup badpattern keyPattern ignored: invalid pattern/, /lookup norows ignored: no rows/, /lookup nokey ignored: no key column/,
    /form ticket field priority ignored: duplicate name/, /form ticket field noselector ignored: needs a name and a selector/,
    /form anywhere ignored: `match` needs a title or a process/, /form badtitle ignored: invalid title pattern/, /form nofields ignored: no fields/,
  ];
  for (const pattern of expected) assert.match(text, pattern);
  assert.equal(config.warnings.length, expected.length);
  assert.deepEqual(forms.normalizeForms(undefined), { records: [], lookups: [], forms: [], warnings: [] });
  assert.match(forms.normalizeForms("nope").warnings[0], /forms section ignored: not an object/);
  assert.match(forms.normalizeForms({ records: { id: "x" } }).warnings[0], /forms records ignored: not a list/);
});

test("findRecord needs the trigger to end at the caret on a word boundary", () => {
  const found = forms.findRecord("Case: refund/", config);
  assert.equal(found.record.id, "refund");
  assert.equal(found.start, 6);
  assert.equal(forms.findRecord("refund/", config).start, 0);
  assert.equal(forms.findRecord("xrefund/", config), null, "a trigger glued to a word does not fire");
  assert.equal(forms.findRecord("refund/ ", config), null, "the trigger must end at the caret");
  assert.equal(forms.findRecord("cmp/", config).record.id, "complaint");
  assert.equal(forms.findRecord("", config), null);
  assert.equal(forms.findRecord("refund/", {}), null);
});

test("findForm matches process and title together", () => {
  assert.equal(forms.findForm({ process: "C:\\Program Files\\Zendesk\\Zendesk.exe", title: "New Ticket - Zendesk" }, config).id, "ticket");
  assert.equal(forms.findForm({ process: "chrome", title: "Zendesk: new ticket" }, config).id, "ticket");
  assert.equal(forms.findForm({ process: "chrome", title: "Inbox" }, config), null, "the title must match as well");
  assert.equal(forms.findForm({ process: "crm.exe", title: "anything" }, config).id, "crm");
  assert.equal(forms.findForm(null, config), null);
});

test("lookup finds a row by its exact key, then by the key pattern inside longer text", () => {
  const exact = forms.lookup("  a-54321 ", config);
  assert.deepEqual(exact, { lookup: "orders", key: "A-54321", row: { orderRef: "A-54321", customer: "John Smith", email: "john@example.com" }, via: "exact" });
  assert.equal(forms.lookup("r1", config).row.customer, "Kept", "a lookup whose pattern was dropped still matches exactly");
  const extracted = forms.lookup("Re: order A-99999 and order A-12345 arrived broken", config);
  assert.equal(extracted.key, "A-12345");
  assert.equal(extracted.via, "pattern");
  assert.equal(extracted.row.customer, "Mary Jones");
  assert.equal(forms.lookup("order A-123456", config), null, "a longer reference is not a shorter one");
  assert.equal(forms.lookup("orderA-12345", config), null, "the key must stand on its own");
  assert.equal(forms.lookup("order A-11111", config), null, "a well-formed key that is not in the list");
  assert.equal(forms.lookup("   ", config), null);
  extracted.row.customer = "changed";
  assert.equal(forms.lookup("A-12345", config).row.customer, "Mary Jones", "the caller gets a copy");
});

test("plan fills record blanks from the lookup row and answers, lists what is missing and skipped", () => {
  const refund = config.records[0];
  const ticket = config.forms[0];
  const row = forms.lookup("A-12345", config).row;
  const partial = forms.plan(refund, ticket, { values: Object.assign({}, row, { category: "Ignored" }) });
  assert.deepEqual(partial.steps.map((s) => [s.field, s.selector, s.value, s.missing, s.source]), [
    ["category", "combobox:Category", "Refund", [], "record"],
    ["priority", "combobox:Priority", "P2", [], "record"],
    ["customer", "edit:Requester", "Mary Jones", [], "values"],
    ["email", "edit:Email", "mary@example.com", [], "values"],
    ["notes", "document:Internal note", "Hi Mary Jones, refund for A-12345 is on its way. [[reason]]", ["reason"], "record"],
    ["sla", "edit:SLA", "48", [], "record"],
  ]);
  assert.deepEqual(partial.skipped, ["queue"]);
  assert.deepEqual(partial.missing, ["reason"]);
  assert.equal(partial.ready, false);
  assert.equal(partial.record, "refund");
  assert.equal(partial.form, "ticket");

  const done = forms.plan(refund, ticket, { values: Object.assign({}, row, { reason: "Sorry about [[that]].", junk: { a: 1 } }) });
  assert.equal(done.ready, true);
  assert.deepEqual(done.missing, []);
  assert.equal(done.steps[4].value, "Hi Mary Jones, refund for A-12345 is on its way. Sorry about [[that]].", "an answer is inserted once and stays literal");

  const lookupOnly = forms.plan(null, ticket, { values: row });
  assert.deepEqual(lookupOnly.steps.map((s) => s.field), ["customer", "email"]);
  assert.equal(lookupOnly.record, null);
  assert.equal(lookupOnly.ready, true);
  const nothing = forms.plan(refund, null, {});
  assert.deepEqual(nothing.steps, []);
  assert.equal(nothing.skipped.length, 5);
  assert.equal(nothing.ready, false, "an empty plan is not ready to apply");
});

test("learnFieldSets proposes the fields filled together, with varying text as blanks", () => {
  const sessions = [];
  const people = ["John", "Mary", "Ahmed", "Lena"];
  people.forEach((name, i) => sessions.push({ form: "ticket", values: { category: "Refund", priority: "P2", sla: 48, customer: name + " " + i, notes: "Hi " + name + ", your refund is on its way.", tag: i < 3 ? "[[vip]]" : "" } }));
  sessions.push({ form: "ticket", values: { category: "Complaint", priority: "P1", customer: "Zed" } });
  sessions.push({ form: "ticket", values: { category: "Complaint", priority: "P1", customer: "Yul" } });
  sessions.push({ form: "ticket", values: { category: "Complaint", priority: "P1", card: "4111 1111 1111 1111" } });
  sessions.push({ form: "crm", values: { category: "Refund", priority: "P2" } }, null, { values: { a: 1 } });
  for (let i = 0; i < 3; i++) sessions.push({ form: "expenses", values: { card: "4111 1111 1111 1111", type: "Travel", approver: "Kim" } });

  const proposals = forms.learnFieldSets(sessions);
  assert.deepEqual(proposals.map((p) => [p.id, p.form, p.count, p.constant]), [
    ["learned-1", "ticket", 4, ["category", "priority", "sla"]],
    ["learned-2", "ticket", 3, ["category", "priority", "sla", "tag"]],
    ["learned-3", "expenses", 3, ["approver", "type"]],
    ["learned-4", "ticket", 3, ["category", "priority"]],
  ]);
  const refund = proposals[0];
  assert.deepEqual(refund.fields, { category: "Refund", priority: "P2", sla: "48", notes: "Hi [[name]], your refund is on its way." });
  assert.deepEqual(refund.templated, ["notes"], "names that share nothing are not a template");
  assert.equal(refund.label, "Refund / P2");
  assert.equal(proposals[1].fields.tag, "\\[[vip]]", "typed brackets stay literal");
  assert.ok(!Object.hasOwn(proposals[2].fields, "card"), "a card number is never proposed");
  assert.equal(proposals[3].fields.category, "Complaint");

  const again = forms.learnFieldSets(sessions.slice());
  assert.deepEqual(again, proposals, "deterministic");
  assert.deepEqual(forms.learnFieldSets(sessions, { minCount: 5 }), []);
  assert.equal(forms.learnFieldSets(sessions, { limit: 1 }).length, 1);
  assert.deepEqual(forms.learnFieldSets(undefined), []);
  const fromProposal = forms.normalizeForms({ records: [refund] });
  assert.deepEqual(fromProposal.warnings, [], "a proposal is a valid record");
  assert.deepEqual(forms.plan(fromProposal.records[0], config.forms[0], { values: { name: "Mary" } }).ready, true);
});
