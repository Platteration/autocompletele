// extle beyond the core: the dashboard channels through the desktop
// assistant, the exported configuration's round trip, the add-in bundler
// (reproducible, network-free, browser-evaluable, same answers as the core),
// the dashboard tab driven with a fake document, and the simulator. The pane
// and the host bridges have their own tests in sheets-addin/test/.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const sheets = require("../core/sheets.js");
const orgPolicy = require("../core/org-policy.js");
const { loadApps } = require("../desktop/apps/index.js");
const { createAssistant } = require("../desktop/assistant.js");
const { SAMPLE_SECTION } = require("../desktop/apps/sheets/sample.js");
const build = require("../sheets-addin/build.js");
const report = require("../core/report.js");
const admin = require("../admin/actle-admin.js");
const { Node, el, sandboxed, plain } = require("../sheets-addin/test/fakes.js");

const ADDIN = path.join(__dirname, "..", "sheets-addin");
const RENDERER = path.join(__dirname, "..", "desktop", "renderer", "apps", "sheets.js");
const NOTES = ["Customer called about the late delivery. Promised a call back.", "Customer called about the late delivery.", "Parcel left at the side entrance. Promised a call back."];

function temp(prefix) {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), prefix || "actle-sheets-"));
}

function desk(policy) {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(policy === undefined ? { organization: "Org", sheets: SAMPLE_SECTION } : policy));
  return { assistant: createAssistant({ dataDir, now: () => new Date(2026, 9, 21, 12).getTime() }), dataDir };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the registry loads the real app with a bare host: a tab and four channels, no popover, hook or tray item", () => {
  const [app] = loadApps({ policy: () => orgPolicy.parse({}) }, { ids: ["sheets"] });
  assert.equal(app.title, "extle");
  assert.equal(app.tab, true);
  assert.deepEqual(Object.keys(app.ipc), ["sheets:info", "sheets:complete", "sheets:exportConfig", "sheets:importUsage"]);
  assert.equal(app.extension, undefined);
  assert.deepEqual(app.popovers, {});
  assert.equal(app.trayItems, undefined);
  assert.equal(typeof app.simulate, "function");
});

test("sheets:info describes the policy section, the section's own warnings and the add-in folder", () => {
  const { assistant, dataDir } = desk();
  const info = assistant.invoke("sheets:info");
  assert.equal(info.ok, true);
  assert.equal(info.organization, "Org");
  assert.deepEqual(info.vocabularies, [
    { name: "customers", values: 4, aliases: 3, examples: ["Acme Logistics GmbH", "Birch & Co", "Northern Acme Ltd"] },
    { name: "costCentres", values: 3, aliases: 1, examples: ["CC-100 Logistics", "CC-200 Sales", "CC-300 Warehouse"] },
  ]);
  assert.deepEqual(info.columns, [
    { header: "^(customer|client)", sheet: "^Orders", vocabulary: "customers", kind: "", strict: false },
    { header: "^cost cent", sheet: "", vocabulary: "costCentres", kind: "", strict: true },
    { header: "notes?$", sheet: "", vocabulary: "", kind: "notes", strict: false },
  ]);
  assert.deepEqual(info.blocks, [
    { trigger: "/exp", label: "Expense rows", kind: "rows", formula: "", rows: 2, columns: 3 },
    { trigger: "/vat", label: "VAT at 19%", kind: "formula", formula: "=ROUND(B2*0.19, 2)", rows: 0, columns: 0 },
  ]);
  assert.deepEqual(info.warnings, []);
  assert.equal(info.lastExport, null);
  assert.equal(info.addin.folder, ADDIN);
  assert.equal(info.addin.present, true);
  const lossy = desk({ sheets: { vocabularies: { v: 7 }, columns: [{ match: { header: "x" }, kind: "label", strict: true }], blocks: [{ trigger: "nope" }] }, keywordRules: [{ id: "k" }] });
  assert.deepEqual(lossy.assistant.invoke("sheets:info").warnings, [
    "sheets vocabulary v ignored: needs a values list",
    "sheets column 0: strict ignored: only a vocabulary column can be strict",
    "sheets block nope ignored: trigger must start with / and contain no spaces",
  ], "only the sheets warnings, not the keyword rule's");
  assert.deepEqual(lossy.assistant.invoke("sheets:info").columns, [{ header: "x", sheet: "", vocabulary: "", kind: "label", strict: false }], "the rule stays, without strict");
  const none = desk({});
  assert.deepEqual(none.assistant.invoke("sheets:info").vocabularies, []);
  for (const dir of [dataDir, lossy.dataDir, none.dataDir]) fs.rmSync(dir, { recursive: true, force: true });
});

