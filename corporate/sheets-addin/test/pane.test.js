// The shared pane (pane.js) driven with a fake document and a fake host
// bridge: completions for the selected cell, the chosen spelling written as
// text, blocks and formulas inserted, the pasted configuration kept, a slow
// read that must not overwrite a newer selection, and a formula-like start
// that is not written.
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
  return { bridge, calls, select: (next) => { selection = next; return handler(); }, config: (text) => { saved = text; }, saved: () => saved };
}

const Pane = () => sandboxed(PANE).window.ActleSheetsPane;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the add-in pane completes the selected cell from the configuration, writes the chosen spelling as text, and inserts blocks", async () => {
  const host = fakeHost(plain(CUSTOMER_CELL));
  host.config(JSON.stringify(sheets.exportConfig(SAMPLE_SECTION)));
  const root = new Node("div");
  const pane = Pane().createPane({ document, root, bridge: host.bridge, core: sheets, storage: storageOf() });
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
  const pane = Pane().createPane({ document, root: new Node("div"), bridge: host.bridge, core: sheets, storage: null });
  await pane.start();
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
  assert.match(pane.ui.summary.textContent, /^No configuration yet: export it from the actle desktop app/);
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
