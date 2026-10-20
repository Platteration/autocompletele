const test = require("node:test");
const assert = require("node:assert/strict");
const documents = require("../core/documents.js");

const catalog = documents.normalizeCatalog({ shortcuts: [
  { trigger: "/sld", label: "Shipping logistics department", documents: [
    { title: "Commercial invoice template", path: "S:/Shared/Logistics/commercial-invoice.docx", tags: ["customs", "export"] },
    { path: "S:\\Shared\\Logistics\\packing-list.xlsx" },
    { title: "no path" },
  ] },
  { trigger: "/hr", documents: [{ title: "Handbook", path: "https://intranet.example/handbook.pdf" }] },
  { trigger: "/empty", documents: [] },
  { trigger: "/sld", documents: [{ path: "dup" }] },
  { documents: [{ path: "x" }] },
  "junk",
] });

test("normalizeCatalog fills titles from file names and reports what it skipped", () => {
  assert.deepEqual(catalog.shortcuts.map((s) => s.trigger), ["/sld", "/hr"]);
  assert.equal(catalog.shortcuts[0].documents.length, 2);
  assert.equal(catalog.shortcuts[0].documents[1].title, "packing-list.xlsx");
  assert.equal(catalog.shortcuts[1].label, "/hr");
  assert.equal(catalog.warnings.length, 5);
  assert.deepEqual(documents.normalizeCatalog(null), { shortcuts: [], warnings: [] });
});

test("findShortcut applies the trigger boundary rule", () => {
  assert.equal(documents.findShortcut("please see /sld", catalog).shortcut.label, "Shipping logistics department");
  assert.equal(documents.findShortcut("please see /sld", catalog).start, 11);
  assert.equal(documents.findShortcut("x/sld", catalog), null);
  assert.equal(documents.findShortcut("/sld and", catalog), null);
  assert.equal(documents.findShortcut("", catalog), null);
  assert.equal(documents.findShortcut("/sld", null), null);
});

test("search ranks by title, tag, label and path and honours the limit", () => {
  assert.deepEqual(documents.search("customs", catalog).map((r) => r.document.title), ["Commercial invoice template"]);
  assert.deepEqual(documents.search("shipping", catalog).map((r) => r.document.title), ["Commercial invoice template", "packing-list.xlsx"]);
  assert.deepEqual(documents.search("handbook", catalog).map((r) => r.shortcut.trigger), ["/hr"]);
  assert.equal(documents.search("", catalog).length, 3);
  assert.equal(documents.search("", catalog, 2).length, 2);
  assert.deepEqual(documents.search("zzz", catalog), []);
});
