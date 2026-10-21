// Usage reports: what a desk exports for its organisation, and how an
// administrator rolls several desks up into a team view with a value estimate.
//
// A report holds counts only. Threat: the report goes to the employer, and the
// same ledger knows which of the person's own shortcuts they use. A personal
// trigger name ("divorce/", "clinic/") or any typed or inserted text would
// tell the employer about a private matter. So a report names only shortcuts,
// keyword rules and document sets the organisation itself defined; everything
// else is one "personal" total. Times are bucketed by day, week or month;
// individual timestamps never leave the desk. Application names are included
// only when the organisation policy asks for them.
"use strict";

const metrics = require("./metrics.js");

const FORMAT = "actle-usage-report";
const VERSION = 1;
const PERIODS = Object.freeze(["day", "week", "month"]);

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function totalsOf(t) {
  return { inserts: t.expansions, keystrokesSaved: t.keystrokesSaved, secondsSaved: round(t.secondsSaved, 1) };
}

/**
 * Build a desk's report from its ledger entries.
 * @param {Array} entries normalised ledger entries
 * @param {object} options { now, period, count, charsPerMinute, installId, team, organization, includeApps, hourlyRate, currency }
 */
function buildReport(entries, options) {
  const settings = Object.assign({ period: "week", count: 12, includeApps: false }, options || {});
  const period = PERIODS.includes(settings.period) ? settings.period : "week";
  const count = Math.max(1, Math.min(366, Math.floor(Number(settings.count) || 12)));
  const now = Number(settings.now) || Date.now();
  const ledger = metrics.createLedger({ now: () => now, charsPerMinute: settings.charsPerMinute });
  ledger.load(entries);
  const series = ledger.series({ period, count, now });
  const from = series[0].from;
  const to = series[series.length - 1].to;
  const inRange = ledger.entries().filter((e) => e.at >= from && e.at < to);

  const shortcuts = new Map();
  const personal = { inserts: 0, keystrokesSaved: 0 };
  for (const entry of inRange) {
    if (entry.source === "organization" && entry.trigger) {
      const key = entry.kind + "\u0000" + entry.trigger;
      const row = shortcuts.get(key) || { trigger: entry.trigger, kind: entry.kind, inserts: 0, keystrokesSaved: 0 };
      row.inserts += 1;
      row.keystrokesSaved += entry.keystrokesSaved;
      shortcuts.set(key, row);
    } else {
      personal.inserts += 1;
      personal.keystrokesSaved += entry.keystrokesSaved;
    }
  }
  const totals = ledger.range(from, to);
  const report = {
    format: FORMAT,
    version: VERSION,
    generatedAt: now,
    installId: String(settings.installId || ""),
    team: String(settings.team || ""),
    organization: String(settings.organization || ""),
    period,
    range: { from, to },
    assumptions: {
      charsPerMinute: ledger.charsPerMinute,
      hourlyRate: Number(settings.hourlyRate) > 0 ? Number(settings.hourlyRate) : null,
      currency: settings.currency ? String(settings.currency) : null,
    },
    totals: totalsOf(totals),
    byKind: Object.assign({}, totals.byKind),
    series: series.map((bucket) => Object.assign({ key: bucket.key }, totalsOf(bucket))),
    byShortcut: [...shortcuts.values()].sort((a, b) => b.inserts - a.inserts || a.trigger.localeCompare(b.trigger)),
    personal,
  };
  if (settings.includeApps) {
    report.byApp = ledger.byApp({ from, to }).map((row) => Object.assign({ app: row.app }, totalsOf(row)));
  }
  return report;
}

function isReport(value) {
  return !!value && typeof value === "object" && value.format === FORMAT && value.version === VERSION
    && value.totals && typeof value.totals === "object" && Array.isArray(value.series);
}

// Reports come from other desks' files: names are made strings and rows
// that are not objects are skipped, so one odd file cannot stop a roll-up.
function name(value) {
  return value == null ? "" : String(value);
}

function rows(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") : [];
}

