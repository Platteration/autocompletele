const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const filer = require("../core/filer.js");

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-filer-"));
}

/** Run `body` with fs[name] replaced, restoring it however `body` ends. */
function patched(name, replacement, body) {
  const real = fs[name];
  fs[name] = replacement(real);
  try {
    return body();
  } finally {
    fs[name] = real;
  }
}

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

test("a name is capped in UTF-8 bytes as well as code units, and is never cut inside a surrogate pair", () => {
  const cjk = filer.safeName("株".repeat(140), "txt");
  assert.ok(Buffer.byteLength(cjk) <= filer.MAX_NAME_BYTES, "a CJK name fits 255-byte file systems with room for ' (n)': " + Buffer.byteLength(cjk));
  assert.ok(cjk.endsWith(".txt"));
  assert.equal(cjk, "株".repeat(65) + ".txt", "as many whole characters as fit");
  const emoji = filer.safeName("x" + "😀".repeat(80), "txt");
  assert.equal(emoji.isWellFormed(), true, "no lone surrogate at the cut");
  assert.ok(Buffer.byteLength(emoji) <= filer.MAX_NAME_BYTES && emoji.length <= filer.MAX_NAME);
  assert.equal(emoji, "x" + "😀".repeat(48) + ".txt");
  assert.equal(filer.safeName("a\ud800b", "txt"), "a�b.txt", "a lone surrogate in the input becomes the replacement character Node would write");
  const long = filer.safeName("x".repeat(300), "pdf");
  assert.equal(Buffer.byteLength(long), filer.MAX_NAME, "ASCII names keep the 150-character cap");
  // The worst a collision can add is uniqueName's time-stamped suffix, still inside 255 bytes.
  assert.ok(Buffer.byteLength(filer.uniqueName(cjk, () => true)) <= 255);
});

test("detected and answered values are cut between code points, and every folder component fits the file system", () => {
  const section = filer.normalizeFiling({ fields: { ref: { pattern: "ref (\\S+)", group: 1 } }, rules: [{ id: "r", when: { keywords: ["doc"] }, name: "[[ref]]", folder: "filed/[[a]]_[[b]]_[[c]]/[[ref]]" }] });
  const proposal = filer.propose({ name: "doc.txt", ext: "txt", text: "doc ref " + "a".repeat(79) + "😀" }, section, { a: "株".repeat(80), b: "株".repeat(80), c: "株".repeat(80) });
  assert.equal(proposal.values.ref, "a".repeat(79), "the emoji that would straddle the 80-unit cap is left out whole");
  assert.equal(proposal.values.ref.isWellFormed(), true);
  const answered = filer.propose({ name: "doc.txt", ext: "txt", text: "doc ref x" }, section, { a: "a".repeat(79) + "😀", b: "b", c: "c" });
  assert.equal(answered.values.a, "a".repeat(79));
  const parts = proposal.folder.split("/");
  assert.equal(parts[0], "filed");
  assert.equal(parts[2], "a".repeat(79), "a short component is untouched");
  assert.ok(Buffer.byteLength(parts[1]) <= filer.MAX_FOLDER_PART, "a long component is capped: " + Buffer.byteLength(parts[1]));
  assert.ok(parts[1].startsWith("株".repeat(80) + "_株") && parts[1].isWellFormed());
  assert.equal(filer.propose({ name: "doc.txt", ext: "txt", text: "doc ref x" }, section, { a: "A", b: "B", c: "C" }).folder, "filed/A_B_C/x");
});

test("a Windows device name before the first dot is prefixed, as Windows reads CON.2026.txt as CON", () => {
  assert.equal(filer.safeName("con.2026-10-21", "txt"), "_con.2026-10-21.txt");
  assert.equal(filer.safeName("aux.b", "pdf"), "_aux.b.pdf");
  assert.equal(filer.safeName("COM1.report", "docx"), "_COM1.report.docx");
  assert.equal(filer.safeName("nul", ""), "_nul");
  assert.equal(filer.safeName("x.con", "txt"), "x.con.txt", "only the part before the first dot counts");
  assert.equal(filer.safeName("con _x", "pdf"), "con_x.pdf", "con_x is not a device");
  assert.equal(filer.safeName("console.log", "txt"), "console.log.txt");
  const section = filer.normalizeFiling({ fields: { client: { pattern: "Client: (\\S+)", group: 1 } }, rules: [{ id: "r", when: { keywords: ["doc"] }, name: "[[client]].[[date]]" }] });
  assert.equal(filer.propose({ name: "doc.txt", ext: "txt", text: "doc Client: CON 2026-10-21" }, section).name, "_CON.2026-10-21.txt");
});

