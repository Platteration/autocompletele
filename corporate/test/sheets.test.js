const test = require("node:test");
const assertStrict = require("node:assert/strict");

test("a block with far more rows than the cell cap is a warning, not a RangeError", () => {
  const sheets = require("../core/sheets.js");
  const rows = Array.from({ length: 200000 }, () => ["x"]);
  const out = sheets.normalizeSheets({ blocks: [{ trigger: "/huge", rows }] });
  assertStrict.deepEqual(out.blocks, []);
  assertStrict.ok(out.warnings.some((w) => /\/huge ignored: more than/.test(w)), out.warnings.join("; "));
});
const assert = require("node:assert/strict");
const sheets = require("../core/sheets.js");

const SHEETS = {
  vocabularies: {
    customers: {
      values: ["Acme Logistics GmbH", "Birch & Co", "Northern Acme Ltd", "ACME LOGISTICS GMBH", "", "=HYPERLINK(\"x\")"],
      aliases: { ACME: "Acme Logistics GmbH", Birch: "Birch & Co", Zed: "Zed AG", "Birch & Co": "Acme Logistics GmbH" },
    },
    costCentres: ["CC-100 Logistics", "CC-200 Sales", "-5"],
    empty: { values: [] },
    junk: 7,
  },
  columns: [
    { match: { header: "^(customer|client)", sheet: "^Orders" }, vocabulary: "customers" },
    { match: { header: "^cost cent" }, vocabulary: "costCentres" },
    { match: { header: "notes?$" }, kind: "notes" },
    { match: { header: "(" }, kind: "label" },
    { match: {}, kind: "label" },
    { match: { header: "x" }, vocabulary: "missing" },
    { match: { header: "x" }, vocabulary: "customers", kind: "label" },
    { match: { header: "x" } },
    { match: { header: "x" }, kind: "currency" },
    "junk",
  ],
  blocks: [
    { trigger: "/exp", label: "Expense rows", rows: [["Date", "Amount", "Cost centre"], ["", 0]] },
    { trigger: "/vat", label: "VAT at 19%", formula: "=ROUND(B2*0.19, 2)" },
    { trigger: "exp", rows: [["x"]] },
    { trigger: "/exp", rows: [["dup"]] },
    { trigger: "/both", rows: [["x"]], formula: "=1" },
    { trigger: "/bad", formula: "SUM(A1)" },
    { trigger: "/flat", rows: ["a", "b"] },
    { trigger: "/obj", rows: [[{ a: 1 }]] },
    { trigger: "/none", rows: [[], []] },
    { trigger: "/huge", rows: Array.from({ length: 10001 }, () => ["x"]) },
  ],
};

const config = sheets.normalizeSheets(SHEETS);

test("normalizeSheets keeps usable parts and explains everything it dropped", () => {
  assert.deepEqual(Object.keys(config.vocabularies), ["customers", "costCentres"]);
  assert.deepEqual(config.vocabularies.customers.values, ["Acme Logistics GmbH", "Birch & Co", "Northern Acme Ltd"]);
  assert.deepEqual(config.vocabularies.customers.aliases, { ACME: "Acme Logistics GmbH", Birch: "Birch & Co" });
  assert.deepEqual(config.vocabularies.costCentres.values, ["CC-100 Logistics", "CC-200 Sales", "-5"], "a plain negative number is not a formula");
  assert.deepEqual(config.columns, [
    { match: { header: "^(customer|client)", sheet: "^Orders" }, vocabulary: "customers" },
    { match: { header: "^cost cent" }, vocabulary: "costCentres" },
    { match: { header: "notes?$" }, kind: "notes" },
  ]);
  assert.deepEqual(config.blocks, [
    { trigger: "/exp", label: "Expense rows", rows: [["Date", "Amount", "Cost centre"], ["", 0, ""]] },
    { trigger: "/vat", label: "VAT at 19%", formula: "=ROUND(B2*0.19, 2)" },
  ]);
  const text = config.warnings.join("\n");
  for (const expected of [
    /customers: "ACME LOGISTICS GMBH" is spelled differently from "Acme Logistics GmbH"/, /customers: empty value ignored/, /customers: value "=HYPERLINK.*a cell would read it as a formula/,
    /alias "Zed" ignored: its value "Zed AG" is not in the vocabulary/, /alias "Birch & Co" ignored: it is another value/,
    /vocabulary empty ignored: no usable values/, /vocabulary junk ignored: needs a values list/,
    /column 3 ignored: invalid header pattern/, /column 4 ignored: match needs a header or sheet/, /column 5 ignored: unknown vocabulary missing/,
    /column 6 ignored: give a vocabulary or a kind, not both/, /column 7 ignored: give a vocabulary or a kind, not neither/, /column 8 ignored: kind must be one of/, /column 9 ignored: needs a match object/,
    /block exp ignored: trigger must start with \//, /block \/exp ignored: duplicate trigger/, /block \/both ignored: give rows or a formula, not both/, /block \/bad ignored: a formula starts with =/,
    /block \/flat ignored: rows must be a list of rows/, /block \/obj ignored: cells must be text/, /block \/none ignored: every row is empty/, /block \/huge ignored: more than 10000 cells/,
  ]) {
    assert.match(text, expected);
  }
  assert.equal(config.warnings.length, 22);
  assert.deepEqual(sheets.normalizeSheets(undefined), { vocabularies: {}, columns: [], blocks: [], warnings: [] });
  assert.match(sheets.normalizeSheets("nope").warnings[0], /sheets section ignored: not an object/);
  assert.deepEqual(sheets.normalizeSheets({ vocabularies: [], columns: {}, blocks: "x" }).warnings, ["sheets vocabularies ignored: not an object", "sheets columns ignored: not a list", "sheets blocks ignored: not a list"]);
  assert.match(sheets.normalizeSheets({ vocabularies: { v: { values: ["a"], aliases: ["b"] } } }).warnings[0], /aliases ignored: not an object/);
});

