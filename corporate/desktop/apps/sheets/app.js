// actle Sheets: the desktop half. The assistant cannot see spreadsheet cells,
// so this app shows what the policy's sheets section holds, lets a person try
// completions against pasted column values, and exports the section for the
// Excel / Google Sheets add-in in corporate/sheets-addin, which does the
// completing inside the spreadsheet. No popover, no engine hook, no tray item
// and no metrics: nothing is inserted into another application from here.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sheets = require("../../../core/sheets.js");
const { FILES } = require("../../../core/store.js");
const { SAMPLE_SECTION } = require("./sample.js");

const CONFIG_DATA_ID = "sheets-config"; // only letters and a dash, so the store keeps the name as is
const ADDIN_FOLDER = path.resolve(__dirname, "..", "..", "..", "sheets-addin");

/** The parsed section, or an empty one when the host has no policy yet. */
function sectionOf(policy) {
  const section = policy && policy.sheets;
  return section && typeof section === "object" && section.vocabularies ? section : sheets.normalizeSheets(undefined);
}

function describeBlock(block) {
  return {
    trigger: block.trigger,
    label: block.label,
    kind: block.formula ? "formula" : "rows",
    formula: block.formula || "",
    rows: block.rows ? block.rows.length : 0,
    columns: block.rows ? block.rows[0].length : 0,
  };
}

function counts(config) {
  return { vocabularies: Object.keys(config.vocabularies).length, columns: config.columns.length, blocks: config.blocks.length };
}

