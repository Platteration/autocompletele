const test = require("node:test");
const assert = require("node:assert/strict");
const filer = require("../core/filer.js");

const FILING = {
  watch: [{ path: "~/Downloads" }, "S:/Scans", { path: "~/Downloads" }, { recursive: true }],
  fields: {
    client: { values: ["Acme Logistics GmbH", "Birch & Co"], aliases: { ACME: "Acme Logistics GmbH" } },
    ref: { pattern: "\\b(INV|PO|CT)-(\\d{4,})\\b" },
    po: { pattern: "PO-(\\d+)", group: 1 },
    bad: { pattern: "(" },
    empty: {},
    date: { values: ["x"] },
    junk: 7,
  },
  rules: [
    { id: "invoice", label: "Supplier invoice", when: { keywords: ["invoice", "amount due"], match: "any", extensions: ["pdf", ".DOCX"] }, name: "[[date]]_[[client]]_invoice_[[ref]]", folder: "S:/Finance/Invoices/[[year]]" },
    { id: "contract", when: { keywords: ["agreement", "hereinafter"], match: "all" }, name: "[[date]]_[[client]]_contract", folder: "S:/Legal/[[client]]" },
    { id: "nocond", name: "x" },
    { id: "noname", when: { keywords: ["a"] } },
    { id: "slash", when: { keywords: ["a"] }, name: "sub/[[date]]" },
    "junk",
  ],
  fallback: { name: "[[date]]_[[original]]" },
  dateOrder: "dmy",
};

const filing = filer.normalizeFiling(FILING);

test("normalizeFiling keeps usable parts and explains what it dropped", () => {
  assert.deepEqual(filing.watch.map((w) => [w.path, w.recursive]), [["~/Downloads", false], ["S:/Scans", false]]);
  assert.deepEqual(Object.keys(filing.fields), ["client", "ref", "po"]);
  assert.equal(filing.fields.po.group, 1);
  assert.deepEqual(filing.rules.map((r) => r.id), ["invoice", "contract"]);
  assert.deepEqual(filing.rules[0].when.extensions, ["pdf", "docx"]);
  assert.equal(filing.rules[1].label, "contract");
  assert.equal(filing.fallback.id, "fallback");
  assert.equal(filing.dateOrder, "dmy");
  const text = filing.warnings.join("\n");
  for (const expected of [/watch folder 3 ignored: no path/, /field bad ignored: invalid pattern/, /field empty ignored/, /field date ignored: it is built in/, /field junk ignored/,
    /rule nocond ignored: `when`/, /rule noname ignored: `name`/, /rule slash ignored: `name`/, /rule 5 ignored: not an object/]) {
    assert.match(text, expected);
  }
  assert.equal(filing.warnings.length, 9);
  assert.deepEqual(filer.normalizeFiling(undefined).rules, []);
  assert.deepEqual(filer.normalizeFiling(undefined).warnings, []);
  assert.match(filer.normalizeFiling("nope").warnings[0], /not an object/);
  assert.match(filer.normalizeFiling({ dateOrder: "ymd" }).warnings[0], /dateOrder/);
  assert.match(filer.normalizeFiling({ fallback: { folder: "x" } }).warnings[0], /fallback ignored/);
});

test("findDate recognises common spellings and takes the earliest in the text", () => {
  assert.equal(filer.findDate("Invoice date 21.10.2026, due 20.11.2026").iso, "2026-10-21");
  assert.equal(filer.findDate("Issued 2026-03-05").iso, "2026-03-05");
  assert.equal(filer.findDate("on 3/4/2026", "dmy").iso, "2026-04-03");
  assert.equal(filer.findDate("on 3/4/2026", "mdy").iso, "2026-03-04");
  assert.equal(filer.findDate("Signed 1st March 2026 in Berlin").iso, "2026-03-01");
  assert.equal(filer.findDate("Signed March 1, 2026").iso, "2026-03-01");
  assert.equal(filer.findDate("Sept. 30 2025").iso, "2025-09-30");
  assert.equal(filer.findDate("ref 31.02.2026 then 01.03.2026").iso, "2026-03-01", "an impossible date is skipped");
  assert.equal(filer.findDate("order 12345-6789 and 2026-13-01"), null);
  assert.equal(filer.findDate(""), null);
});