test("columnFor picks the first rule whose header and sheet patterns both hold", () => {
  assert.equal(sheets.columnFor("Customer name", "Orders 2026", config).vocabulary, "customers");
  assert.equal(sheets.columnFor("CLIENT", "orders", config).vocabulary, "customers", "patterns ignore case");
  assert.equal(sheets.columnFor("Customer name", "Budget", config), null, "the sheet pattern must hold too");
  assert.equal(sheets.columnFor("Cost centre", "Anything", config).vocabulary, "costCentres", "no sheet pattern: any sheet");
  assert.equal(sheets.columnFor("Delivery notes", "", config).kind, "notes");
  assert.equal(sheets.columnFor("Amount", "Orders", config), null);
  assert.equal(sheets.columnFor("Customer", "Orders", undefined), null);
});

test("createColumnProfile learns numbers, dates, labels, notes and empty columns", () => {
  assert.equal(sheets.createColumnProfile([12, "1,234.50", "-3", "45 %", "1.234.567", "", null, "n/a"]).kind, "number");
  assert.equal(sheets.createColumnProfile(["2026-10-21", "21.10.2026", "3/4/26", new Date(2026, 0, 2), "2026-10-21 14:30", "tbd"]).kind, "date");
  const labels = sheets.createColumnProfile(["Zed", "Acme", "Birch & Co", "acme", "ACME", "Acme", "Birch & Co", " ", 7]);
  assert.equal(labels.kind, "label");
  assert.equal(labels.total, 8);
  assert.deepEqual(labels.counts, { number: 1, date: 0, label: 7, notes: 0 });
  assert.deepEqual(labels.distinct, [{ value: "Acme", count: 4 }, { value: "Birch & Co", count: 2 }, { value: "Zed", count: 1 }, { value: "7", count: 1 }], "case-folded, most frequent spelling shown, top first");
  const notes = sheets.createColumnProfile([
    "Customer called about the late delivery. Promised a call back tomorrow.",
    "Delivered to the side entrance as agreed. Customer called about the late delivery.",
    "Customer called about the late delivery. Customer called about the late delivery. OK.",
    "Short label",
  ]);
  assert.equal(notes.kind, "notes");
  assert.deepEqual(notes.sentences, [{ value: "Customer called about the late delivery.", count: 3 }], "recurring in distinct cells, short sentences and one-off sentences left out");
  assert.deepEqual(sheets.createColumnProfile([]), { kind: "empty", total: 0, counts: { number: 0, date: 0, label: 0, notes: 0 }, distinct: [], sentences: [] });
  assert.equal(sheets.createColumnProfile(undefined).kind, "empty");
  assert.equal(sheets.createColumnProfile(["1", "2", "a", "b", "c"]).kind, "label", "a mixed column is labels");
});