function createApp(host) {
  // Everything about the host is read when a channel is called, never at
  // load time: the registry must be able to load the app with a bare host.
  const section = () => sectionOf(host.policy());
  // Where host.appData(CONFIG_DATA_ID) writes: the store's apps folder and <id>.json (it gives no path back).
  const configPath = () => path.join(String(host.dataDir || ""), FILES.appsDir, CONFIG_DATA_ID + ".json");

  function info() {
    const config = section();
    const policy = host.policy() || {};
    const state = host.appData("sheets").load({});
    const last = state.lastExport && typeof state.lastExport === "object" ? state.lastExport : null;
    const file = configPath();
    return {
      ok: true,
      organization: String(policy.organization || ""),
      vocabularies: Object.entries(config.vocabularies).map(([name, vocabulary]) => ({
        name, values: vocabulary.values.length, aliases: Object.keys(vocabulary.aliases).length, examples: vocabulary.values.slice(0, 3),
      })),
      columns: config.columns.map((column) => ({ header: column.match.header || "", sheet: column.match.sheet || "", vocabulary: column.vocabulary || "", kind: column.kind || "" })),
      blocks: config.blocks.map(describeBlock),
      warnings: (Array.isArray(policy.warnings) ? policy.warnings : []).filter((warning) => /^sheets /.test(String(warning))),
      lastExport: last ? Object.assign({}, last, { path: file, present: fs.existsSync(file) }) : null,
      addin: { folder: ADDIN_FOLDER, present: fs.existsSync(path.join(ADDIN_FOLDER, "build.js")) },
    };
  }

  /** What the add-in would offer for one cell: payload { header, sheet, text, values (one per line), limit }. */
  function complete(payload) {
    const given = payload && typeof payload === "object" ? payload : {};
    const result = sheets.suggest({ header: given.header, sheet: given.sheet, text: given.text, values: given.values, limit: given.limit }, section());
    return {
      ok: true,
      column: result.column,
      profile: result.profile,
      completions: result.completions,
      block: result.block ? Object.assign(describeBlock(result.block), { start: result.block.start }) : null,
    };
  }

  /**
   * Write the section as the add-in takes it to apps/sheets-config.json. An
   * empty section still exports, with a note. A folder that cannot be written
   * (read-only, full) is reported as { ok: false, error }, never thrown.
   */
  function exportConfig() {
    const exported = sheets.exportConfig(section());
    const total = counts(exported);
    const file = configPath();
    try {
      host.appData(CONFIG_DATA_ID).save(exported);
    } catch (error) {
      return { ok: false, error: "Could not write " + file + ": " + error.message };
    }
    const at = host.now();
    try {
      const data = host.appData("sheets");
      data.save(Object.assign({}, data.load({}), { lastExport: Object.assign({ at }, total) }));
      host.audit(Object.assign({ event: "sheets-config-exported" }, total));
    } catch (error) {
      return { ok: false, path: file, error: "Wrote " + file + ", but could not record the export: " + error.message };
    }
    const empty = !total.vocabularies && !total.columns && !total.blocks;
    return { ok: true, path: file, at, counts: total, note: empty ? "The policy has no sheets section; the file holds empty lists." : "", broadcast: { apps: true } };
  }

  /** Headless walk-through for desktop/simulate.js: the sample section, the live policy's export, and the add-in bundle. */
  function simulate(sim) {
    const assert = require("node:assert/strict");
    const config = sheets.normalizeSheets(SAMPLE_SECTION);
    assert.deepEqual(config.warnings, [], "the sample section is clean");
    for (const [name, vocabulary] of Object.entries(config.vocabularies)) {
      sim.print(`  vocabulary ${name}: ${vocabulary.values.length} values, ${Object.keys(vocabulary.aliases).length} aliases, e.g. ${vocabulary.values.slice(0, 2).join(", ")}`);
    }
    for (const column of config.columns) {
      sim.print(`  column rule ${column.match.header ? "header /" + column.match.header + "/" : ""}${column.match.sheet ? " sheet /" + column.match.sheet + "/" : ""} -> ${column.vocabulary ? "vocabulary " + column.vocabulary : column.kind + " column"}`);
    }
    for (const block of config.blocks) {
      const d = describeBlock(block);
      sim.print(`  block ${block.trigger} (${block.label}): ${d.kind === "formula" ? d.formula : d.rows + " rows x " + d.columns + " columns"}`);
    }
    // A column as the add-in reads it (displayed text, header from row 1), then what the person types.
    const values = ["Acme Logistics GmbH", "ACME", "acme logistics gmbh", "Birch & Co", "Zed Transport", "Zed Transport"];
    sim.print(`  column "Customer" on sheet "Orders 2026" holds ${values.length} values: ${values.join(" | ")}`);
    for (const text of ["acm", "zed", "bir", "ACME"]) {
      const result = sheets.suggest({ header: "Customer", sheet: "Orders 2026", text, values }, config);
      assert.ok(result.column && result.column.vocabulary === "customers", "the customer column follows its rule");
      sim.print(`    typed ${JSON.stringify(text)} -> ${result.completions.map((c) => c.value + " [" + c.source + (c.alias ? ", alias " + c.alias : "") + "]").join("; ") || "nothing"}`);
    }
    assert.deepEqual(sheets.suggest({ header: "Customer", sheet: "Orders 2026", text: "acm", values }, config).completions.map((c) => c.value), ["Acme Logistics GmbH", "Northern Acme Ltd"]);
    const notes = ["Customer called about the late delivery. Promised a call back.", "Customer called about the late delivery.", "Parcel left at the side entrance. Promised a call back."];
    const sentence = sheets.suggest({ header: "Delivery notes", text: "Driver was late. Prom", values: notes }, config);
    assert.deepEqual(sentence.completions.map((c) => c.value), ["Promised a call back."]);
    sim.print(`    notes column, typed "Driver was late. Prom" -> ${sentence.completions.map((c) => c.value).join("; ")} (replaces from character ${sentence.completions[0].start})`);
    const block = sheets.suggest({ header: "Amount", text: "/vat", values: ["100", "250"] }, config);
    assert.equal(block.block && block.block.formula, "=ROUND(B2*0.19, 2)");
    sim.print(`    typed "/vat" -> insert ${block.block.label}: ${block.block.formula}`);
    // The live policy: what the dashboard shows and the export the person pastes into the add-in.
    const live = sim.assistant.invoke("sheets:info");
    sim.print(`  policy section: ${live.vocabularies.length} vocabularies, ${live.columns.length} column rules, ${live.blocks.length} blocks, ${live.warnings.length} warnings`);
    const exported = sim.assistant.invoke("sheets:exportConfig");
    const written = sheets.parseConfig(fs.readFileSync(exported.path, "utf8"));
    assert.deepEqual(written.warnings, [], "the exported file reads back without warnings");
    sim.print(`  exported add-in configuration to ${path.relative(host.dataDir, exported.path)}${exported.note ? " (" + exported.note + ")" : ""}; audit: ${sim.assistant.audit().pop().event}`);
    // The add-in bundle, built into a temporary folder and run as a browser would run it.
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "actle-sheets-addin-"));
    try {
      const built = require(path.join(ADDIN_FOLDER, "build.js")).build({ out });
      const vm = require("node:vm");
      const sandbox = {};
      sandbox.self = sandbox;
      sandbox.window = sandbox;
      vm.runInContext(fs.readFileSync(path.join(out, "dist", "sheets-core.js"), "utf8"), vm.createContext(sandbox));
      const inBrowser = sandbox.ActleSheets.suggest({ header: "Customer", sheet: "Orders 2026", text: "acm", values }, sandbox.ActleSheets.normalizeSheets(SAMPLE_SECTION));
      // Array.from builds the list in this realm; the sandbox's arrays have another prototype.
      assert.deepEqual(Array.from(inBrowser.completions, (c) => c.value), ["Acme Logistics GmbH", "Northern Acme Ltd"], "the bundle completes like the core");
      sim.print(`  add-in bundle: ${built.files.join(", ")} (${built.bytes} bytes from ${built.modules.length} modules); in a browser sandbox "acm" -> ${inBrowser.completions[0].value}`);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }

  return {
    id: "sheets",
    title: "Sheets",
    tab: true,
    ipc: {
      "sheets:info": () => info(),
      "sheets:complete": (payload) => complete(payload),
      "sheets:exportConfig": () => exportConfig(),
    },
    simulate,
  };
}

module.exports = { createApp, sectionOf, describeBlock, CONFIG_DATA_ID, ADDIN_FOLDER };