test("sheets:complete answers like the core for pasted values and never throws on an odd payload", () => {
  const { assistant, dataDir } = desk();
  const payload = { header: "Customer", sheet: "Orders 2026", text: "acm", values: "ACME\nZed Transport\n\nacme logistics gmbh" };
  const result = assistant.invoke("sheets:complete", payload);
  const expected = sheets.suggest(payload, assistant.policy().sheets);
  assert.deepEqual(result, Object.assign({ ok: true }, expected));
  assert.deepEqual(result.completions.map((c) => [c.value, c.count]), [["Acme Logistics GmbH", 2], ["Northern Acme Ltd", 0]]);
  const block = assistant.invoke("sheets:complete", { header: "Amount", text: "total /exp", values: ["1", "2"] });
  assert.deepEqual(block.block, { trigger: "/exp", label: "Expense rows", kind: "rows", formula: "", rows: 2, columns: 3, start: 6 }, "the block is described, its rows stay on the desk");
  assert.deepEqual(assistant.invoke("sheets:complete", undefined), { ok: true, column: null, profile: { kind: "empty", total: 0, counts: { number: 0, date: 0, label: 0, notes: 0 }, distinct: 0, sentences: 0 }, completions: [], block: null });
  assert.equal(assistant.invoke("sheets:complete", { header: "Customer", sheet: "Orders", text: "acm", limit: 1 }).completions.length, 1);
  const strict = assistant.invoke("sheets:complete", { header: "Cost centre", text: "cc", values: "CC-999 Old\nCC-999 Old\nsales" });
  assert.equal(strict.column.strict, true);
  assert.deepEqual(strict.completions.map((c) => [c.value, c.source]), [["CC-200 Sales", "vocabulary"], ["CC-100 Logistics", "vocabulary"], ["CC-300 Warehouse", "vocabulary"]], "a strict column offers the list's values only, never CC-999 Old");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("sheets:exportConfig writes apps/sheets-config.json, which the policy parser reads back without a warning; the audit holds counts only", () => {
  const { assistant, dataDir } = desk();
  const result = assistant.invoke("sheets:exportConfig");
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(dataDir, "apps", "sheets-config.json"));
  assert.deepEqual(result.counts, { vocabularies: 2, columns: 3, blocks: 2 });
  assert.equal(result.note, "");
  assert.deepEqual(result.broadcast, { apps: true });
  const text = fs.readFileSync(result.path, "utf8");
  const written = JSON.parse(text);
  assert.deepEqual(written, sheets.exportConfig(assistant.policy().sheets));
  assert.deepEqual(Object.keys(written), ["vocabularies", "columns", "blocks"]);
  assert.ok(text.startsWith("{\n  \"vocabularies\""), "pretty JSON, so it can be read before pasting");
  const back = orgPolicy.parse({ sheets: written });
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.sheets, assistant.policy().sheets);
  assert.deepEqual(orgPolicy.parse(JSON.stringify({ version: 1, sheets: JSON.parse(text) })).sheets, assistant.policy().sheets, "as JSON text too");
  assert.deepEqual(sheets.parseConfig(text), { config: written, warnings: [] }, "and the add-in reads the file as pasted");
  const audit = assistant.audit().pop();
  assert.deepEqual(audit, { at: new Date(2026, 9, 21, 12).getTime(), event: "sheets-config-exported", vocabularies: 2, columns: 3, blocks: 2 });
  assert.equal(fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8").includes("Acme"), false, "no vocabulary value in the audit");
  const info = assistant.invoke("sheets:info");
  assert.deepEqual(info.lastExport, { at: audit.at, vocabularies: 2, columns: 3, blocks: 2, path: result.path, present: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "apps", "sheets.json"), "utf8")), { lastExport: { at: audit.at, vocabularies: 2, columns: 3, blocks: 2 } });
  fs.rmSync(result.path);
  assert.equal(assistant.invoke("sheets:info").lastExport.present, false, "a deleted file is reported, not assumed");
  const empty = desk({});
  const nothing = empty.assistant.invoke("sheets:exportConfig");
  assert.equal(nothing.ok, true, "an empty section still exports");
  assert.equal(nothing.note, "The policy has no sheets section; the file holds empty lists.");
  assert.deepEqual(JSON.parse(fs.readFileSync(nothing.path, "utf8")), { vocabularies: {}, columns: [], blocks: [] });
  for (const dir of [dataDir, empty.dataDir]) fs.rmSync(dir, { recursive: true, force: true });
});

test("sheets:exportConfig reports a data folder that cannot be written instead of throwing, and writes nothing to the audit", () => {
  const audits = [];
  const saved = [];
  const host = (failing) => ({
    policy: () => orgPolicy.parse({ sheets: SAMPLE_SECTION }),
    dataDir: path.join(os.tmpdir(), "nowhere"),
    now: () => 1,
    audit: (entry) => audits.push(entry),
    appData: (id) => ({ load: () => ({}), save: (value) => { if (failing.includes(id)) throw new Error("disk full"); saved.push([id, value]); } }),
  });
  const [app] = loadApps(host(["sheets-config"]), { ids: ["sheets"] });
  const result = app.ipc["sheets:exportConfig"]();
  assert.deepEqual(result, { ok: false, error: "Could not write " + path.join(os.tmpdir(), "nowhere", "apps", "sheets-config.json") + ": disk full" });
  assert.deepEqual(audits, [], "a failed export is not logged as one");
  assert.deepEqual(saved, []);
  const [later] = loadApps(host(["sheets"]), { ids: ["sheets"] });
  const partial = later.ipc["sheets:exportConfig"]();
  assert.equal(partial.ok, false);
  assert.match(partial.error, /^Wrote .*sheets-config\.json, but could not record the export: disk full$/);
  assert.equal(partial.path, path.join(os.tmpdir(), "nowhere", "apps", "sheets-config.json"), "the file is there for pasting all the same");
  assert.equal(partial.broadcast, undefined);
  assert.deepEqual(saved.map(([id]) => id), ["sheets-config"]);
  assert.deepEqual(audits, []);
});