test("createColumnProfile never offers a formula-like value or an overlong one, and caps the distinct list", () => {
  const profile = sheets.createColumnProfile(["=cmd|' /C calc'!A0", "@SUM(1)", "+x", "x".repeat(501), "Acme"]);
  assert.deepEqual(profile.distinct, [{ value: "Acme", count: 1 }]);
  assert.equal(profile.counts.label + profile.counts.notes, 5, "they still count towards the kind");
  const many = sheets.createColumnProfile(Array.from({ length: 2500 }, (_, i) => "item " + i));
  assert.equal(many.distinct.length, sheets.DEFAULTS.maxDistinct);
});

test("complete: vocabulary first with canonical spelling, then the column by frequency, prefix before substring", () => {
  const profile = sheets.createColumnProfile(["Acme Zebra Freight", "Acme Zebra Freight", "acme logistics gmbh", "ACME", "ACME", "ACME", "Acme Rail", "Northern Acme Ltd"]);
  const results = sheets.complete("acm", { vocabulary: "customers", profile, config });
  assert.deepEqual(results.map((r) => [r.value, r.source, r.match]), [
    ["Acme Logistics GmbH", "vocabulary", "prefix"],
    ["Northern Acme Ltd", "vocabulary", "substring"],
    ["Acme Zebra Freight", "column", "prefix"],
    ["Acme Rail", "column", "prefix"],
  ]);
  assert.equal(results[0].count, 4, "the column's other spelling and alias count towards the canonical value");
  assert.equal(results[0].start, 0);
  assert.ok(!results.some((r) => r.value === "ACME" || r.value === "acme logistics gmbh"), "spellings of a vocabulary value are never offered themselves");
  assert.deepEqual(sheets.complete("ACM", { vocabulary: config.vocabularies.customers }).map((r) => r.value), ["Acme Logistics GmbH", "Northern Acme Ltd"], "a vocabulary object works without config");
  assert.equal(sheets.complete("acm", { vocabulary: "customers", profile, config, limit: 1 }).length, 1);
});

test("complete: aliases complete to the canonical value and never duplicate it", () => {
  const byAlias = sheets.complete("bir", { vocabulary: "customers", config });
  assert.deepEqual(byAlias.map((r) => r.value), ["Birch & Co"]);
  assert.equal(byAlias[0].alias, undefined, "the value itself matched as a prefix first");
  const aliasOnly = sheets.complete("ACME", { vocabulary: "customers", config });
  assert.deepEqual(aliasOnly.map((r) => [r.value, r.match]), [["Acme Logistics GmbH", "prefix"], ["Northern Acme Ltd", "substring"]]);
  const upgraded = sheets.complete("acme", { vocabulary: { values: ["The Acme Group"], aliases: { "Acme Group": "The Acme Group" } } });
  assert.deepEqual(upgraded.map((r) => [r.value, r.match, r.alias]), [["The Acme Group", "prefix", "Acme Group"]], "a prefix hit through an alias beats a substring hit on the value");
});

test("complete: never the exact text typed, case-insensitive, nothing for an empty prefix or unknown vocabulary", () => {
  assert.deepEqual(sheets.complete("Birch & Co", { vocabulary: "customers", config }), []);
  assert.deepEqual(sheets.complete("birch & co", { vocabulary: "customers", config }).map((r) => r.value), ["Birch & Co"], "a different case is corrected to the canonical spelling");
  assert.deepEqual(sheets.complete("", { vocabulary: "customers", config }), []);
  assert.deepEqual(sheets.complete("   ", { vocabulary: "customers", config }), []);
  assert.deepEqual(sheets.complete("acm", { vocabulary: "nope", config }), []);
  assert.deepEqual(sheets.complete("acm", { vocabulary: "constructor", config }), []);
  assert.deepEqual(sheets.complete("acm"), []);
  assert.deepEqual(sheets.complete("c", { vocabulary: "customers", config }), [], "one letter matches prefixes only");
  assert.deepEqual(sheets.complete("co", { vocabulary: "customers", config }).map((r) => r.value), ["Birch & Co"]);
});