test("classify picks the first matching rule, honours all/any and extensions, then the fallback", () => {
  assert.equal(filer.classify({ name: "scan.pdf", ext: "pdf", text: "" }, filing).rule.id, "fallback", "a pdf with no keywords is not an invoice");
  const byName = filer.classify({ name: "Invoice_0412.pdf", ext: "pdf", text: "" }, filing);
  assert.equal(byName.rule.id, "invoice");
  assert.deepEqual(byName.matched, ["invoice"]);
  const wrongExt = filer.classify({ name: "invoice.txt", ext: "txt", text: "amount due" }, filing);
  assert.equal(wrongExt.rule.id, "fallback");
  const partial = filer.classify({ name: "a.txt", ext: "txt", text: "This agreement is signed." }, filing);
  assert.equal(partial.rule.id, "fallback", "match: all needs every keyword");
  const contract = filer.classify({ name: "a.txt", ext: "txt", text: "This Agreement between X (hereinafter the Client)" }, filing);
  assert.equal(contract.rule.id, "contract");
  assert.deepEqual(contract.matched, ["agreement", "hereinafter"]);
  assert.equal(filer.classify({ name: "a.txt", ext: "txt", text: "" }, filer.normalizeFiling({})), null);
  assert.equal(filer.classify({ name: "a.txt", ext: "txt", text: "" }, filer.normalizeFiling({ rules: [{ id: "r", when: { keywords: ["zzz"] }, name: "n" }] })), null, "no fallback: nothing proposed");
});

test("detectFields fills built-ins and policy fields, lists the rest as missing", () => {
  const file = { name: "Scan 0412.pdf", ext: "pdf", text: "INVOICE INV-20481\nACME\nDate: 21.10.2026\nPO-77", modified: new Date(2026, 0, 2).getTime() };
  const result = filer.detectFields(file, filing, filing.rules[0]);
  assert.deepEqual(result.values, { date: "2026-10-21", year: "2026", month: "10", day: "21", original: "Scan 0412", ext: "pdf", client: "Acme Logistics GmbH", ref: "INV-20481" });
  assert.deepEqual(result.missing, []);
  assert.equal(result.sources.date, "text");
  const noDate = filer.detectFields({ name: "x.pdf", ext: "pdf", text: "nothing here", modified: new Date(2026, 0, 2).getTime() }, filing, filing.rules[0]);
  assert.equal(noDate.values.date, "2026-01-02");
  assert.equal(noDate.sources.date, "file");
  assert.deepEqual(noDate.missing, ["client", "ref"]);
  const grouped = filer.detectFields({ name: "x", ext: "", text: "PO-123" }, filing, { name: "[[po]]", folder: "" });
  assert.equal(grouped.values.po, "123");
});

test("propose builds a safe name and folder, flags missing blanks, and lets answers win", () => {
  const file = { name: "Scan 0412.pdf", ext: "pdf", text: "INVOICE INV-20481 from Birch & Co, 21.10.2026" };
  const proposal = filer.propose(file, filing);
  assert.equal(proposal.rule.id, "invoice");
  assert.equal(proposal.name, "2026-10-21_Birch_&_Co_invoice_INV-20481.pdf");
  assert.equal(proposal.folder, "S:/Finance/Invoices/2026");
  assert.equal(proposal.ready, true);
  assert.deepEqual(proposal.matched, ["invoice"]);

  const incomplete = filer.propose({ name: "scan.pdf", ext: "pdf", text: "invoice without a client, 01.02.2026" }, filing);
  assert.equal(incomplete.ready, false);
  assert.deepEqual(incomplete.missing, ["client", "ref"]);
  assert.equal(incomplete.name, "2026-02-01_[[client]]_invoice_[[ref]]", "blanks stay visible until answered");

  const answered = filer.propose({ name: "scan.pdf", ext: "pdf", text: "invoice without a client, 01.02.2026" }, filing, { client: 'Zed: "Ltd" <x>', ref: "A/B" });
  assert.equal(answered.ready, true);
  assert.equal(answered.name, "2026-02-01_Zed_Ltd_x_invoice_A_B.pdf");

  const folderBlank = filer.propose({ name: "c.txt", ext: "txt", text: "agreement hereinafter 2026-05-05" }, filing);
  assert.deepEqual(folderBlank.missing, ["client"]);
  assert.equal(folderBlank.folder, "S:/Legal/[[client]]");
  const folderFilled = filer.propose({ name: "c.txt", ext: "txt", text: "agreement hereinafter 2026-05-05" }, filing, { client: "../../etc" });
  assert.equal(folderFilled.folder, "S:/Legal/etc", "a value cannot climb out of the folder");
  assert.equal(folderFilled.name, "2026-05-05_etc_contract.txt");

  const fallback = filer.propose({ name: "Holiday photo.jpg", ext: "jpg", text: "", modified: new Date(2026, 6, 4).getTime() }, filing);
  assert.equal(fallback.rule.id, "fallback");
  assert.equal(fallback.name, "2026-07-04_Holiday_photo.jpg");
  assert.equal(fallback.folder, "");
  assert.equal(filer.propose({ name: "a", ext: "", text: "" }, filer.normalizeFiling({})), null);
});