test("build.js writes the bundle and the Apps Script includes, byte for byte the same each time, from the sources only", () => {
  const a = temp();
  const b = temp();
  const first = build.build({ out: a });
  const second = build.build({ out: b });
  assert.deepEqual(first.files, ["dist/sheets-core.js", "apps-script/sheets-core.html", "apps-script/pane.html"]);
  assert.deepEqual(first.modules, ["corporate/core/sheets.js", "corporate/core/personal.js", "chrome-extension/src/expander.js", "chrome-extension/src/template.js", "chrome-extension/src/palette.js", "corporate/core/phrase-miner.js", "corporate/core/policy-pattern.js", "corporate/core/sheets-usage.js", "corporate/core/metrics.js"]);
  assert.equal(first.out, a);
  for (const file of first.files) {
    const one = fs.readFileSync(path.join(a, file), "utf8");
    assert.equal(one, fs.readFileSync(path.join(b, file), "utf8"), file + " is reproducible");
    assert.equal(one.includes(build.ROOT), false, file + " holds no absolute path");
  }
  const script = fs.readFileSync(path.join(a, "dist/sheets-core.js"), "utf8");
  assert.equal(Buffer.byteLength(script), first.bytes);
  assert.equal(fs.readFileSync(path.join(a, "apps-script/sheets-core.html"), "utf8"), "<script>\n" + script + "</script>\n");
  const pane = fs.readFileSync(path.join(a, "apps-script/pane.html"), "utf8");
  assert.ok(pane.startsWith("<style>\n") && pane.includes("</style>\n<script>\n") && pane.endsWith("</script>\n"));
  assert.ok(pane.includes(fs.readFileSync(path.join(ADDIN, "pane.js"), "utf8").trimEnd()));
  assert.equal(script.startsWith("// extle core bundle, generated by corporate/sheets-addin/build.js from corporate/core/sheets.js, "), true);
  assert.match(script, /^  if \(typeof Object\.hasOwn !== "function"\) Object\.hasOwn = function/m, "the ES2022 polyfill comes with the bundle");
  const requires = [...fs.readFileSync(path.join(ADDIN, "build.js"), "utf8").matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)].sort(), ["node:fs", "node:path"], "nothing that could reach the network");
  assert.throws(() => build.collect(path.join(__dirname, "..", "desktop", "apps", "sheets", "app.js")), /desktop\/apps\/sheets\/app.js requires node:fs, which a browser cannot load/);
  assert.throws(() => build.collect(path.join(os.tmpdir(), "elsewhere.js")), /module outside the repository/);
  assert.throws(() => build.inline("script", "var end = '</script>';"), /contains <\/script>/);
  assert.equal(build.inline("style", "a {}\n\n"), "<style>\na {}\n</style>\n");
  for (const dir of [a, b]) fs.rmSync(dir, { recursive: true, force: true });
});

test("the bundle runs in a browser-like sandbox without Node and answers exactly like the core", () => {
  const out = temp();
  build.build({ out });
  const sandbox = sandboxed(path.join(out, "dist", "sheets-core.js"));
  const bundled = sandbox.window.ActleSheets;
  assert.deepEqual(Object.keys(bundled).sort(), Object.keys(sheets).sort());
  assert.equal(typeof sandbox.require, "undefined");
  assert.equal(typeof sandbox.process, "undefined");
  const raw = () => JSON.parse(JSON.stringify(SAMPLE_SECTION));
  const config = sheets.normalizeSheets(raw());
  assert.deepEqual(plain(bundled.normalizeSheets(raw())), plain(config));
  const values = ["ACME", "acme logistics gmbh", "Zed Transport", "Zed Transport", "21.10.2026"];
  assert.deepEqual(plain(bundled.complete("acm", { vocabulary: "customers", profile: bundled.createColumnProfile(values), config: bundled.normalizeSheets(raw()) })), plain(sheets.complete("acm", { vocabulary: "customers", profile: sheets.createColumnProfile(values), config })));
  const input = { header: "Delivery notes", text: "Driver was late. Prom", values: NOTES };
  assert.deepEqual(plain(bundled.suggest(input, bundled.normalizeSheets(raw()))), plain(sheets.suggest(input, config)));
  assert.deepEqual(plain(bundled.blockFor("total /vat", bundled.normalizeSheets(raw()))), plain(sheets.blockFor("total /vat", config)));
  const csv = "value,alias\nAcme Logistics GmbH,ACME\n=1+1\n";
  assert.deepEqual(plain(bundled.importCsv(csv)), plain(sheets.importCsv(csv)));
  assert.deepEqual(plain(bundled.parseConfig("{bad")), plain(sheets.parseConfig("{bad")));
  assert.equal(bundled.formulaLike("=1"), true);
  assert.equal(bundled.formulaLike("＝1"), true, "the full-width guard is in the bundle");
  const strictInput = { header: "Cost centre", text: "cc", values: ["CC-999 Old", "sales"] };
  assert.deepEqual(plain(bundled.suggest(strictInput, bundled.normalizeSheets(raw()))), plain(sheets.suggest(strictInput, config)), "a strict column completes the same");
  const cells = [{ row: 2, text: "sales" }, { row: 3, text: "CC-999 Old" }, { row: 4, text: "CC-100 Logistics" }];
  assert.deepEqual(plain(bundled.checkColumn(cells, bundled.normalizeSheets(raw()).vocabularies.costCentres)), plain(sheets.checkColumn(cells, config.vocabularies.costCentres)));
  assert.equal(bundled.columnFor("Cost centre", "Budget", bundled.normalizeSheets(raw())).vocabulary, "costCentres");
  // The usage model counts the same in the bundle; without the Web Crypto API (this sandbox) the instance id still comes out.
  assert.equal(typeof sandbox.crypto, "undefined");
  const counted = bundled.usage.createUsage();
  assert.match(counted.instance, /^[0-9a-f]{32}$/);
  const event = { kind: "completion", source: "vocabulary", name: "customers", inserted: "Acme Logistics GmbH", typed: "acm" };
  assert.deepEqual(plain(bundled.usage.record(counted, event, "2026-10-23")), plain(sheets.usage.record(sheets.usage.createUsage(), event, "2026-10-23")));
  const handed = bundled.usage.serializeUsage(counted);
  assert.deepEqual(plain(sheets.usage.parseUsage(handed).usage.days), { "2026-10-23": [["completion", "vocabulary", "customers", 1, 16]] }, "the desk reads what the bundle writes");
  assert.deepEqual(plain(bundled.usage.parseUsage("{bad")), plain(sheets.usage.parseUsage("{bad")));
  const modern = vm.createContext({});
  modern.self = modern;
  const own = vm.runInContext("Object.hasOwn", modern);
  vm.runInContext(fs.readFileSync(path.join(out, "dist", "sheets-core.js"), "utf8"), modern);
  assert.equal(vm.runInContext("Object.hasOwn", modern), own, "a host that has Object.hasOwn keeps its own");
  // An older Office webview without Object.hasOwn (ES2022): the bundle brings its own.
  const old = vm.createContext({});
  vm.runInContext("delete Object.hasOwn;", old);
  assert.equal(vm.runInContext("typeof Object.hasOwn", old), "undefined");
  old.self = old;
  vm.runInContext(fs.readFileSync(path.join(out, "dist", "sheets-core.js"), "utf8"), old);
  assert.equal(vm.runInContext("typeof Object.hasOwn", old), "function");
  const legacy = old.ActleSheets;
  assert.deepEqual(plain(legacy.normalizeSheets(raw())), plain(config), "column rules resolve their vocabulary");
  assert.deepEqual(plain(legacy.suggest({ header: "Customer", sheet: "Orders", text: "acm", values: ["ACME"] }, legacy.normalizeSheets(raw())).completions.map((c) => c.value)), ["Acme Logistics GmbH", "Northern Acme Ltd"]);
  assert.equal(vm.runInContext("Object.hasOwn({ a: 1 }, 'a') && !Object.hasOwn({ a: 1 }, 'toString')", old), true);
  fs.rmSync(out, { recursive: true, force: true });
});