test("complete: number and date columns use the vocabulary only; a notes column completes the current sentence", () => {
  const numbers = sheets.createColumnProfile(["100", "1000", "1001"]);
  assert.deepEqual(sheets.complete("10", { profile: numbers }), []);
  assert.deepEqual(sheets.complete("10", { profile: numbers, kind: "label" }).map((r) => r.value), ["100", "1000", "1001"], "a column rule's kind overrides the learned kind");
  assert.deepEqual(sheets.complete("CC", { profile: numbers, vocabulary: "costCentres", config }).map((r) => r.value), ["CC-100 Logistics", "CC-200 Sales"]);
  const notes = sheets.createColumnProfile([
    "Customer called about the late delivery. Promised a call back.",
    "Customer called about the late delivery.",
    "Left at the side entrance as agreed. Promised a call back.",
  ]);
  const first = sheets.complete("cust", { profile: notes });
  assert.deepEqual(first.map((r) => [r.value, r.start]), [["Customer called about the late delivery.", 0]]);
  const second = sheets.complete("Parcel damaged. Prom", { profile: notes });
  assert.deepEqual(second.map((r) => [r.value, r.start]), [["Promised a call back.", 16]]);
  const typed = "Parcel damaged. Prom";
  assert.equal(typed.slice(0, second[0].start) + second[0].value, "Parcel damaged. Promised a call back.");
  assert.deepEqual(sheets.complete("Parcel damaged. ", { profile: notes }), [], "nothing typed in the new sentence yet");
});

test("blockFor finds the block or formula whose trigger ends at the caret, under the shortcut boundary rule", () => {
  const rows = sheets.blockFor("/exp", config);
  assert.equal(rows.block.label, "Expense rows");
  assert.equal(rows.start, 0);
  assert.deepEqual(rows.block.rows[0], ["Date", "Amount", "Cost centre"]);
  const formula = sheets.blockFor("total /vat", config);
  assert.equal(formula.block.formula, "=ROUND(B2*0.19, 2)");
  assert.equal(formula.start, 6);
  assert.equal(sheets.blockFor("a/vat", config), null, "a trigger glued to a word does not fire");
  assert.equal(sheets.blockFor("/va", config), null);
  assert.equal(sheets.blockFor("/vat ", config), null, "the trigger must end at the caret");
  assert.equal(sheets.blockFor("/vat", undefined), null);
  assert.equal(sheets.blockFor(undefined, config), null);
});

test("importCsv reads one or two columns, skips a header, and warns about bad lines", () => {
  const csv = "﻿value,alias\r\nAcme Logistics GmbH,ACME\r\n\"Birch, Co\",Birch\n\nAcme Logistics GmbH,Acme Log\nACME LOGISTICS GMBH\nZed AG,Zed,extra\n,orphan\n=1+1\n\"Quoted \"\"Name\"\" Ltd\"\n\"Two\nlines\"\nNorthern Acme Ltd,Birch\nLast \"open";
  const vocabulary = sheets.importCsv(csv);
  assert.deepEqual(vocabulary.values, ["Acme Logistics GmbH", "Birch, Co", "Quoted \"Name\" Ltd", "Northern Acme Ltd"]);
  assert.deepEqual(vocabulary.aliases, { ACME: "Acme Logistics GmbH", Birch: "Birch, Co", "Acme Log": "Acme Logistics GmbH" });
  assert.deepEqual(vocabulary.warnings, [
    "line 6: \"ACME LOGISTICS GMBH\" is spelled differently from \"Acme Logistics GmbH\"; kept the first spelling",
    "line 7: ignored: more than two columns",
    "line 8: empty value ignored",
    "line 9: value \"=1+1\" ignored: a cell would read it as a formula",
    "line 11: ignored: a value spans several lines",
    "line 13: alias \"Birch\" ignored: it already means \"Birch, Co\"",
    "line 14: ignored with every line after it: unterminated quote",
  ]);
  const semicolons = sheets.importCsv("Kunde A;KA\nKunde B;KB\n");
  assert.deepEqual(semicolons.values, ["Kunde A", "Kunde B"]);
  assert.deepEqual(semicolons.aliases, { KA: "Kunde A", KB: "Kunde B" });
  assert.deepEqual(sheets.importCsv("One\nTwo").values, ["One", "Two"]);
  assert.deepEqual(sheets.importCsv(""), { values: [], aliases: {}, warnings: [] });
  assert.deepEqual(sheets.importCsv(undefined).values, []);
});

test("an imported vocabulary drops into the policy section unchanged", () => {
  const imported = sheets.importCsv("Acme Logistics GmbH,ACME\nBirch & Co");
  const normalized = sheets.normalizeSheets({ vocabularies: { customers: { values: imported.values, aliases: imported.aliases } } });
  assert.deepEqual(normalized.warnings, []);
  assert.deepEqual(normalized.vocabularies.customers, { values: imported.values, aliases: imported.aliases });
});

test("formulaLike stops values a cell would evaluate, but not plain numbers", () => {
  for (const value of ["=1", "+A1", "-A1", "@SUM(A1)", "\tx", "\rx", "+49 30 1234"]) assert.equal(sheets.formulaLike(value), true, value);
  for (const value of ["-5", "+3.5", "Acme", "a=b", "CC-100"]) assert.equal(sheets.formulaLike(value), false, value);
});