test("resolveFolder: relative to the document, ~ only where the policy wrote it, empty renames in place", () => {
  const home = path.join(path.sep, "home", "pat");
  const doc = path.join(path.sep, "docs", "inbox", "scan.txt");
  const dir = path.dirname(doc);
  assert.equal(filer.resolveFolder(doc, { folder: "", folderTemplate: "" }, home), dir);
  assert.equal(filer.resolveFolder(doc, { folder: "Sorted/2026", folderTemplate: "Sorted/[[year]]" }, home), path.join(dir, "Sorted", "2026"));
  assert.equal(filer.resolveFolder(doc, { folder: "~/Clients/Acme", folderTemplate: "~/Clients/[[client]]" }, home), path.join(home, "Clients", "Acme"));
  assert.equal(filer.resolveFolder(doc, { folder: "~", folderTemplate: "~" }, home), home);
  assert.equal(filer.resolveFolder(doc, { folder: "~/filed", folderTemplate: "[[original]]/filed" }, home), path.join(dir, "~", "filed"), "a document named ~ cannot send itself to the home folder");
  assert.equal(filer.resolveFolder(doc, { folder: "~x/y", folderTemplate: "~x/y" }, home), path.join(dir, "~x", "y"));
  const absolute = path.join(path.sep, "srv", "Invoices");
  assert.equal(filer.resolveFolder(doc, { folder: absolute, folderTemplate: absolute }, home), absolute);
  assert.equal(filer.resolveFolder("relative.txt", { folder: "", folderTemplate: "" }, home), process.cwd());
  assert.equal(filer.resolveFolder(doc, { folder: "~/a", folderTemplate: "~/a" }), path.join(os.homedir(), "a"), "the home folder defaults to the account's");
});

test("moveDocument never replaces a file that appears at the name between the check and the move", () => {
  const dir = temp();
  const from = path.join(dir, "scan.txt");
  fs.writeFileSync(from, "INVOICE from Acme");
  const folder = path.join(dir, "filed");
  fs.mkdirSync(folder);
  const target = path.join(folder, "Invoice.txt");
  let raced = 0;
  // Another desk files "Invoice.txt" right after this one found the name free.
  const moved = patched("existsSync", (real) => (p) => {
    if (p === target && !raced++) {
      fs.writeFileSync(target, "THE OTHER DESK'S DOCUMENT");
      return false;
    }
    return real(p);
  }, () => filer.moveDocument(from, folder, "Invoice.txt"));
  assert.equal(raced, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "THE OTHER DESK'S DOCUMENT", "the other document survives");
  assert.equal(moved.name, "Invoice (2).txt");
  assert.equal(moved.path, path.join(folder, "Invoice (2).txt"));
  assert.equal(fs.readFileSync(moved.path, "utf8"), "INVOICE from Acme");
  assert.ok(!fs.existsSync(from));
  const stat = fs.statSync(moved.path);
  assert.deepEqual([moved.size, moved.mtimeMs], [stat.size, stat.mtimeMs], "the result says what was moved, for Undo to recognise it");
  // A link or name left at the target by someone else, even a dangling symbolic link, is also never replaced.
  const other = path.join(dir, "memo.txt");
  fs.writeFileSync(other, "memo");
  fs.symlinkSync(path.join(dir, "nowhere"), path.join(folder, "memo.txt"));
  assert.equal(filer.moveDocument(other, folder, "memo.txt").name, "memo (2).txt");
  assert.ok(fs.lstatSync(path.join(folder, "memo.txt")).isSymbolicLink());
});

test("moveDocument copies exclusively where a hard link is impossible, and keeps the original unless the copy matches", () => {
  const dir = temp();
  const folder = path.join(dir, "share");
  fs.mkdirSync(folder);
  const noLink = (code) => () => () => {
    throw Object.assign(new Error(code + ": no hard links here"), { code });
  };
  // Another drive (EXDEV) or a file system without hard links (EPERM): an exclusive copy, then the original goes.
  for (const code of ["EXDEV", "EPERM", "ENOTSUP"]) {
    const from = path.join(dir, code + ".txt");
    fs.writeFileSync(from, "document " + code);
    fs.utimesSync(from, new Date(2026, 0, 2), new Date(2026, 0, 2));
    const target = path.join(folder, "Doc " + code + ".txt");
    let raced = 0;
    const moved = patched("linkSync", noLink(code), () => patched("existsSync", (real) => (p) => {
      if (p === target && !raced++) {
        fs.writeFileSync(target, "already here");
        return false;
      }
      return real(p);
    }, () => filer.moveDocument(from, folder, "Doc " + code + ".txt")));
    assert.equal(fs.readFileSync(target, "utf8"), "already here", code + ": the copy never replaces what is there");
    assert.equal(moved.name, "Doc " + code + " (2).txt");
    assert.equal(fs.readFileSync(moved.path, "utf8"), "document " + code);
    assert.ok(!fs.existsSync(from));
    assert.ok(Math.abs(fs.statSync(moved.path).mtimeMs - new Date(2026, 0, 2).getTime()) < 1000, code + ": the copy keeps the document's time");
  }
  // A copy that does not match (a short write, a device) never costs the original.
  const from = path.join(dir, "keep.txt");
  fs.writeFileSync(from, "the only copy");
  assert.throws(() => patched("linkSync", noLink("EXDEV"), () => patched("copyFileSync", () => (a, b) => fs.writeFileSync(b, "the"), () => filer.moveDocument(from, folder, "keep.txt"))), /does not match the original/);
  assert.equal(fs.readFileSync(from, "utf8"), "the only copy");
  assert.ok(!fs.existsSync(path.join(folder, "keep.txt")), "the short copy is removed");
});

