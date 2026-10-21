const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const paletteSearch = require("../core/palette-search.js");
const orgPolicy = require("../core/org-policy.js");
const { createAssistant } = require("../desktop/assistant.js");

const policy = orgPolicy.parse({
  library: [{ trigger: "sig/", expansion: "Kind regards,\nExample Ltd" }, { trigger: "ack/", expansion: "Hi [[name]], thanks." }],
  documents: { shortcuts: [{ trigger: "/sld", label: "Shipping logistics department", documents: [{ title: "Packing list", path: "S:/p.xlsx", tags: ["warehouse"] }] }] },
});

test("palette items cover shortcuts and document sets with a short preview", () => {
  const items = paletteSearch.items([{ trigger: "addr/", expansion: "123 Example Street\n  Springfield", source: "personal" }, { trigger: "sig/", expansion: "Kind regards", source: "organization" }], policy.documents);
  assert.deepEqual(items.map((i) => [i.kind, i.trigger, i.source]), [["shortcut", "addr/", "personal"], ["shortcut", "sig/", "organization"], ["documents", "/sld", "organization"]]);
  assert.equal(items[0].preview, "123 Example Street Springfield");
  assert.equal(items[2].preview, "Shipping logistics department: Packing list");
  assert.equal(paletteSearch.items(null, null).length, 0);
  const filed = paletteSearch.items([], null, { entries: [{ name: "2026-10-21_Acme_invoice_INV-20481.pdf", path: "S:/Finance/2026/2026-10-21_Acme_invoice_INV-20481.pdf", folder: "S:/Finance/2026", ruleLabel: "Supplier invoice", originalName: "scan.pdf", values: { client: "Acme Logistics GmbH" } }] });
  assert.deepEqual(filed.map((i) => [i.kind, i.trigger, i.source, i.path]), [["file", "2026-10-21_Acme_invoice_INV-20481.pdf", "organization", "S:/Finance/2026/2026-10-21_Acme_invoice_INV-20481.pdf"]]);
  assert.equal(filed[0].preview, "Supplier invoice: S:/Finance/2026");
  assert.deepEqual(paletteSearch.search(filed, "acme").map((i) => i.kind), ["file"]);
  assert.deepEqual(paletteSearch.search(filed, "scan").map((i) => i.kind), ["file"]);
  assert.deepEqual(paletteSearch.search(filed, "zzz"), []);
});

test("search finds by trigger first, then by words in the text, labels and tags", () => {
  const items = paletteSearch.items([{ trigger: "sig/", expansion: "Kind regards" }, { trigger: "sigma/", expansion: "Greek letter" }, { trigger: "hrs/", expansion: "Our office hours" }], policy.documents);
  assert.deepEqual(paletteSearch.search(items, "sig").map((i) => i.trigger), ["sig/", "sigma/"]);
  assert.deepEqual(paletteSearch.search(items, "office").map((i) => i.trigger), ["hrs/"]);
  assert.deepEqual(paletteSearch.search(items, "warehouse").map((i) => i.trigger), ["/sld"]);
  assert.deepEqual(paletteSearch.search(items, "logistics").map((i) => i.trigger), ["/sld"]);
  assert.equal(paletteSearch.search(items, "").length, 4);
  assert.equal(paletteSearch.search(items, "", 2).length, 2);
  assert.deepEqual(paletteSearch.search(items, "zzz"), []);
});

function desk(extraPolicy) {
  const dataDir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-palette-"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(Object.assign({
    library: [{ trigger: "sig/", expansion: "Kind regards,{cursor}\nExample Ltd" }, { trigger: "ack/", expansion: "Hi [[name]], thanks." }],
    documents: { shortcuts: [{ trigger: "/sld", label: "Shipping", documents: [{ title: "Packing list", path: "S:/p.xlsx" }] }] },
  }, extraPolicy)));
  return createAssistant({ dataDir, now: () => new Date(2026, 9, 20, 12).getTime() });
}