test("a block whose text cell a host would read as a formula is dropped with a warning naming the cell; numbers, signed numbers and formula blocks stay", () => {
  // Rows are written as values, which Excel and Google Sheets may evaluate; the `formula` field is the one way to write a formula.
  for (const [cell, first] of [["=HYPERLINK(\"https://example.invalid/\",\"Approved\")", "="], ["+1+1", "+"], ["-cmd|' /C calc'!A0", "-"], ["@SUM(A1:A2)", "@"], ["\tTAB", "\t"], ["\rCR", "\r"]]) {
    const out = sheets.normalizeSheets({ blocks: [{ trigger: "/sig", label: "Signature block", rows: [["Name", "Approved"], ["Kim", cell]] }] });
    assert.deepEqual(out.blocks, [], JSON.stringify(cell));
    assert.deepEqual(out.warnings, ["sheets block /sig ignored: the cell in row 2, column 2 starts with " + JSON.stringify(first) + ", which a cell would read as a formula"]);
  }
  assert.deepEqual(sheets.normalizeSheets({ blocks: [{ trigger: "/two", rows: [["ok", "=1"], ["+2", "x"]] }] }).warnings, ["sheets block /two ignored: the cell in row 1, column 2 starts with \"=\", which a cell would read as a formula"], "the first such cell is named");
  const kept = [
    { trigger: "/ok", label: "Plain", rows: [["-5", "+3.5", -5, true], ["a=b", "CC-100", "", 0]] },
    { trigger: "/f", label: "Total", formula: "=SUM(A1:A2)" },
  ];
  assert.deepEqual(sheets.normalizeSheets({ blocks: kept }), { vocabularies: {}, columns: [], blocks: kept, warnings: [] }, "signed numbers as text, numbers, booleans and a formula block are kept");
  const pasted = sheets.parseConfig(JSON.stringify({ version: 1, sheets: { blocks: [{ trigger: "/sig", rows: [["=1+1"]] }, kept[1]] } }));
  assert.deepEqual(pasted.config.blocks, [kept[1]], "a pasted policy loses the block too");
  assert.deepEqual(pasted.warnings, ["sheets block /sig ignored: the cell in row 1, column 1 starts with \"=\", which a cell would read as a formula"]);
  const policy = require("../core/org-policy.js").parse({ sheets: { blocks: [{ trigger: "/sig", rows: [["@SUM(A1)"]] }] } });
  assert.deepEqual(policy.sheets.blocks, []);
  assert.ok(policy.warnings.includes("sheets block /sig ignored: the cell in row 1, column 1 starts with \"@\", which a cell would read as a formula"), "the policy warns, so it is not signed without --allow-warnings");
  assert.deepEqual(sheets.exportConfig({ blocks: [{ trigger: "/sig", rows: [["=1"]] }] }).blocks, [], "and the export for the add-in never carries it");
});

test("suggest gathers the column rule, a counts-only profile, completions and a block hit for one cell", () => {
  const values = "Acme Zebra Freight\nacme logistics gmbh\nACME\n\n21.10.2026";
  const result = sheets.suggest({ header: "Customer", sheet: "Orders 2026", text: "acm", values }, config);
  assert.equal(result.column.vocabulary, "customers");
  assert.deepEqual(result.profile, { kind: "label", total: 4, counts: { number: 0, date: 1, label: 3, notes: 0 }, distinct: 4, sentences: 0 }, "values come one per line; no value list crosses the IPC");
  assert.deepEqual(result.completions.map((c) => [c.value, c.source]), [["Acme Logistics GmbH", "vocabulary"], ["Northern Acme Ltd", "vocabulary"], ["Acme Zebra Freight", "column"]]);
  assert.equal(result.completions[0].count, 2, "the column's spelling and alias count towards the canonical value");
  assert.equal(result.block, null);
  const notes = sheets.suggest({ header: "Delivery notes", text: "Parcel damaged. Cust", values: ["Customer called about the late delivery.", "Customer called about the late delivery. Fine."] }, config);
  assert.equal(notes.column.kind, "notes");
  assert.deepEqual(notes.completions.map((c) => [c.value, c.start]), [["Customer called about the late delivery.", 16]]);
  const block = sheets.suggest({ header: "Amount", text: "total /vat", values: [] }, config);
  assert.equal(block.column, null);
  assert.deepEqual(block.block, { start: 6, trigger: "/vat", label: "VAT at 19%", formula: "=ROUND(B2*0.19, 2)" });
  assert.deepEqual(block.completions, [], "nothing to complete in an empty column without a rule");
  assert.deepEqual(sheets.suggest(undefined, config), { column: null, profile: { kind: "empty", total: 0, counts: { number: 0, date: 0, label: 0, notes: 0 }, distinct: 0, sentences: 0 }, completions: [], block: null });
  assert.deepEqual(sheets.suggest({ text: "acm" }, undefined).completions, []);
  assert.equal(sheets.suggest({ header: "Customer", sheet: "Orders", text: "acm", values: [], limit: 1 }, config).completions.length, 1);
});