test("moveDocument leaves the document in one place when the old name cannot be removed, refuses non-files, and gives up after its tries", () => {
  const dir = temp();
  const folder = path.join(dir, "filed");
  fs.mkdirSync(folder);
  const from = path.join(dir, "locked.txt");
  fs.writeFileSync(from, "in use");
  assert.throws(() => patched("unlinkSync", (real) => (p) => {
    if (p === from) throw Object.assign(new Error("EBUSY: in use"), { code: "EBUSY" });
    return real(p);
  }, () => filer.moveDocument(from, folder, "locked.txt")), /EBUSY/);
  assert.equal(fs.readFileSync(from, "utf8"), "in use");
  assert.deepEqual(fs.readdirSync(folder), [], "the new name was taken back");
  const sub = path.join(dir, "Invoice scans.txt");
  fs.mkdirSync(sub);
  assert.throws(() => filer.moveDocument(sub, folder, "x.txt"), /not a regular file/);
  fs.symlinkSync(from, path.join(dir, "link.txt"));
  assert.throws(() => filer.moveDocument(path.join(dir, "link.txt"), folder, "x.txt"), /symbolic links are not filed/);
  let tries = 0;
  assert.throws(() => patched("linkSync", () => () => {
    tries++;
    throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  }, () => filer.moveDocument(from, folder, "busy.txt")), /no free name for busy\.txt/);
  assert.equal(tries, 100);
  assert.ok(fs.existsSync(from));
});

test("the index keeps each filed document's size and time, and nothing else is invented for older entries", () => {
  const index = filer.normalizeIndex({ entries: [{ path: "/a/b.txt", size: 12, mtimeMs: 1761040000123.5 }, { path: "/a/c.txt" }, { path: "/a/d.txt", size: "12", mtimeMs: -1 }] });
  assert.deepEqual(index.entries.map((e) => [e.size, e.mtimeMs]), [[12, 1761040000123.5], [null, null], [null, null]]);
  const added = filer.addEntry(filer.normalizeIndex(null), { path: "/x.txt", size: 0, mtimeMs: 5 });
  assert.deepEqual([added.entries[0].size, added.entries[0].mtimeMs], [0, 5]);
});

test("an extension longer than any real one stays in the name, so every name keeps both caps", () => {
  for (const stem of ["2026-10-21_a", "株".repeat(100), "y".repeat(300), ""]) {
    for (const length of [17, 40, 200, 253]) {
      const name = filer.safeName(stem, "b".repeat(length));
      assert.ok(name.length <= filer.MAX_NAME && Buffer.byteLength(name) <= filer.MAX_NAME_BYTES, stem.slice(0, 5) + " + " + length + ": " + name.length + " units, " + Buffer.byteLength(name) + " bytes");
      assert.ok(name.isWellFormed());
      assert.ok(Buffer.byteLength(filer.uniqueName(name, () => true)) <= 255, "room for ' (n)'");
    }
  }
  assert.equal(filer.safeName("2026-10-21_a", "b".repeat(253)), ("2026-10-21_a." + "b".repeat(253)).slice(0, filer.MAX_NAME), "the long tail is kept as far as it fits");
  assert.equal(filer.safeName("y".repeat(300), "b".repeat(filer.MAX_EXT)), "y".repeat(filer.MAX_NAME - filer.MAX_EXT - 1) + "." + "b".repeat(filer.MAX_EXT), "an extension up to MAX_EXT is kept whole");
});

test("a lone surrogate in a value becomes U+FFFD in folders and values too, as on disk", () => {
  assert.equal(filer.cleanValue("Acme\ud800x"), "Acme�x");
  const section = filer.normalizeFiling({ fields: { client: { pattern: "Client: (\\S+)", group: 1 } }, rules: [{ id: "r", when: { keywords: ["doc"] }, name: "[[date]]_[[client]]", folder: "Clients\udc00/[[client]]/[[team]]" }] });
  const proposal = filer.propose({ name: "doc.txt", ext: "txt", text: "doc Client: Acme\ud800x 2026-10-21" }, section, { team: "Ops\udbff" });
  assert.equal(proposal.values.client, "Acme�x");
  assert.equal(proposal.values.team, "Ops�");
  assert.equal(proposal.folder, "Clients�/Acme�x/Ops�", "detected and answered values and the policy's own text");
  assert.equal(proposal.name, "2026-10-21_Acme�x.txt");
});

test("every device name Windows reserves is prefixed: CONIN$, CONOUT$, COM0, LPT0 and the superscript digits", () => {
  for (const name of ["CONIN$", "conout$.x", "COM0.x", "lpt0", "COM¹.x", "com²", "LPT²", "lpt³.report"]) {
    assert.equal(filer.safeName(name, "txt"), "_" + name + ".txt", name);
  }
  for (const name of ["COM10", "LPT10", "conin", "conout", "COM⁴", "CONIN$x", "x.CONIN$"]) {
    assert.equal(filer.safeName(name, "txt"), name + ".txt", name + " is not a device");
  }
});