function helpersFor(assistant, calls, announced) {
  const api = {
    invoke: async (channel, payload) => { calls.push([channel, payload]); return assistant.invoke(channel, payload); },
    revealFiled: async (p) => { calls.push(["reveal", p]); return { ok: true }; },
  };
  return { api, el, text: (node, value) => { node.textContent = value == null ? "" : String(value); }, announce: (m) => announced.push(m), seconds: (n) => n + " s", preview: (s) => String(s || "").slice(0, 140) };
}

test("the dashboard tab lists the policy, tries a completion through sheets:complete, keeps what was typed, and exports", async () => {
  const { assistant, dataDir } = desk();
  const calls = [];
  const announced = [];
  const helpers = helpersFor(assistant, calls, announced);
  const tab = sandboxed(RENDERER).window.actleApps.sheets;
  const section = new Node("section");
  await tab.render(section, helpers, {});
  assert.deepEqual(calls, [["sheets:info", undefined]]);
  const shown = section.textContent;
  for (const expected of [/of Org\./, /customers/, /Acme Logistics GmbH, Birch & Co, Northern Acme Ltd/, /\^cost cent/, /notes column/, /Expense rows/, /formula =ROUND\(B2\*0\.19, 2\)/, /Not exported yet\./, /sheets-addin; its README/]) assert.match(shown, expected);
  const rules = section.all((n) => n.tagName === "td" && /^vocabulary /.test(n.textContent)).map((n) => n.textContent);
  assert.deepEqual(rules, ["vocabulary customers", "vocabulary costCentres (strict: only its values)"], "the column rules table marks the strict rule");
  assert.equal(section.find((n) => n.tagName === "h2" && n.textContent === "Policy warnings"), null);
  const inputs = section.all((n) => n.tagName === "input");
  assert.deepEqual(inputs.map((n) => n.attrs["aria-label"]), ["Column header", "Sheet name", "Typed text"]);
  inputs[0].value = "Customer";
  inputs[1].value = "Orders 2026";
  section.find((n) => n.tagName === "textarea").value = "ACME\nZed Transport";
  inputs[2].value = "acm";
  await inputs[2].fire("keydown", { key: "Enter" });
  await settle(); // Enter clicks Complete without awaiting it
  assert.deepEqual(plain(calls.pop()), ["sheets:complete", { header: "Customer", sheet: "Orders 2026", text: "acm", values: "ACME\nZed Transport" }]);
  assert.match(section.textContent, /Column rule: vocabulary customers\. Learned from the values: label column, 2 values, 2 distinct\./);
  assert.match(section.textContent, /Acme Logistics GmbH.*vocabulary.*prefix.*1/s);
  inputs[0].value = "Cost centre";
  inputs[1].value = "";
  inputs[2].value = "cc";
  await section.button("Complete").click();
  assert.match(section.textContent, /Column rule: vocabulary costCentres, strict, so only its values are offered\./);
  inputs[0].value = "Customer";
  inputs[1].value = "Orders 2026";
  inputs[2].value = "acm";
  await section.button("Complete").click();
  await tab.render(section, helpers, { metrics: true });
  assert.equal(section.all((n) => n.tagName === "input")[0].value, "Customer", "a rebuild keeps the inputs");
  assert.match(section.textContent, /Acme Logistics GmbH.*vocabulary/s, "and the result");
  const typed = section.all((n) => n.tagName === "input")[2];
  typed.value = "/vat";
  await section.button("Complete").click();
  assert.match(section.textContent, /Block \/vat \(VAT at 19%\): formula =ROUND\(B2\*0\.19, 2\) would be inserted at the cell\./);
  assert.match(section.textContent, /No text completion; the block above is offered\./);
  await section.button("Export add-in configuration").click();
  assert.match(announced.pop(), /^Configuration exported to .*sheets-config\.json$/);
  assert.equal(section.button("Show file"), null, "the toolbar is rebuilt on the apps change the export broadcasts");
  await tab.render(section, helpers, { apps: true });
  assert.match(section.textContent, /Last exported .* to .*sheets-config\.json \(2 vocabularies, 3 column rules, 2 blocks\)/);
  await section.button("Show file").click();
  assert.deepEqual(calls.pop(), ["reveal", path.join(dataDir, "apps", "sheets-config.json")]);
  const lossy = desk({ sheets: { blocks: [{ trigger: "nope" }] } });
  const other = new Node("section");
  await tab.render(other, helpersFor(lossy.assistant, [], []), {});
  assert.match(other.textContent, /Policy warnings.*sheets block nope ignored/s);
  assert.match(other.textContent, /The policy has no vocabularies\..*No column rules: every column completes from its own values\..*No blocks in the policy\./s);
  const broken = new Node("section");
  await tab.render(broken, Object.assign({}, helpers, { api: { invoke: async () => ({ ok: false, error: "no policy" }) } }), {});
  assert.equal(broken.textContent, "extle could not read the policy: no policy");
  for (const dir of [dataDir, lossy.dataDir]) fs.rmSync(dir, { recursive: true, force: true });
});