test("exportConfig keeps the three lists only, and a parsed section exports unchanged", () => {
  const exported = sheets.exportConfig(config);
  assert.deepEqual(Object.keys(exported), ["vocabularies", "columns", "blocks"]);
  assert.deepEqual(exported, { vocabularies: config.vocabularies, columns: config.columns, blocks: config.blocks });
  assert.notEqual(exported.blocks, config.blocks, "a copy, so the add-in file cannot alias the policy");
  assert.deepEqual(sheets.normalizeSheets(exported).warnings, [], "nothing is dropped when it is read again");
  assert.deepEqual(sheets.exportConfig(SHEETS), exported, "a raw section is normalised the same way");
  assert.deepEqual(sheets.exportConfig(undefined), { vocabularies: {}, columns: [], blocks: [] });
});

test("parseConfig reads an exported section, a whole policy, or their JSON text; bad JSON is a warning", () => {
  const exported = sheets.exportConfig(config);
  const fromObject = sheets.parseConfig(exported);
  assert.deepEqual(fromObject, { config: exported, warnings: [] });
  assert.deepEqual(sheets.parseConfig(JSON.stringify(exported)).config, exported);
  assert.deepEqual(sheets.parseConfig(JSON.stringify({ version: 1, organization: "Org", sheets: exported })).config, exported, "a whole policy file: its sheets section");
  assert.deepEqual(sheets.parseConfig({ sheets: exported, columns: [] }).config.columns, [], "a section that has its own lists is not unwrapped");
  const bad = sheets.parseConfig("{not json");
  assert.deepEqual(bad.config, { vocabularies: {}, columns: [], blocks: [] });
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /^configuration is not valid JSON: /);
  assert.deepEqual(sheets.parseConfig("   "), { config: { vocabularies: {}, columns: [], blocks: [] }, warnings: [] }, "blank means no configuration, not an error");
  const lossy = sheets.parseConfig(JSON.stringify(SHEETS));
  assert.deepEqual(Object.keys(lossy.config.vocabularies), ["customers", "costCentres"]);
  assert.equal(lossy.warnings.length, 22, "the section's own warnings are passed on");
  assert.equal("warnings" in lossy.config, false);
});

test("organizationItems names the vocabularies and the block and formula triggers under kind sheets, the kind of an imported extle use, leaving out names the add-in never keeps", () => {
  assert.deepEqual(sheets.organizationItems(config), [{ trigger: "customers", kind: "sheets" }, { trigger: "costCentres", kind: "sheets" }, { trigger: "/exp", kind: "sheets" }, { trigger: "/vat", kind: "sheets" }]);
  assert.deepEqual(sheets.organizationItems(undefined), []);
  assert.deepEqual(sheets.organizationItems({}), []);
  const long = sheets.normalizeSheets({ vocabularies: { ["v".repeat(41)]: ["a"], ["v".repeat(40)]: ["a"] }, blocks: [{ trigger: "/" + "t".repeat(40), formula: "=1" }, { trigger: "/t", formula: "=1" }] });
  assert.deepEqual(sheets.organizationItems(long), [{ trigger: "v".repeat(40), kind: "sheets" }, { trigger: "/t", kind: "sheets" }], "a name over 40 characters is never named by a count, so a report would always call it unused");
  const report = require("../core/report.js");
  const orgPolicy = require("../core/org-policy.js");
  assert.deepEqual(report.organizationShortcuts(orgPolicy.parse({ sheets: SHEETS })).filter((item) => item.kind === "sheets").map((item) => item.trigger), ["customers", "costCentres", "/exp", "/vat"], "report.js picks them up from a parsed policy");
});