function addTotals(target, source) {
  target.inserts += Number(source.inserts) || 0;
  target.keystrokesSaved += Number(source.keystrokesSaved) || 0;
  target.secondsSaved = round(target.secondsSaved + (Number(source.secondsSaved) || 0), 1);
}

function zero() {
  return { inserts: 0, keystrokesSaved: 0, secondsSaved: 0 };
}

/**
 * Roll desk reports up. Unreadable reports are skipped with a warning; a desk
 * that sent several reports counts once, with its newest report.
 * @param {Array} reports parsed report objects
 * @param {object} options { hourlyRate, currency, organizationShortcuts: [{trigger, kind}] }
 */
function mergeReports(reports, options) {
  const settings = options || {};
  const warnings = [];
  const latest = new Map();
  let anonymous = 0;
  (Array.isArray(reports) ? reports : []).forEach((report, index) => {
    if (!isReport(report)) {
      warnings.push("report " + (index + 1) + " skipped: not an actle usage report");
      return;
    }
    const id = name(report.installId) || "anonymous-" + anonymous++;
    const previous = latest.get(id);
    if (previous) {
      warnings.push("desk " + id + " sent more than one report; the newest is used");
      if (previous.generatedAt >= report.generatedAt) return;
    }
    latest.set(id, report);
  });
  const desks = [...latest.values()];

  const rates = new Set(desks.map((r) => r.assumptions && r.assumptions.hourlyRate).filter((r) => r));
  let hourlyRate = Number(settings.hourlyRate) > 0 ? Number(settings.hourlyRate) : null;
  if (!hourlyRate && rates.size === 1) hourlyRate = [...rates][0];
  if (!hourlyRate && rates.size > 1) warnings.push("desks report different hourly rates; pass one to estimate value");
  const currencies = new Set(desks.map((r) => r.assumptions && r.assumptions.currency).filter(Boolean));
  const currency = settings.currency || (currencies.size === 1 ? [...currencies][0] : null);

  const totals = zero();
  const personal = { inserts: 0, keystrokesSaved: 0 };
  const series = new Map();
  const teams = new Map();
  const shortcuts = new Map();
  const apps = new Map();
  let from = Infinity;
  let to = -Infinity;
  for (const report of desks) {
    addTotals(totals, report.totals);
    personal.inserts += Number(report.personal && report.personal.inserts) || 0;
    personal.keystrokesSaved += Number(report.personal && report.personal.keystrokesSaved) || 0;
    if (report.range) {
      from = Math.min(from, Number(report.range.from));
      to = Math.max(to, Number(report.range.to));
    }
    for (const bucket of rows(report.series)) {
      const key = name(bucket.key);
      const row = series.get(key) || Object.assign({ key, desks: 0 }, zero());
      addTotals(row, bucket);
      if (bucket.inserts) row.desks += 1;
      series.set(key, row);
    }
    const teamName = name(report.team) || "(no team)";
    const team = teams.get(teamName) || Object.assign({ team: teamName, desks: 0 }, zero());
    team.desks += 1;
    addTotals(team, report.totals);
    teams.set(teamName, team);
    for (const item of rows(report.byShortcut)) {
      const key = name(item.kind) + "\u0000" + name(item.trigger);
      const row = shortcuts.get(key) || { trigger: name(item.trigger), kind: name(item.kind), inserts: 0, keystrokesSaved: 0, desks: 0 };
      row.inserts += Number(item.inserts) || 0;
      row.keystrokesSaved += Number(item.keystrokesSaved) || 0;
      row.desks += 1;
      shortcuts.set(key, row);
    }
    for (const item of rows(report.byApp)) {
      const app = name(item.app);
      const row = apps.get(app) || Object.assign({ app, desks: 0 }, zero());
      addTotals(row, item);
      row.desks += 1;
      apps.set(app, row);
    }
  }

  const hours = round(totals.secondsSaved / 3600, 2);
  const used = new Set([...shortcuts.values()].filter((s) => s.inserts > 0).map((s) => s.kind + "\u0000" + s.trigger));
  const unused = (Array.isArray(settings.organizationShortcuts) ? settings.organizationShortcuts : [])
    .filter((s) => ![...used].some((key) => key.endsWith("\u0000" + s.trigger) && (!s.kind || key.startsWith(s.kind + "\u0000"))))
    .map((s) => ({ trigger: s.trigger, kind: s.kind || null }));

  return {
    desks: desks.length,
    range: desks.length ? { from, to } : null,
    totals: Object.assign({}, totals, { hoursSaved: hours }),
    value: hourlyRate ? { hourlyRate, currency, amount: round(hours * hourlyRate, 2) } : null,
    personal,
    byTeam: [...teams.values()].sort((a, b) => b.secondsSaved - a.secondsSaved || a.team.localeCompare(b.team))
      .map((t) => Object.assign(t, { hoursSaved: round(t.secondsSaved / 3600, 2) })),
    series: [...series.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byShortcut: [...shortcuts.values()].sort((a, b) => b.inserts - a.inserts || a.trigger.localeCompare(b.trigger)),
    byApp: [...apps.values()].sort((a, b) => b.secondsSaved - a.secondsSaved || a.app.localeCompare(b.app)),
    unused,
    warnings,
  };
}

/** Organisation-defined names a report may itemise, from a parsed policy. */
function organizationShortcuts(policy) {
  if (!policy) return [];
  const out = [];
  for (const sh of policy.library || []) out.push({ trigger: sh.trigger, kind: null });
  for (const doc of (policy.documents && policy.documents.shortcuts) || []) out.push({ trigger: doc.trigger, kind: "document" });
  for (const rule of policy.keywordRules || []) out.push({ trigger: rule.id, kind: "keyword" });
  const filing = policy.filing || {};
  for (const rule of (filing.rules || []).concat(filing.fallback ? [filing.fallback] : [])) out.push({ trigger: rule.id, kind: "filed" });
  // Suite modules name their own organisation items (a reply id, a record id, a
  // guard rule id, a notes document id) through an optional organizationItems().
  for (const name of ["reply", "forms", "guard", "notes"]) {
    const mod = require("./" + name + ".js");
    if (typeof mod.organizationItems === "function" && policy[name]) {
      for (const item of mod.organizationItems(policy[name]) || []) {
        if (item && typeof item.trigger === "string" && item.trigger) out.push({ trigger: item.trigger, kind: typeof item.kind === "string" ? item.kind : null });
      }
    }
  }
  return out;
}

function csvCell(value) {
  const text = String(value == null ? "" : value);
  // Leading = + - @ would be run as a formula by spreadsheet programs.
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/** One CSV with a section column, for a spreadsheet. */
function toCsv(merged) {
  const rows = [["section", "name", "desks", "inserts", "keystrokes_saved", "hours_saved"]];
  const hours = (seconds) => round(seconds / 3600, 2);
  rows.push(["total", "all desks", merged.desks, merged.totals.inserts, merged.totals.keystrokesSaved, merged.totals.hoursSaved]);
  for (const t of merged.byTeam) rows.push(["team", t.team, t.desks, t.inserts, t.keystrokesSaved, t.hoursSaved]);
  for (const s of merged.series) rows.push(["period", s.key, s.desks, s.inserts, s.keystrokesSaved, hours(s.secondsSaved)]);
  for (const s of merged.byShortcut) rows.push(["shortcut", (s.kind === "expansion" || s.kind === "template" ? "" : s.kind + ":") + s.trigger, s.desks, s.inserts, s.keystrokesSaved, ""]);
  for (const s of merged.unused) rows.push(["unused", (s.kind ? s.kind + ":" : "") + s.trigger, 0, 0, 0, ""]);
  for (const a of merged.byApp) rows.push(["application", a.app, a.desks, a.inserts, a.keystrokesSaved, hours(a.secondsSaved)]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

module.exports = { FORMAT, VERSION, buildReport, isReport, mergeReports, organizationShortcuts, toCsv };