test("a blank named like an Object member is simply missing, and a value the scrubber would mask never becomes a name", () => {
  const section = filer.normalizeFiling({
    fields: { secret: { pattern: "card\\s*(?:no|number)?:?\\s*([0-9 ]{13,19})", group: 1 }, long: { pattern: "ref ([A-Z0-9]+)", group: 1 } },
    rules: [{ id: "proto", when: { keywords: ["doc"] }, name: "[[constructor]]_[[hasOwnProperty]]_[[secret]]_[[long]]" }],
  });
  const proposal = filer.propose({ name: "doc.txt", ext: "txt", text: "doc card number: 4111 1111 1111 1111 ref " + "A".repeat(200) }, section);
  assert.deepEqual(proposal.missing, ["constructor", "hasOwnProperty", "secret"], "the prototype names and the card number are blanks to answer, not values");
  assert.equal(proposal.values.long.length, 80, "a detected value is capped");
  const answered = filer.propose({ name: "doc.txt", ext: "txt", text: "doc" }, section, { secret: "password: hunter2", constructor: "fine", hasOwnProperty: "ok", long: "L" });
  assert.deepEqual(answered.missing, ["secret"], "an answer the scrubber would mask is refused too");
  assert.equal(answered.values.constructor, "fine");
});

test("safeName removes every banned character, caps the length and keeps the extension", () => {
  assert.equal(filer.safeName('a\\b/c:d*e?f"g<h>i|j\u0001k', "pdf"), "abcdefghijk.pdf");
  assert.equal(filer.safeName("  spaced   out name . ", ".DocX"), "spaced_out_name.docx");
  assert.equal(filer.safeName("", "txt"), "document.txt");
  assert.equal(filer.safeName("CON", "txt"), "_CON.txt");
  assert.equal(filer.safeName("...", ""), "document");
  const long = filer.safeName("x".repeat(300), "pdf");
  assert.equal(long.length, filer.MAX_NAME);
  assert.ok(long.endsWith(".pdf"));
  assert.equal(filer.safeName("Ünïcödé name", "txt"), "Ünïcödé_name.txt");
  assert.equal(filer.cleanValue(" A/B:C "), "A B C");
  assert.equal(filer.cleanValue(".."), "");
});

test("uniqueName never overwrites", () => {
  const taken = new Set(["a.pdf", "a (2).pdf"]);
  assert.equal(filer.uniqueName("a.pdf", (n) => taken.has(n)), "a (3).pdf");
  assert.equal(filer.uniqueName("b.pdf", (n) => taken.has(n)), "b.pdf");
  assert.equal(filer.uniqueName("noext", (n) => n === "noext"), "noext (2)");
  assert.equal(filer.uniqueName("x.pdf"), "x.pdf");
});

test("the index stores names, paths and values, searches by every word, and holds no text", () => {
  let index = filer.normalizeIndex({ entries: [{ path: "S:/Finance/Invoices/2026/2026-10-21_Acme_invoice_INV-20481.pdf", rule: "invoice", ruleLabel: "Supplier invoice", values: { client: "Acme Logistics GmbH", ref: "INV-20481" }, filedAt: 5, originalName: "scan.pdf" }, "junk", { name: "no path" }] });
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].name, "2026-10-21_Acme_invoice_INV-20481.pdf");
  assert.equal(index.entries[0].id, index.entries[0].path);
  index = filer.addEntry(index, { id: "c1", path: "S:/Legal/Birch/2026-05-05_Birch_contract.docx", folder: "S:/Legal/Birch", rule: "contract", ruleLabel: "Contract", values: { client: "Birch & Co" }, filedAt: 9, ext: "DOCX" });
  assert.equal(index.entries.length, 2);
  assert.equal(index.entries[1].ext, "docx");
  index = filer.addEntry(index, { id: "c1", path: "S:/Legal/Birch/2026-05-05_Birch_contract.docx", rule: "contract", filedAt: 10 });
  assert.equal(index.entries.length, 2, "re-adding the same id replaces it");
  assert.deepEqual(filer.search("acme invoice", index).map((r) => r.entry.rule), ["invoice"]);
  assert.deepEqual(filer.search("birch", index).map((r) => r.entry.rule), ["contract"]);
  assert.deepEqual(filer.search("INV-20481", index).map((r) => r.entry.rule), ["invoice"]);
  assert.deepEqual(filer.search("acme contract", index), [], "every word must match");
  assert.equal(filer.search("", index).length, 2);
  assert.equal(filer.search("", index)[0].entry.rule, "contract", "newest first when nothing is asked");
  assert.equal(filer.search("", index, 1).length, 1);
  index = filer.removeEntry(index, "c1");
  assert.equal(index.entries.length, 1);
  assert.deepEqual(filer.normalizeIndex(null), { version: 1, entries: [] });
  assert.equal(JSON.stringify(index).includes("text"), false);
});