test("formulaLike also stops the full-width ＝ ＋ － ＠ at the start, with no number exception, and allows them inside a value", () => {
  for (const value of ["＝1", "＝SUM(A1)", "＋49 30 1234", "＋5", "－5", "－A1", "＠SUM(A1)", "＠"]) assert.equal(sheets.formulaLike(value), true, value);
  for (const value of ["a＝b", "CC＋100", "Tel－5", "x＠example", "Ｃ＝1", " ＝1"]) assert.equal(sheets.formulaLike(value), false, value);
  // The half-width rule is unchanged.
  for (const value of ["=1", "+A1", "-A1", "@SUM(A1)", "\tx", "\rx", "+49 30 1234"]) assert.equal(sheets.formulaLike(value), true, value);
  for (const value of ["-5", "+3.5", "Acme", "a=b", "CC-100"]) assert.equal(sheets.formulaLike(value), false, value);
});

test("the full-width guard reaches vocabularies, CSV imports, column values and block rows", () => {
  const out = sheets.normalizeSheets({
    vocabularies: { customers: ["Acme Logistics GmbH", "＝HYPERLINK(\"x\")", "Birch ＋ Co"] },
    blocks: [{ trigger: "/sig", rows: [["Name", "＠SUM(A1:A2)"]] }, { trigger: "/ok", rows: [["Tel－5", "a＝b"]] }],
  });
  assert.deepEqual(out.vocabularies.customers.values, ["Acme Logistics GmbH", "Birch ＋ Co"]);
  assert.deepEqual(out.blocks.map((b) => b.trigger), ["/ok"]);
  assert.deepEqual(out.warnings, [
    "sheets vocabulary customers: value \"＝HYPERLINK(\\\"x\\\")\" ignored: a cell would read it as a formula",
    "sheets block /sig ignored: the cell in row 1, column 2 starts with \"＠\", which a cell would read as a formula",
  ]);
  assert.deepEqual(sheets.importCsv("Acme\n－5\n").values, ["Acme"], "a full-width minus has no number exception");
  const profile = sheets.createColumnProfile(["＋x", "＝1", "Acme"]);
  assert.deepEqual(profile.distinct, [{ value: "Acme", count: 1 }]);
});

const STRICT = {
  vocabularies: { customers: { values: ["Acme Logistics GmbH", "Birch & Co", "Northern Acme Ltd"], aliases: { ACME: "Acme Logistics GmbH", NAL: "Northern Acme Ltd" } } },
  columns: [
    { match: { header: "^customer" }, vocabulary: "customers", strict: true },
    { match: { header: "^client" }, vocabulary: "customers", strict: false },
    { match: { header: "^buyer" }, vocabulary: "customers", strict: "yes" },
    { match: { header: "notes" }, kind: "notes", strict: true },
    { match: { header: "^payer" }, vocabulary: "customers" },
  ],
};

test("strict: kept only as true on a vocabulary column; a non-boolean or a strict kind rule is a warning and the rule stays", () => {
  const out = sheets.normalizeSheets(STRICT);
  assert.deepEqual(out.columns, [
    { match: { header: "^customer" }, vocabulary: "customers", strict: true },
    { match: { header: "^client" }, vocabulary: "customers" },
    { match: { header: "^buyer" }, vocabulary: "customers" },
    { match: { header: "notes" }, kind: "notes" },
    { match: { header: "^payer" }, vocabulary: "customers" },
  ]);
  assert.deepEqual(out.warnings, ["sheets column 2: strict ignored: give true or false", "sheets column 3: strict ignored: only a vocabulary column can be strict"]);
  for (const value of [1, "true", null, [], {}]) {
    const warnings = sheets.normalizeSheets({ vocabularies: STRICT.vocabularies, columns: [{ match: { header: "x" }, vocabulary: "customers", strict: value }] }).warnings;
    assert.deepEqual(warnings, value === null ? [] : ["sheets column 0: strict ignored: give true or false"], JSON.stringify(value));
  }
  const exported = sheets.exportConfig(STRICT);
  assert.equal(exported.columns[0].strict, true, "the export carries it");
  assert.deepEqual(sheets.normalizeSheets(exported).warnings, [], "and reads back clean");
  assert.deepEqual(sheets.parseConfig(JSON.stringify({ version: 1, sheets: exported })).config.columns, out.columns, "the add-in reads it from a pasted policy");
  assert.deepEqual(require("../core/org-policy.js").parse({ sheets: STRICT }).sheets.columns[0], { match: { header: "^customer" }, vocabulary: "customers", strict: true });
});