test("the dashboard tab announces an export that failed and a channel call that threw, instead of doing nothing visible", async () => {
  const { assistant, dataDir } = desk();
  const announced = [];
  const helpers = helpersFor(assistant, [], announced);
  const tab = sandboxed(RENDERER).window.actleApps.sheets;
  const section = new Node("section");
  const failing = Object.assign({}, helpers, { api: Object.assign({}, helpers.api, { invoke: async (channel, payload) => (channel === "sheets:info" ? assistant.invoke(channel, payload) : { ok: false, error: "Could not write /nowhere/apps/sheets-config.json: disk full" }) }) });
  await tab.render(section, failing, {});
  await section.button("Export add-in configuration").click();
  assert.deepEqual(announced, ["Could not write /nowhere/apps/sheets-config.json: disk full"]);
  section.all((n) => n.tagName === "input")[2].value = "acm";
  await section.button("Complete").click();
  assert.match(section.textContent, /Could not write \/nowhere/, "a refused completion is shown in the results, not swallowed");
  const throwing = Object.assign({}, helpers, { api: Object.assign({}, helpers.api, { invoke: async (channel, payload) => { if (channel === "sheets:info") return assistant.invoke(channel, payload); throw new Error("ipc gone"); } }) });
  const other = new Node("section");
  await tab.render(other, throwing, {});
  await other.button("Export add-in configuration").click();
  assert.deepEqual(announced.pop(), "Export failed: ipc gone");
  await other.button("Complete").click();
  assert.match(other.textContent, /Could not complete: ipc gone/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("simulate walks through the sample section, exports the live policy and builds the bundle, and prints a readable log", () => {
  const { assistant, dataDir } = desk();
  const lines = [];
  const sim = { print: (line) => lines.push(line), assistant, focus() {}, type() {}, tick() {}, now: () => 0, brief: (t) => JSON.stringify(t).slice(0, 70), docsDir: "", describe: () => "" };
  assistant.app("sheets").simulate(sim);
  const log = lines.join("\n");
  for (const expected of [
    /vocabulary customers: 4 values, 3 aliases, e\.g\. Acme Logistics GmbH, Birch & Co/,
    /column rule header \/\^\(customer\|client\)\/ sheet \/\^Orders\/ -> vocabulary customers\n/,
    /column rule header \/\^cost cent\/ -> vocabulary costCentres \(strict\)/,
    /strict column "Cost centre" holds .*; typed "cc" -> CC-100 Logistics; CC-200 Sales; CC-300 Warehouse \(CC-999 Old is not offered\)/,
    /"Check this column": 1 match, list's spelling for C3 sales -> CC-200 Sales, C4 cc-300 warehouse -> CC-300 Warehouse; not in the list: C5 CC-999 Old, C6 CC-999 Old/,
    /block \/exp \(Expense rows\): 2 rows x 3 columns/,
    /typed "acm" -> Acme Logistics GmbH \[vocabulary\]; Northern Acme Ltd \[vocabulary\]\n/,
    /typed "ACME" -> Acme Logistics GmbH \[vocabulary\]; Northern Acme Ltd \[vocabulary\]/,
    /notes column, typed "Driver was late\. Prom" -> Promised a call back\. \(replaces from character 17\)/,
    /typed "\/vat" -> insert VAT at 19%: =ROUND\(B2\*0\.19, 2\)/,
    /policy section: 2 vocabularies, 3 column rules, 2 blocks, 0 warnings/,
    /exported add-in configuration to apps\/sheets-config\.json; audit: sheets-config-exported/,
    /add-in bundle: dist\/sheets-core\.js, apps-script\/sheets-core\.html, apps-script\/pane\.html \(\d+ bytes from 9 modules\); in a browser sandbox "acm" -> Acme Logistics GmbH/,
    /usage hand-over \(\d+ characters, counts only\): 3 uses added, then pasted again: 0 added, 3 already imported; the usage report names \/vat, customers; audit: sheets-usage-imported/,
  ]) assert.match(log, expected);
  assert.ok(fs.existsSync(path.join(dataDir, "apps", "sheets-config.json")));
  const bare = desk({});
  const quiet = [];
  bare.assistant.app("sheets").simulate(Object.assign({}, sim, { assistant: bare.assistant, print: (line) => quiet.push(line) }));
  assert.match(quiet.join("\n"), /policy section: 0 vocabularies, 0 column rules, 0 blocks, 0 warnings\n.*\(The policy has no sheets section; the file holds empty lists\.\)/, "the walk-through does not depend on the policy");
  assert.match(quiet.join("\n"), /3 uses added, .*the usage report names none of them \(the policy defines neither customers nor \/vat\)/);
  for (const dir of [dataDir, bare.dataDir]) fs.rmSync(dir, { recursive: true, force: true });
});

// The add-in's usage text, imported on the desk (sheets:importUsage).
const usage = sheets.usage;
const NOON = (day) => { const date = usage.dateOf(day); date.setHours(12); return date.getTime(); };
const INSTANCE = "ab".repeat(16);

/** A usage text as the add-in writes it: days -> [[kind, source, name, count, keystrokes]]. */
function usageText(days, instance) {
  return JSON.stringify({ format: "extle-usage", version: 1, instance: instance || INSTANCE, days });
}

const sheetEntries = (assistant) => assistant.ledger.entries().filter((entry) => entry.kind === "sheets");

test("sheets:importUsage adds each use once as an extle entry at local noon of its day, named only for the policy's vocabularies and triggers; the same text again adds nothing, a later text the difference, a lower count nothing", () => {
  const { assistant, dataDir } = desk();
  assert.equal(assistant.invoke("sheets:info").lastImport, null);
  const first = usageText({ "2026-10-20": [
    ["completion", "vocabulary", "customers", 2, 32],
    ["block", "formula", "/vat", 1, 14],
    ["completion", "column", "", 1, 10],
    ["block", "document", "", 1, 5],
    ["completion", "vocabulary", "regions", 1, 3],
  ] });
  const result = assistant.invoke("sheets:importUsage", { text: first });
  assert.deepEqual(result, { ok: true, added: 6, alreadyImported: 0, days: 1, refused: [], broadcast: { metrics: true, apps: true } });
  assert.deepEqual(sheetEntries(assistant).map((e) => [e.at, e.app, e.trigger, e.source, e.keystrokesSaved]), [
    [NOON("2026-10-20"), "extle", "customers", "organization", 16],
    [NOON("2026-10-20"), "extle", "customers", "organization", 16],
    [NOON("2026-10-20"), "extle", "/vat", "organization", 14],
    [NOON("2026-10-20"), "extle", "", "", 10],
    [NOON("2026-10-20"), "extle", "", "", 5],
    [NOON("2026-10-20"), "extle", "", "", 3],
  ], "regions is not in the policy, so it is counted without a name, like the column and the document's configuration");
  const audit = assistant.audit().pop();
  assert.deepEqual(audit, { at: new Date(2026, 9, 21, 12).getTime(), event: "sheets-usage-imported", added: 6, alreadyImported: 0, days: 1, refused: 0 });
  const auditFile = fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8");
  for (const name of ["customers", "/vat", "regions", INSTANCE]) assert.equal(auditFile.includes(name), false, name + " is not in the audit");
  assert.deepEqual(assistant.invoke("sheets:info").lastImport, { at: audit.at, added: 6, alreadyImported: 0, days: 1, refused: 0 });
  // The statistics see it: the day, the application and the keystrokes.
  const day = assistant.series({ period: "day", count: 2, now: new Date(2026, 9, 21, 12).getTime() })[0];
  assert.deepEqual([day.key, day.expansions, day.keystrokesSaved, day.byKind.sheets], ["2026-10-20", 6, 64, 6]);
  assert.deepEqual(assistant.byApp({}).map((row) => [row.app, row.expansions, row.keystrokesSaved]), [["extle", 6, 64]], "the statistics label it extle");
  // The same text again.
  assert.deepEqual(assistant.invoke("sheets:importUsage", { text: first }), { ok: true, added: 0, alreadyImported: 6, days: 0, refused: [], broadcast: { metrics: true, apps: true } });
  assert.equal(sheetEntries(assistant).length, 6);
  // A later text from the same add-in: three more customers (48 keystrokes) and a new day.
  const later = usageText({ "2026-10-20": [["completion", "vocabulary", "customers", 5, 42], ["block", "formula", "/vat", 1, 14]], "2026-10-21": [["block", "rows", "/exp", 1, 23]] });
  assert.deepEqual(assistant.invoke("sheets:importUsage", { text: later }), { ok: true, added: 4, alreadyImported: 3, days: 2, refused: [], broadcast: { metrics: true, apps: true } });
  assert.deepEqual(sheetEntries(assistant).slice(6).map((e) => [e.at, e.trigger, e.keystrokesSaved]), [
    [NOON("2026-10-20"), "customers", 4], [NOON("2026-10-20"), "customers", 3], [NOON("2026-10-20"), "customers", 3],
    [NOON("2026-10-21"), "/exp", 23],
  ], "10 more keystrokes over 3 uses: 4, 3, 3");
  // A lower count (the add-in's storage was reset, but the id kept) adds nothing.
  const lower = usageText({ "2026-10-20": [["completion", "vocabulary", "customers", 1, 16]] });
  assert.deepEqual(assistant.invoke("sheets:importUsage", { text: lower }), { ok: true, added: 0, alreadyImported: 1, days: 0, refused: [], broadcast: { metrics: true, apps: true } });
  // Another add-in (another browser or Google account) is counted on its own.
  assert.equal(assistant.invoke("sheets:importUsage", { text: usageText({ "2026-10-20": [["completion", "vocabulary", "customers", 2, 32]] }, "cd".repeat(16)) }).added, 2);
  assert.equal(sheetEntries(assistant).length, 12);
  const total = sheetEntries(assistant).reduce((sum, e) => sum + e.keystrokesSaved, 0);
  assert.equal(total, 64 + 10 + 23 + 32, "the keystrokes add up to the texts' counters");
  // The entries are kept as kind sheets: a new assistant on the same folder reads them back.
  const reopened = createAssistant({ dataDir, now: () => new Date(2026, 9, 21, 12).getTime() });
  assert.equal(sheetEntries(reopened).length, 12, "metrics.jsonl holds kind sheets, which the ledger reads as such");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("sheets:importUsage refuses days after today, days before the statistics' history and uses past one import's cap, says so, and refuses a malformed text with nothing recorded", () => {
  const { assistant, dataDir } = desk({ organization: "Org", sheets: SAMPLE_SECTION, retention: { metricsDays: 30 } });
  const text = usageText({
    "2026-09-01": [["completion", "column", "", 2, 4]],
    "2026-09-23": [["completion", "column", "", 1, 4]],
    "2026-10-21": [["completion", "vocabulary", "customers", 1, 16]],
    "2026-10-22": [["completion", "column", "", 1, 2]],
    "2026-10-30": [["completion", "column", "", 3, 2]],
  });
  assert.deepEqual(assistant.invoke("sheets:importUsage", { text }), { ok: true, added: 2, alreadyImported: 0, days: 2, refused: [
    "4 uses on 2 days after today were not imported.",
    "2 uses on 1 day before the 30 days the statistics keep were not imported.",
  ], broadcast: { metrics: true, apps: true } }, "2026-09-23 is within the 30 days, 2026-09-01 is not");
  assert.equal(assistant.audit().pop().refused, 6);
  // Past the cap: the first 20,000 uses, oldest day first; the same text again adds the rest.
  const { IMPORT_MAX } = require("../desktop/apps/sheets/app.js");
  assert.equal(IMPORT_MAX, 20000);
  const many = usageText({ "2026-10-19": [["completion", "column", "", 20003, 40006]], "2026-10-20": [["block", "formula", "/vat", 2, 28]] }, "ef".repeat(16));
  const capped = assistant.invoke("sheets:importUsage", { text: many });
  assert.deepEqual(capped, { ok: true, added: 20000, alreadyImported: 0, days: 1, refused: ["5 uses past the 20000 one import adds were not imported; import the same text again to add them."], broadcast: { metrics: true, apps: true } });
  const rest = assistant.invoke("sheets:importUsage", { text: many });
  assert.deepEqual([rest.added, rest.alreadyImported, rest.refused], [5, 20000, []]);
  const fromMany = sheetEntries(assistant).slice(2);
  assert.equal(fromMany.length, 20005);
  assert.equal(fromMany.reduce((sum, e) => sum + e.keystrokesSaved, 0), 40006 + 28, "the keystrokes still add up after a split import");
  // Malformed: nothing recorded, no audit, no last import changed.
  const before = assistant.audit().length;
  const lastImport = assistant.invoke("sheets:info").lastImport;
  for (const [payload, error] of [
    [{ text: "{bad" }, /^Not imported: it is not valid JSON \(/],
    [{ text: "" }, /^Not imported: there is no text; copy it from the Usage section of the extle add-in\.$/],
    [undefined, /^Not imported: there is no text/],
    [{ text: usageText({ "2026-10-20": [["completion", "vocabulary", "customers", 0, 0]] }) }, /^Not imported: day 2026-10-20: a count is not a whole number from 1 to 100000\.$/],
    [{ text: usageText({}, "not-an-id") }, /instance id/],
  ]) {
    const refused = assistant.invoke("sheets:importUsage", payload);
    assert.equal(refused.ok, false);
    assert.match(refused.error, error);
    assert.equal(refused.broadcast, undefined);
  }
  assert.equal(assistant.audit().length, before);
  assert.deepEqual(assistant.invoke("sheets:info").lastImport, lastImport);
  assert.equal(sheetEntries(assistant).length, 20007);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("an import the desk cannot record adds nothing, a ledger that stops partway leaves the rest for the next import, and an audit that fails is said", () => {
  const records = [];
  const files = {};
  const audits = [];
  const host = (options) => ({
    policy: () => orgPolicy.parse({ sheets: SAMPLE_SECTION }),
    now: () => new Date(2026, 9, 21, 12).getTime(),
    audit: (entry) => { if (options.audit) throw new Error(options.audit); audits.push(entry); },
    appData: (id) => ({ load: (fallback) => (files[id] ? JSON.parse(files[id]) : fallback), save: (value) => { if (options.save) throw new Error(options.save); files[id] = JSON.stringify(value); } }),
    ledger: { record: (entry) => { if (options.stopAfter != null && records.length >= options.stopAfter) throw new Error("disk full"); records.push(entry); return entry; } },
  });
  const text = usageText({ "2026-10-20": [["completion", "vocabulary", "customers", 3, 48]] });
  const [unwritable] = loadApps(host({ save: "read-only file system" }), { ids: ["sheets"] });
  assert.deepEqual(unwritable.ipc["sheets:importUsage"]({ text }), { ok: false, error: "Not imported: could not record the import: read-only file system" });
  assert.deepEqual(records, [], "nothing recorded when the import itself cannot be recorded");
  const [stopping] = loadApps(host({ stopAfter: 2 }), { ids: ["sheets"] });
  const partial = stopping.ipc["sheets:importUsage"]({ text });
  assert.deepEqual(partial, { ok: false, added: 2, error: "Added 2 of 3 uses to the statistics, then stopped: disk full; importing the same text again adds the rest.", broadcast: { metrics: true, apps: true } });
  assert.deepEqual(JSON.parse(files.sheets).imported, { [INSTANCE]: { "2026-10-20": { '["completion","vocabulary","customers"]': [2, 32] } } }, "only what was recorded counts as imported");
  assert.equal(JSON.parse(files.sheets).lastImport.added, 2);
  const [working] = loadApps(host({}), { ids: ["sheets"] });
  const again = working.ipc["sheets:importUsage"]({ text });
  assert.deepEqual([again.ok, again.added, again.alreadyImported], [true, 1, 2]);
  assert.equal(records.length, 3);
  assert.equal(records.reduce((sum, e) => sum + e.keystrokesSaved, 0), 48);
  const [silent] = loadApps(host({ audit: "audit.jsonl is read-only" }), { ids: ["sheets"] });
  const noted = silent.ipc["sheets:importUsage"]({ text: usageText({ "2026-10-21": [["completion", "column", "", 1, 1]] }) });
  assert.deepEqual([noted.ok, noted.added, noted.note], [true, 1, "The audit line could not be written: audit.jsonl is read-only"]);
});

test("an imported extle use is an organisation item in the usage report and in actle-admin report when the policy names it, and part of the personal total otherwise", () => {
  const { assistant, dataDir } = desk();
  assistant.invoke("sheets:importUsage", { text: usageText({ "2026-10-20": [
    ["completion", "vocabulary", "customers", 2, 32],
    ["block", "formula", "/vat", 1, 14],
    ["completion", "column", "", 1, 10],
    ["completion", "vocabulary", "regions", 1, 3],
  ] }) });
  const desked = assistant.usageReport();
  assert.deepEqual(desked.byShortcut, [{ trigger: "customers", kind: "sheets", inserts: 2, keystrokesSaved: 32 }, { trigger: "/vat", kind: "sheets", inserts: 1, keystrokesSaved: 14 }]);
  assert.deepEqual(desked.personal, { inserts: 2, keystrokesSaved: 13 }, "the column's value and a vocabulary the policy does not define");
  assert.equal(desked.byKind.sheets, 5);
  const merged = report.mergeReports([desked], { organizationShortcuts: report.organizationShortcuts(assistant.policy()) });
  assert.deepEqual(merged.unused.filter((item) => item.kind === "sheets"), [{ trigger: "costCentres", kind: "sheets" }, { trigger: "/exp", kind: "sheets" }], "used items are matched by kind and trigger");
  const files = temp("actle-sheets-report-");
  fs.writeFileSync(path.join(files, "desk.json"), JSON.stringify(desked));
  fs.writeFileSync(path.join(files, "policy.json"), JSON.stringify({ organization: "Org", sheets: SAMPLE_SECTION }));
  const out = [];
  const code = admin.run(["report", path.join(files, "desk.json"), "--policy", path.join(files, "policy.json")], { stdout: (line) => out.push(line), stderr: () => {} });
  assert.equal(code, 0);
  const printed = out.join("\n");
  assert.match(printed, /sheets customers\s+2 inserts on 1 desk\(s\)/);
  assert.match(printed, /sheets \/vat\s+1 inserts on 1 desk\(s\)/);
  assert.match(printed, /never used: .*sheets costCentres, sheets \/exp/);
  assert.match(printed, /personal shortcuts \(not itemised\): 2 inserts/);
  assert.equal(printed.includes("regions"), false, "a name the policy does not define is not itemised");
  for (const dir of [dataDir, files]) fs.rmSync(dir, { recursive: true, force: true });
});

test("the dashboard tab imports a pasted usage text, shows the result and the last import, keeps a refused text in the box, and says when the channel threw", async () => {
  const { assistant, dataDir } = desk();
  const calls = [];
  const helpers = helpersFor(assistant, calls, []);
  const tab = sandboxed(RENDERER).window.actleApps.sheets;
  const section = new Node("section");
  await tab.render(section, helpers, {});
  assert.ok(section.find((n) => n.tagName === "h2" && n.textContent === "Usage from the add-in"));
  assert.match(section.textContent, /Nothing imported yet\./);
  const box = () => section.find((n) => n.tagName === "textarea" && n.attrs["aria-label"] === "Usage text from the add-in");
  const line = () => section.all((n) => n.attrs.role === "status").pop();
  box().value = "{bad";
  await section.button("Import").click();
  assert.match(line().textContent, /^Not imported: it is not valid JSON/);
  assert.equal(box().value, "{bad", "a refused text stays to be corrected");
  const text = usageText({ "2026-10-20": [["completion", "vocabulary", "customers", 2, 32]], "2026-10-25": [["completion", "column", "", 1, 2]] });
  box().value = text;
  await section.button("Import").click();
  assert.deepEqual(plain(calls.pop()), ["sheets:importUsage", { text }]);
  assert.equal(line().textContent, "Added 2 uses on 1 day to the statistics. 1 use on 1 day after today was not imported.");
  assert.equal(box().value, "", "an imported text is cleared");
  await tab.render(section, helpers, { apps: true, metrics: true });
  assert.match(section.textContent, /Last import .*: 2 uses added, 0 imported before, 1 not imported\./);
  assert.equal(line().textContent, "Added 2 uses on 1 day to the statistics. 1 use on 1 day after today was not imported.", "the result line survives the rebuild");
  box().value = text;
  await section.button("Import").click();
  assert.equal(line().textContent, "Nothing new to add. 2 uses were imported before. 1 use on 1 day after today was not imported.");
  const throwing = Object.assign({}, helpers, { api: Object.assign({}, helpers.api, { invoke: async (channel, payload) => { if (channel === "sheets:info") return assistant.invoke(channel, payload); throw new Error("ipc gone"); } }) });
  const other = new Node("section");
  await tab.render(other, throwing, {});
  other.find((n) => n.attrs["aria-label"] === "Usage text from the add-in").value = text;
  await other.button("Import").click();
  assert.equal(other.all((n) => n.attrs.role === "status").pop().textContent, "Import failed: ipc gone");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
