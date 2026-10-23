// extle: the desktop half. The assistant cannot see spreadsheet cells,
// so this app shows what the policy's sheets section holds, lets a person try
// completions against pasted column values, and exports the section for the
// Excel / Google Sheets add-in in corporate/sheets-addin, which does the
// completing inside the spreadsheet. No popover, no engine hook and no tray
// item: nothing is inserted into another application from here. What the
// add-in counted comes back as a text the person pastes (sheets:importUsage)
// and becomes metrics entries of kind "sheets".
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sheets = require("../../../core/sheets.js");
const metrics = require("../../../core/metrics.js");
const { FILES } = require("../../../core/store.js");
const { SAMPLE_SECTION } = require("./sample.js");
const { NAMES } = require("../index.js");

const CONFIG_DATA_ID = "sheets-config"; // only letters and a dash, so the store keeps the name as is
const ADDIN_FOLDER = path.resolve(__dirname, "..", "..", "..", "sheets-addin");
const IMPORT_MAX = 20000; // uses one import adds; the rest wait for the same text pasted again
const DAY_MS = 86400000;

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

/** Local noon of a day key: the time an imported use is recorded at. */
function noonOf(day) {
  const date = sheets.usage.dateOf(day);
  date.setHours(12);
  return date.getTime();
}

const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

/**
 * The counts imported before, per instance, day and counter, as [uses,
 * keystrokes]; days before `cutoff` are dropped, since a text can no longer
 * bring them. Unreadable parts of the file are dropped too.
 */
