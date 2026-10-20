const test = require("node:test");
const assert = require("node:assert/strict");
const report = require("../core/report.js");
const metrics = require("../core/metrics.js");
const orgPolicy = require("../core/org-policy.js");

const T = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = T(2026, 10, 20, 15); // Tuesday, ISO week 43

const entries = [
  { at: T(2026, 10, 19, 9), kind: "expansion", trigger: "sig/", source: "organization", keystrokesSaved: 40, app: "outlook" },
  { at: T(2026, 10, 19, 10), kind: "expansion", trigger: "divorce/", source: "personal", keystrokesSaved: 60, app: "outlook" },
  { at: T(2026, 10, 20, 9), kind: "document", trigger: "/sld", source: "organization", keystrokesSaved: 0, fixedSeconds: 40, app: "outlook" },
  { at: T(2026, 10, 20, 10), kind: "keyword", trigger: "returns", source: "organization", keystrokesSaved: 90, app: "teams" },
  { at: T(2026, 10, 13, 10), kind: "expansion", trigger: "sig/", source: "organization", keystrokesSaved: 40, app: "outlook" },
  { at: T(2026, 10, 12, 10), kind: "learned", trigger: "tfro/", keystrokesSaved: 0 },
  { at: T(2026, 1, 1, 10), kind: "expansion", trigger: "sig/", source: "organization", keystrokesSaved: 999 },
].map((e) => metrics.normalizeEntry(e, NOW));

test("metrics entries keep a valid source only", () => {
  assert.equal(metrics.normalizeEntry({ source: "organization" }, 0).source, "organization");
  assert.equal(metrics.normalizeEntry({ source: "personal" }, 0).source, "personal");
  assert.equal(metrics.normalizeEntry({ source: "hacker" }, 0).source, "");
  assert.equal(metrics.normalizeEntry({}, 0).source, "");
});

test("a desk report holds bucketed counts and names organisation shortcuts only", () => {
  const r = report.buildReport(entries, { now: NOW, period: "week", count: 2, installId: "desk-1", team: "Shipping", organization: "Example", hourlyRate: 30, currency: "EUR" });
  assert.equal(r.format, "actle-usage-report");
  assert.equal(r.installId, "desk-1");
  assert.deepEqual(r.series.map((s) => [s.key, s.inserts, s.keystrokesSaved]), [["2026-W42", 2, 40], ["2026-W43", 4, 190]]);
  assert.deepEqual(r.totals, { inserts: 6, keystrokesSaved: 230, secondsSaved: 109 });
  assert.deepEqual(r.byShortcut.map((s) => [s.kind, s.trigger, s.inserts]), [["expansion", "sig/", 2], ["document", "/sld", 1], ["keyword", "returns", 1]]);
  assert.deepEqual(r.personal, { inserts: 2, keystrokesSaved: 60 });
  assert.equal(r.byApp, undefined, "applications are left out unless the policy asks");
  assert.deepEqual(r.assumptions, { charsPerMinute: 200, hourlyRate: 30, currency: "EUR" });
  const text = JSON.stringify(r);
  assert.equal(text.includes("divorce"), false, "a personal trigger never leaves the desk");
  assert.equal(text.includes("tfro"), false);
  assert.equal(text.includes(String(T(2026, 10, 19, 9))), false, "no per-entry timestamps");
});

test("applications are included when the policy asks, and periods are honoured", () => {
  const r = report.buildReport(entries, { now: NOW, period: "day", count: 2, includeApps: true });
  assert.deepEqual(r.series.map((s) => s.key), ["2026-10-19", "2026-10-20"]);
  assert.deepEqual(r.byApp.map((a) => [a.app, a.inserts, a.keystrokesSaved]), [["outlook", 3, 100], ["teams", 1, 90]]);
  assert.equal(report.buildReport(entries, { now: NOW, period: "bogus" }).period, "week");
  assert.equal(report.buildReport([], { now: NOW }).series.length, 12);
});

test("mergeReports rolls desks up by team, deduplicates desks and estimates value", () => {
  const a = report.buildReport(entries, { now: NOW, count: 2, installId: "a", team: "Shipping", hourlyRate: 30, currency: "EUR" });
  const aOld = Object.assign({}, a, { generatedAt: NOW - 1000, totals: { inserts: 1, keystrokesSaved: 1, secondsSaved: 1 } });
  const b = report.buildReport(entries.slice(0, 1), { now: NOW, count: 2, installId: "b", team: "Sales", hourlyRate: 30, currency: "EUR" });
  const merged = report.mergeReports([aOld, a, b, { nope: true }, null], {
    organizationShortcuts: report.organizationShortcuts(orgPolicy.parse({
      library: [{ trigger: "sig/", expansion: "x" }, { trigger: "hrs/", expansion: "y" }],
      documents: { shortcuts: [{ trigger: "/sld", documents: [{ path: "p" }] }, { trigger: "/hr", documents: [{ path: "q" }] }] },
      keywordRules: [{ id: "returns", keywords: ["r"], insert: "z" }],
    })),
  });
  assert.equal(merged.desks, 2);
  assert.deepEqual(merged.totals, { inserts: 7, keystrokesSaved: 270, secondsSaved: 121, hoursSaved: 0.03 });
  assert.deepEqual(merged.value, { hourlyRate: 30, currency: "EUR", amount: 0.9 });
  assert.deepEqual(merged.byTeam.map((t) => [t.team, t.desks]), [["Shipping", 1], ["Sales", 1]]);
  assert.deepEqual(merged.byShortcut.map((s) => [s.trigger, s.inserts, s.desks]), [["sig/", 3, 2], ["/sld", 1, 1], ["returns", 1, 1]]);
  assert.deepEqual(merged.unused, [{ trigger: "hrs/", kind: null }, { trigger: "/hr", kind: "document" }]);
  assert.deepEqual(merged.series.map((s) => [s.key, s.desks]), [["2026-W42", 1], ["2026-W43", 2]]);
  assert.equal(merged.warnings.length, 3);
  assert.ok(merged.warnings.some((w) => /desk a sent more than one report/.test(w)));
  // An older duplicate after the newer one is ignored too.
  assert.equal(report.mergeReports([a, aOld]).totals.inserts, 6);
});