test("complete in a strict column: only the vocabulary's values, an alias leads to its value, the whole cell is completed", () => {
  const config = sheets.normalizeSheets(STRICT);
  const profile = sheets.createColumnProfile(["Acme Zebra Freight", "Acme Zebra Freight", "ACME", "acme logistics gmbh"]);
  const loose = sheets.complete("acm", { vocabulary: "customers", profile, config });
  assert.deepEqual(loose.map((r) => [r.value, r.source]), [["Acme Logistics GmbH", "vocabulary"], ["Northern Acme Ltd", "vocabulary"], ["Acme Zebra Freight", "column"]], "without strict the column's own value comes after");
  const strict = sheets.complete("acm", { vocabulary: "customers", profile, config, strict: true });
  assert.deepEqual(strict.map((r) => [r.value, r.source]), [["Acme Logistics GmbH", "vocabulary"], ["Northern Acme Ltd", "vocabulary"]]);
  assert.equal(strict[0].count, 2, "the column's alias and other spelling still count towards the value");
  assert.deepEqual(sheets.complete("nal", { vocabulary: "customers", profile, config, strict: true }).map((r) => [r.value, r.alias]), [["Northern Acme Ltd", "NAL"]]);
  assert.deepEqual(sheets.complete("zeb", { vocabulary: "customers", profile, config, strict: true }), [], "nothing outside the list");
  const notes = sheets.createColumnProfile(["Customer called about the late delivery. Promised a call back.", "Parcel left at the side entrance as agreed. Promised a call back."]);
  assert.deepEqual(sheets.complete("Acme. Bir", { vocabulary: "customers", profile: notes, config }).map((r) => [r.value, r.start]), [["Birch & Co", 6]], "a vocabulary column with long values completes the last sentence");
  assert.deepEqual(sheets.complete("bir", { vocabulary: "customers", profile: notes, config, strict: true }).map((r) => [r.value, r.start]), [["Birch & Co", 0]], "a strict one replaces the whole cell");
  assert.deepEqual(sheets.complete("Acme. Bir", { vocabulary: "customers", profile: notes, config, strict: true }), [], "and never completes a sentence inside it");
  const suggested = sheets.suggest({ header: "Customer", text: "acm", values: ["Acme Zebra Freight", "Acme Zebra Freight"] }, config);
  assert.deepEqual(suggested.column, { match: { header: "^customer" }, vocabulary: "customers", strict: true });
  assert.deepEqual(suggested.completions.map((c) => c.value), ["Acme Logistics GmbH", "Northern Acme Ltd"]);
  assert.deepEqual(sheets.suggest({ header: "Payer", text: "acm", values: ["Acme Zebra Freight"] }, config).completions.map((c) => c.value), ["Acme Logistics GmbH", "Northern Acme Ltd", "Acme Zebra Freight"], "the same vocabulary without strict");
});

test("checkColumn sorts a column's cells into canonical, fixable (other spellings and aliases) and unknown; blanks are skipped", () => {
  const config = sheets.normalizeSheets(STRICT);
  const cells = [
    { row: 2, text: "Acme Logistics GmbH" },
    { row: 3, text: "acme logistics gmbh" },
    { row: 4, text: "ACME" },
    { row: 5, text: "" },
    { row: 6, text: "Zed Transport" },
    { row: 7, text: " Birch  & Co " },
    { row: 8, text: "nal" },
    { row: 9, text: "   " },
    { row: 10, text: "100" },
  ];
  assert.deepEqual(sheets.checkColumn(cells, config.vocabularies.customers), {
    checked: 7,
    canonical: 1,
    fixes: [
      { row: 3, text: "acme logistics gmbh", value: "Acme Logistics GmbH", alias: false },
      { row: 4, text: "ACME", value: "Acme Logistics GmbH", alias: true },
      { row: 7, text: " Birch  & Co ", value: "Birch & Co", alias: false },
      { row: 8, text: "nal", value: "Northern Acme Ltd", alias: true },
    ],
    unknown: [{ row: 6, text: "Zed Transport" }, { row: 10, text: "100" }],
  });
  assert.deepEqual(sheets.checkColumn([], config.vocabularies.customers), { checked: 0, canonical: 0, fixes: [], unknown: [] });
  assert.deepEqual(sheets.checkColumn(undefined, undefined), { checked: 0, canonical: 0, fixes: [], unknown: [] });
  assert.deepEqual(sheets.checkColumn([{ row: 2, text: "x" }], { values: ["Y"], aliases: { x: "Gone" } }).unknown, [{ row: 2, text: "x" }], "an alias whose value is not in the list maps to nothing");
});