function importedSince(raw, cutoff) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [instance, days] of Object.entries(raw)) {
    if (!/^[0-9a-f]{32}$/.test(instance) || !days || typeof days !== "object") continue;
    for (const [day, list] of Object.entries(days)) {
      if (!sheets.usage.dateOf(day) || noonOf(day) < cutoff || !list || typeof list !== "object") continue;
      for (const [key, pair] of Object.entries(list)) {
        if (!Array.isArray(pair)) continue;
        const uses = Math.max(0, Math.floor(Number(pair[0]) || 0));
        if (!uses) continue;
        ((out[instance] = out[instance] || {})[day] = out[instance][day] || {})[key] = [uses, Math.max(0, Math.floor(Number(pair[1]) || 0))];
      }
    }
  }
  return out;
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
    const imported = state.lastImport && typeof state.lastImport === "object" ? state.lastImport : null;
    const file = configPath();
    return {
      ok: true,
      organization: String(policy.organization || ""),
      vocabularies: Object.entries(config.vocabularies).map(([name, vocabulary]) => ({
        name, values: vocabulary.values.length, aliases: Object.keys(vocabulary.aliases).length, examples: vocabulary.values.slice(0, 3),
      })),
      columns: config.columns.map((column) => ({ header: column.match.header || "", sheet: column.match.sheet || "", vocabulary: column.vocabulary || "", kind: column.kind || "", strict: column.strict === true })),
      blocks: config.blocks.map(describeBlock),
      warnings: (Array.isArray(policy.warnings) ? policy.warnings : []).filter((warning) => /^sheets /.test(String(warning))),
      lastExport: last ? Object.assign({}, last, { path: file, present: fs.existsSync(file) }) : null,
      lastImport: imported,
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

  /**
   * Add what the add-in counted: payload { text } holds the usage text from
   * its Usage section. Each use not imported before (per instance, day and
   * counter) becomes one metrics entry of kind "sheets" at local noon of its
   * day, named with the vocabulary or trigger only when the current policy's
   * sheets section defines it (source organization), else with no name; the
   * counter's keystrokes are spread over its entries. The same text twice
   * adds nothing, a later text adds the difference, a lower count nothing.
   * Days after today, days before the history the statistics keep, and uses
   * past IMPORT_MAX are refused, each with a reason. Never throws.
   */
  function importUsage(payload) {
    const parsed = sheets.usage.parseUsage(payload && typeof payload === "object" ? payload.text : payload);
    if (!parsed.ok) return { ok: false, error: "Not imported: " + parsed.error + "." };
    const policy = host.policy() || {};
    const config = section();
    const keepDays = policy.retention && Number(policy.retention.metricsDays) > 0 ? Number(policy.retention.metricsDays) : 365;
    const now = host.now();
    const today = metrics.dayKey(new Date(now));
    const cutoff = now - keepDays * DAY_MS;
    const data = host.appData("sheets");
    let saved;
    let imported;
    try {
      saved = data.load({});
      imported = importedSince(saved && saved.imported, cutoff);
    } catch (error) {
      return { ok: false, error: "Not imported: could not read what was imported before: " + error.message };
    }
    const instance = parsed.usage.instance;
    const mine = imported[instance] || {};
    const plan = [];
    const refused = { future: [0, 0], old: [0, 0], over: 0 };
    let room = IMPORT_MAX;
    let already = 0;
    for (const day of Object.keys(parsed.usage.days).sort()) {
      const list = parsed.usage.days[day];
      const uses = list.reduce((total, counter) => total + counter[3], 0);
      if (!uses) continue;
      const late = day > today ? refused.future : noonOf(day) < cutoff ? refused.old : null;
      if (late) {
        late[0] += uses;
        late[1] += 1;
        continue;
      }
      for (const [kind, source, name, count, keystrokes] of list) {
        const key = JSON.stringify([kind, source, name]);
        const before = mine[day] && mine[day][key] ? mine[day][key] : [0, 0];
        already += Math.min(count, before[0]);
        const fresh = count - before[0];
        if (fresh <= 0) continue;
        const take = Math.min(fresh, room);
        refused.over += fresh - take;
        if (!take) continue;
        room -= take;
        const extra = Math.max(0, keystrokes - before[1]);
        // The keystrokes go with the uses: part of them when only part of the uses fit.
        const share = take === fresh ? extra : Math.floor(extra * take / fresh);
        const trigger = !name ? "" : kind === "completion" ? (Object.hasOwn(config.vocabularies, name) ? name : "") : config.blocks.some((block) => block.trigger === name) ? name : "";
        plan.push({ day, key, before, take, share, at: noonOf(day), trigger });
      }
    }
    const added = plan.reduce((total, item) => total + item.take, 0);
    const days = new Set(plan.map((item) => item.day)).size;
    const reasons = [];
    const were = (n) => (n === 1 ? " was" : " were");
    if (refused.future[0]) reasons.push(plural(refused.future[0], "use", "uses") + " on " + plural(refused.future[1], "day", "days") + " after today" + were(refused.future[0]) + " not imported.");
    if (refused.old[0]) reasons.push(plural(refused.old[0], "use", "uses") + " on " + plural(refused.old[1], "day", "days") + " before the " + keepDays + " days the statistics keep" + were(refused.old[0]) + " not imported.");
    if (refused.over) reasons.push(plural(refused.over, "use", "uses") + " past the " + IMPORT_MAX + " one import adds" + were(refused.over) + " not imported; import the same text again to add them.");
    const refusedUses = refused.future[0] + refused.old[0] + refused.over;
    // What is recorded as imported: the counts before plus what each counter adds (all of it, or what was recorded before a failure).
    const remember = (progress, summary) => {
      const out = Object.assign({}, mine);
      plan.forEach((item, i) => {
        const [uses, keystrokes] = progress[i];
        const day = out[item.day] = Object.assign({}, out[item.day]);
        if (item.before[0] + uses) day[item.key] = [item.before[0] + uses, item.before[1] + keystrokes];
      });
      const all = Object.assign({}, imported);
      if (Object.keys(out).length) all[instance] = out;
      data.save(Object.assign({}, saved, { imported: all, lastImport: summary }));
    };
    const summary = { at: now, added, alreadyImported: already, days, refused: refusedUses };
    // Recorded as imported first: a failure after this point can only leave uses out, never count them twice.
    try {
      remember(plan.map((item) => [item.take, item.share]), summary);
    } catch (error) {
      return { ok: false, error: "Not imported: could not record the import: " + error.message };
    }
    const progress = plan.map(() => [0, 0]);
    try {
      plan.forEach((item, i) => {
        const base = Math.floor(item.share / item.take);
        const rest = item.share - base * item.take;
        for (let n = 0; n < item.take; n++) {
          const keystrokesSaved = base + (n < rest ? 1 : 0);
          host.ledger.record({ at: item.at, kind: "sheets", app: NAMES.sheets.name, trigger: item.trigger, source: item.trigger ? "organization" : "", keystrokesSaved });
          progress[i][0] += 1;
          progress[i][1] += keystrokesSaved;
        }
      });
    } catch (error) {
      const recorded = progress.reduce((total, pair) => total + pair[0], 0);
      let kept = "importing the same text again adds the rest.";
      try {
        remember(progress, Object.assign({}, summary, { added: recorded, days: new Set(plan.filter((item, i) => progress[i][0]).map((item) => item.day)).size }));
      } catch (again) {
        kept = "and the import could not be corrected (" + again.message + "), so importing the same text again does not add the rest.";
      }
      return { ok: false, added: recorded, error: "Added " + recorded + " of " + added + " uses to the statistics, then stopped: " + error.message + "; " + kept, broadcast: { metrics: true, apps: true } };
    }
    const result = { ok: true, added, alreadyImported: already, days, refused: reasons, broadcast: { metrics: true, apps: true } };
    try {
      host.audit({ event: "sheets-usage-imported", added, alreadyImported: already, days, refused: refusedUses });
    } catch (error) {
      result.note = "The audit line could not be written: " + error.message;
    }
    return result;
  }

  /** Headless walk-through for desktop/simulate.js: the sample section, the live policy's export, the add-in bundle and a usage hand-over. */
  function simulate(sim) {
    const assert = require("node:assert/strict");
    const config = sheets.normalizeSheets(SAMPLE_SECTION);
    assert.deepEqual(config.warnings, [], "the sample section is clean");
    for (const [name, vocabulary] of Object.entries(config.vocabularies)) {
      sim.print(`  vocabulary ${name}: ${vocabulary.values.length} values, ${Object.keys(vocabulary.aliases).length} aliases, e.g. ${vocabulary.values.slice(0, 2).join(", ")}`);
    }
    for (const column of config.columns) {
      sim.print(`  column rule ${column.match.header ? "header /" + column.match.header + "/" : ""}${column.match.sheet ? " sheet /" + column.match.sheet + "/" : ""} -> ${column.vocabulary ? "vocabulary " + column.vocabulary + (column.strict ? " (strict)" : "") : column.kind + " column"}`);
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
    // A strict column: only the list's values are offered, and a check sorts the column's cells.
    const costs = ["CC-100 Logistics", "sales", "cc-300 warehouse", "CC-999 Old", "CC-999 Old"];
    const strict = sheets.suggest({ header: "Cost centre", text: "cc", values: costs }, config);
    assert.ok(strict.column && strict.column.strict, "the cost centre column is strict");
    assert.deepEqual(strict.completions.map((c) => c.value), ["CC-100 Logistics", "CC-200 Sales", "CC-300 Warehouse"], "only the list's values");
    sim.print(`    strict column "Cost centre" holds ${costs.join(" | ")}; typed "cc" -> ${strict.completions.map((c) => c.value).join("; ")} (CC-999 Old is not offered)`);
    const checked = sheets.checkColumn(costs.map((text, i) => ({ row: i + 2, text })), config.vocabularies.costCentres);
    assert.deepEqual([checked.canonical, checked.fixes.length, checked.unknown.length], [1, 2, 2]);
    sim.print(`    "Check this column": ${checked.canonical} match, list's spelling for ${checked.fixes.map((f) => "C" + f.row + " " + f.text + " -> " + f.value).join(", ")}; not in the list: ${checked.unknown.map((u) => "C" + u.row + " " + u.text).join(", ")}`);
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
    // The way back: the add-in counts what it writes, and the person pastes its usage text into the extle tab.
    const counted = sheets.usage.createUsage();
    const day = new Date(host.now());
    sheets.usage.record(counted, { kind: "completion", source: "vocabulary", name: "customers", inserted: "Acme Logistics GmbH", typed: "acm" }, day);
    sheets.usage.record(counted, { kind: "block", source: "formula", name: "/vat", inserted: "=ROUND(B2*0.19, 2)", typed: "/vat" }, day);
    sheets.usage.record(counted, { kind: "completion", source: "column", inserted: "Zed Transport", typed: "zed" }, day);
    const handed = sheets.usage.serializeUsage(counted);
    const first = sim.assistant.invoke("sheets:importUsage", { text: handed });
    const again = sim.assistant.invoke("sheets:importUsage", { text: handed });
    assert.deepEqual([first.ok, first.added, again.added, again.alreadyImported], [true, 3, 0, 3], "the same text twice adds its uses once");
    const named = sim.assistant.usageReport().byShortcut.filter((row) => row.kind === "sheets").map((row) => row.trigger);
    sim.print(`  usage hand-over (${handed.length} characters, counts only): ${first.added} uses added, then pasted again: ${again.added} added, ${again.alreadyImported} already imported; the usage report names ${named.join(", ") || "none of them (the policy defines neither customers nor /vat)"}; audit: ${sim.assistant.audit().pop().event}`);
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
    title: NAMES.sheets.name,
    tab: true,
    ipc: {
      "sheets:info": () => info(),
      "sheets:complete": (payload) => complete(payload),
      "sheets:exportConfig": () => exportConfig(),
      "sheets:importUsage": (payload) => importUsage(payload),
    },
    simulate,
  };
}

module.exports = { createApp, sectionOf, describeBlock, CONFIG_DATA_ID, ADDIN_FOLDER, IMPORT_MAX };