test("choosing from the palette gives the shell an action and counts the query as spent", () => {
  const assistant = desk();
  assistant.saveShorthand({ trigger: "addr/", expansion: "123 Example Street" });
  const found = assistant.paletteSearch("regards");
  assert.deepEqual(found, [{ kind: "shortcut", trigger: "sig/", source: "organization", needsInput: false, preview: "Kind regards, Example Ltd" }]);
  const expand = assistant.paletteChoose({ kind: "shortcut", trigger: "sig/", query: "regards" });
  assert.deepEqual(expand, { type: "expand", trigger: "sig/", text: "Kind regards,\nExample Ltd", cursorOffset: 13, backspaces: 0, source: "organization", via: "palette", spentKeystrokes: 8 });
  assistant.focusChanged({ process: "outlook" });
  const entry = assistant.paletteInserted(expand);
  assert.equal(entry.kind, "palette");
  assert.equal(entry.source, "organization");
  assert.equal(entry.app, "outlook");
  assert.equal(entry.keystrokesSaved, 25 - 8, "inserted graphemes minus the query and Enter");
  const template = assistant.paletteChoose({ kind: "shortcut", trigger: "ack/", query: "ack" });
  assert.equal(template.type, "template");
  assert.equal(template.backspaces, 0);
  assert.deepEqual(template.fields, [{ name: "name", label: "name" }]);
  const docs = assistant.paletteChoose({ kind: "documents", trigger: "/sld", query: "ship" });
  assert.equal(docs.type, "documents");
  assert.equal(docs.documents[0].title, "Packing list");
  assert.equal(assistant.paletteChoose({ kind: "shortcut", trigger: "missing/" }), null);
  assert.equal(assistant.paletteChoose({ kind: "documents", trigger: "/none" }), null);
  assert.equal(assistant.paletteChoose(null), null);
  assert.equal(assistant.paletteInserted(docs), null);
});

test("a paused desk offers nothing in the palette", () => {
  const assistant = desk({ paused: { message: "hold" } });
  assert.deepEqual(assistant.paletteSearch(""), []);
  assert.equal(assistant.paletteChoose({ kind: "shortcut", trigger: "sig/" }), null);
});

test("an insert that typed nothing in the field removes nothing from the learned text", () => {
  const assistant = desk({ capture: { defaultMode: "learn" } });
  assistant.focusChanged({ process: "notepad" });
  for (const ch of "Dear team, please note") assistant.keyTyped({ text: ch });
  // A template chosen from a keyword offer or the palette: the trigger was never typed.
  assistant.recordInsert({ kind: "template", trigger: "ack/", inserted: "Hi Sam, thanks.", typed: "", spentKeystrokes: 4 });
  assert.equal(assistant.engine.session.text, "Dear team, please note\n\n", "nothing typed is cut off");
  const last = assistant.ledger.entries().pop();
  assert.equal(last.keystrokesSaved, 15 - 4);
});

test("a template proposal is saved from its segments with the person's names", () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-accept-"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ capture: { defaultMode: "learn" } }));
  const keychain = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from("K" + t), decryptString: (b) => Buffer.from(b).toString().slice(1) };
  const assistant = createAssistant({ dataDir, keychain });
  for (const [name, ref, day] of [["John", "A-1001", "Monday"], ["Mary", "A-1002", "Tuesday"], ["Priya", "A-1003", "Friday"]]) {
    assistant.focusChanged({ process: "outlook" });
    for (const ch of `Thanks ${name}, your order ${ref} ships on ${day} as agreed.`) assistant.keyTyped({ text: ch });
  }
  assistant.focusChanged({ process: "other" });
  const proposal = assistant.candidates().find((c) => c.kind === "template");
  assert.ok(proposal, "a template is proposed");
  assert.equal(proposal.template, "Thanks [[name]], your order [[reference]] ships on [[date]] as agreed.");
  const saved = assistant.acceptCandidate({ trigger: "conf/", template: proposal.template, names: { name: "customer" }, expansion: "ignored" });
  assert.equal(saved.ok, true);
  assert.equal(assistant.library().find((s) => s.trigger === "conf/").expansion, "Thanks [[customer]], your order [[reference]] ships on [[date]] as agreed.");
  assert.match(assistant.acceptCandidate({ trigger: "x/", template: "no such proposal" }).error, /has changed/);
  assert.match(assistant.acceptCandidate({ trigger: "y/", template: proposal.template, names: { name: "[bad]" } }).error, /brackets/);
});
