const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extract = require("../core/extract.js");

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-extract-"));
}

const DOCX = {
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": '<?xml version="1.0"?><w:document><w:body>'
    + "<w:p><w:r><w:t>INVOICE</w:t></w:r><w:r><w:t xml:space=\"preserve\"> INV-20481</w:t></w:r></w:p>"
    + "<w:p><w:r><w:t>Acme Logistics GmbH</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Date: 21.10.2026</w:t></w:r></w:p>"
    + "<w:p><w:r><w:t>Amount due: 1.250,00 &#8364; &amp; VAT</w:t></w:r></w:p>"
    + "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Qty</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
    + "</w:body></w:document>",
};

const XLSX = {
  "xl/sharedStrings.xml": "<sst><si><t>Vendor</t></si><si><r><t>Acme</t></r><r><t xml:space=\"preserve\"> Logistics</t></r></si><si><t>Birch &amp; Co</t></si></sst>",
  "xl/worksheets/sheet2.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Second sheet</t></is></c></row></sheetData></worksheet>',
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42.5</v></c><c r="C2"/></row>'
    + '<row r="3"></row>'
    + "</sheetData></worksheet>",
};

test("zipArchive round-trips through readZip, stored and deflated", () => {
  for (const store of [false, true]) {
    const entries = extract.readZip(extract.zipArchive({ "a.txt": "hello", "dir/b.txt": "wörld" }, { store }));
    assert.deepEqual([...entries.keys()], ["a.txt", "dir/b.txt"]);
    assert.equal(entries.get("a.txt")().toString(), "hello");
    assert.equal(entries.get("dir/b.txt")().toString(), "wörld");
  }
  assert.throws(() => extract.readZip(Buffer.from("not a zip at all, definitely not")), /not a zip/);
});

test("plain text files are read as is, with CRLF normalised and a character cap", () => {
  const dir = temp();
  const file = path.join(dir, "note.TXT");
  fs.writeFileSync(file, "Line one\r\nLine two   \r\n\r\n\r\n\r\nEnd");
  const result = extract.extractText(file);
  assert.equal(result.kind, "text");
  assert.equal(result.ext, "txt");
  assert.equal(result.unsupported, false);
  assert.equal(result.text, "Line one\nLine two\n\nEnd");
  assert.equal(result.error, null);
  const capped = extract.extractText(file, { maxChars: 8 });
  assert.equal(capped.text, "Line one");
  assert.equal(capped.truncated, true);
});

test("a .docx yields its paragraphs, tabs, table cells and decoded entities", () => {
  const dir = temp();
  const file = path.join(dir, "invoice.docx");
  fs.writeFileSync(file, extract.zipArchive(DOCX));
  const result = extract.extractText(file);
  assert.equal(result.kind, "docx");
  assert.equal(result.text, "INVOICE INV-20481\nAcme Logistics GmbH\tDate: 21.10.2026\nAmount due: 1.250,00 € & VAT\nItem\tQty");
});

test("an .xlsx yields shared and inline strings per row, sheets in order", () => {
  const dir = temp();
  const file = path.join(dir, "vendors.xlsx");
  fs.writeFileSync(file, extract.zipArchive(XLSX));
  const result = extract.extractText(file);
  assert.equal(result.kind, "xlsx");
  assert.equal(result.text, "Vendor\tAcme Logistics\nBirch & Co\t42.5\n\nSecond sheet");
});

test("PDF and unknown types are unsupported with empty text; bad files report an error, never throw", () => {
  const dir = temp();
  const pdf = path.join(dir, "scan.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4 binary");
  assert.deepEqual(extract.extractText(pdf), { text: "", kind: "unsupported", ext: "pdf", unsupported: true, truncated: false, bytes: 15, error: null });
  const missing = extract.extractText(path.join(dir, "nope.txt"));
  assert.equal(missing.text, "");
  assert.match(missing.error, /ENOENT/);
  const corrupt = path.join(dir, "broken.docx");
  fs.writeFileSync(corrupt, "PK\u0003\u0004 this is not really a zip archive at all");
  const bad = extract.extractText(corrupt);
  assert.equal(bad.text, "");
  assert.equal(bad.kind, "docx");
  assert.match(bad.error, /could not read docx/);
  const noDocument = path.join(dir, "empty.docx");
  fs.writeFileSync(noDocument, extract.zipArchive({ "other.xml": "<a/>" }));
  assert.match(extract.extractText(noDocument).error, /no word\/document.xml/);
  const big = path.join(dir, "big.txt");
  fs.writeFileSync(big, "x".repeat(100));
  const tooBig = extract.extractText(big, { maxBytes: 50 });
  assert.equal(tooBig.text, "");
  assert.match(tooBig.error, /larger than 50 bytes/);
});

test("entities and tags are decoded safely", () => {
  assert.equal(extract.decodeEntities("a &amp; b &lt;c&gt; &#65;&#x42; &unknown; &#0;"), "a & b <c> AB &unknown; ");
  assert.equal(extract.stripTags("<p>Hi <b>there</b></p>"), "Hi there");
  assert.equal(extract.extensionOf("S:/x/Report.DOCX"), "docx");
  assert.equal(extract.extensionOf("noext"), "");
});