test("value needs one agreed hourly rate; an explicit rate wins", () => {
  const a = report.buildReport(entries, { now: NOW, installId: "a", hourlyRate: 30 });
  const b = report.buildReport(entries, { now: NOW, installId: "b", hourlyRate: 50 });
  const disagree = report.mergeReports([a, b]);
  assert.equal(disagree.value, null);
  assert.ok(disagree.warnings.some((w) => /different hourly rates/.test(w)));
  assert.equal(report.mergeReports([a, b], { hourlyRate: 40, currency: "GBP" }).value.currency, "GBP");
  assert.deepEqual(report.mergeReports([]).range, null);
});

test("CSV escapes quotes and neutralises spreadsheet formulas", () => {
  const hostile = report.buildReport([metrics.normalizeEntry({ at: NOW, kind: "expansion", trigger: "=HYPERLINK(\"x\")", source: "organization", keystrokesSaved: 5 }, NOW)],
    { now: NOW, installId: "x", team: "@team, \"quoted\"" });
  const csv = report.toCsv(report.mergeReports([hostile]));
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "section,name,desks,inserts,keystrokes_saved,hours_saved");
  assert.ok(lines.includes('team,"\'@team, ""quoted""",1,1,5,0'), csv);
  assert.ok(lines.some((l) => l.startsWith('shortcut,"\'=HYPERLINK(""x"")"')), csv);
  assert.equal(lines.some((l) => /^[^,]*,=/.test(l)), false);
});

test("odd values in other desks' reports are tolerated, not fatal", () => {
  const good = report.buildReport(entries, { now: NOW, installId: "good", team: "Ops" });
  const odd = Object.assign({}, good, {
    installId: 42, team: null,
    series: [null, { key: null, inserts: 1, keystrokesSaved: 2, secondsSaved: 3 }, "x"],
    byShortcut: [{ trigger: null, kind: 7, inserts: 1 }, 5],
    byApp: [{ app: null, inserts: 1 }],
  });
  const merged = report.mergeReports([good, odd]);
  assert.equal(merged.desks, 2);
  assert.ok(merged.byTeam.some((t) => t.team === "(no team)"));
  assert.ok(merged.series.some((s) => s.key === ""));
  assert.ok(merged.byShortcut.some((s) => s.kind === "7"));
  assert.match(report.toCsv(merged), /^section,/);
});

test("warnings are reported per rule id, never as inserts, and the licence id travels", () => {
  const withWarnings = entries.concat([
    { at: T(2026, 10, 20, 11), kind: "warning", trigger: "card-numbers", source: "organization", keystrokesSaved: 0, app: "outlook" },
    { at: T(2026, 10, 20, 11), kind: "warning", trigger: "card-numbers", source: "organization", keystrokesSaved: 0, app: "outlook" },
    { at: T(2026, 10, 20, 12), kind: "warning", trigger: "contract-disclaimer", source: "organization", keystrokesSaved: 0, app: "outlook" },
  ].map((e) => metrics.normalizeEntry(e, NOW)));
  const r = report.buildReport(withWarnings, { now: NOW, period: "week", count: 2, installId: "a", licenceId: "LIC-42", tier: "team" });
  assert.equal(r.licenceId, "LIC-42");
  assert.equal(r.tier, "team");
  assert.deepEqual(r.warnings, { shown: 3, byRule: [{ id: "card-numbers", count: 2 }, { id: "contract-disclaimer", count: 1 }] });
  assert.equal(r.totals.inserts, 6, "warnings are not inserts");
  assert.equal(r.byShortcut.some((s) => s.kind === "warning"), false);
  assert.equal(r.byKind.warning, 3);
  assert.equal(JSON.stringify(r).includes("Card numbers must not"), false, "a rule's message text never appears");
  const b = report.buildReport(withWarnings, { now: NOW, period: "week", count: 2, installId: "b", licenceId: "LIC-42", tier: "free" });
  const merged = report.mergeReports([r, b, report.buildReport([], { now: NOW, installId: "c" })]);
  assert.deepEqual(merged.complianceWarnings, { shown: 6, byRule: [{ id: "card-numbers", count: 4 }, { id: "contract-disclaimer", count: 2 }] });
  assert.deepEqual(merged.licences, [{ id: "LIC-42", desks: 2, tiers: [{ tier: "free", desks: 1 }, { tier: "team", desks: 1 }] }], "desks per tier show who runs a testing override");
  assert.equal(merged.totals.inserts, 12);
  const csv = report.toCsv(merged);
  assert.ok(csv.includes("warning,card-numbers,,4,,"), csv);
  assert.ok(csv.includes("licence,LIC-42,2,,,"), csv);
  assert.equal(report.buildReport([], { now: NOW }).licenceId, "");
});
