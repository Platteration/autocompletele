const test = require("node:test");
const assert = require("node:assert/strict");
const metrics = require("../core/metrics.js");

const T = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test("keystrokes saved counts graphemes, never below zero", () => {
  assert.equal(metrics.keystrokesSaved("That is really cool!", "cool/"), 15);
  assert.equal(metrics.keystrokesSaved("ab", "abcd"), 0);
  assert.equal(metrics.keystrokesSaved("👩‍👩‍👧 hi", "x/"), 2); // the family emoji is one grapheme
});

test("seconds saved follows the typing-speed assumption", () => {
  assert.equal(metrics.secondsSaved(200), 60);
  assert.equal(metrics.secondsSaved(100, { charsPerMinute: 300 }), 20);
  assert.equal(metrics.secondsSaved(-5), 0);
  assert.equal(metrics.secondsSaved(10, { charsPerMinute: "nonsense" }), 3);
});

test("period keys: ISO weeks start on Monday", () => {
  assert.equal(metrics.dayKey(new Date(2026, 9, 20)), "2026-10-20");
  assert.equal(metrics.weekKey(new Date(2026, 9, 20)), "2026-W43");
  assert.equal(metrics.weekKey(new Date(2026, 0, 1)), "2026-W01");
  assert.equal(metrics.weekKey(new Date(2027, 0, 1)), "2026-W53");
  assert.equal(metrics.monthKey(new Date(2026, 9, 20)), "2026-10");
  assert.equal(metrics.startOfWeek(new Date(2026, 9, 25, 23)).getDay(), 1);
  assert.equal(metrics.startOfWeek(new Date(2026, 9, 19, 0)).getDate(), 19);
});

test("summary per day, week, month and overall", () => {
  const now = T(2026, 10, 20, 15); // Tuesday
  const ledger = metrics.createLedger({ now: () => now });
  ledger.record({ kind: "expansion", inserted: "0123456789", typed: "x/", at: T(2026, 10, 20, 9) });   // today: 8
  ledger.record({ kind: "expansion", inserted: "0123456789", typed: "x/", at: T(2026, 10, 19, 9) });   // Monday, this week: 8
  ledger.record({ kind: "expansion", inserted: "0123456789", typed: "x/", at: T(2026, 10, 18, 9) });   // Sunday, last week, this month: 8
  ledger.record({ kind: "document", keystrokesSaved: 0, fixedSeconds: 20, at: T(2026, 9, 30, 9) });   // last month
  assert.equal(ledger.summary({ period: "day" }).keystrokesSaved, 8);
  assert.equal(ledger.summary({ period: "day" }).key, "2026-10-20");
  assert.equal(ledger.summary({ period: "week" }).keystrokesSaved, 16);
  assert.equal(ledger.summary({ period: "week" }).key, "2026-W43");
  assert.equal(ledger.summary({ period: "month" }).keystrokesSaved, 24);
  const all = ledger.summary({ period: "all" });
  assert.equal(all.keystrokesSaved, 24);
  assert.equal(all.expansions, 4);
  assert.equal(all.secondsSaved, 24 * 60 / 200 + 20);
  assert.deepEqual(all.byKind, { expansion: 3, document: 1 });
  assert.equal(ledger.summary({ period: "bogus" }).period, "all");
});

test("series returns the last buckets oldest first, including empty ones", () => {
  const now = T(2026, 10, 20);
  const ledger = metrics.createLedger({ now: () => now });
  ledger.record({ inserted: "abcdef", typed: "a/", at: T(2026, 10, 18) });
  ledger.record({ inserted: "abcdef", typed: "a/", at: T(2026, 10, 20) });
  const days = ledger.series({ period: "day", count: 3 });
  assert.deepEqual(days.map((d) => d.key), ["2026-10-18", "2026-10-19", "2026-10-20"]);
  assert.deepEqual(days.map((d) => d.keystrokesSaved), [4, 0, 4]);
  const weeks = ledger.series({ period: "week", count: 2 });
  assert.deepEqual(weeks.map((w) => w.key), ["2026-W42", "2026-W43"]);
  assert.deepEqual(weeks.map((w) => w.keystrokesSaved), [4, 4]);
  const months = ledger.series({ period: "month", count: 2 });
  assert.deepEqual(months.map((m) => m.key), ["2026-09", "2026-10"]);
});

test("byApp ranks applications and names unknown ones", () => {
  const ledger = metrics.createLedger({ now: () => T(2026, 10, 20) });
  ledger.record({ inserted: "abcdef", typed: "a/", app: "outlook" });
  ledger.record({ inserted: "abcdefghij", typed: "a/", app: "outlook" });
  ledger.record({ inserted: "abcdef", typed: "a/" });
  const apps = ledger.byApp();
  assert.deepEqual(apps.map((a) => [a.app, a.keystrokesSaved]), [["outlook", 12], ["(unknown)", 4]]);
});

test("changing the typing speed re-estimates history", () => {
  const ledger = metrics.createLedger({ now: () => T(2026, 10, 20) });
  ledger.record({ keystrokesSaved: 100 });
  assert.equal(ledger.summary().secondsSaved, 30);
  ledger.setCharsPerMinute(100);
  assert.equal(ledger.summary().secondsSaved, 60);
});

test("load tolerates junk, onRecord notifies, prune drops old entries", () => {
  const now = T(2026, 10, 20);
  const ledger = metrics.createLedger({ now: () => now });
  assert.equal(ledger.load([null, "x", { kind: "weird", keystrokesSaved: "7", at: T(2026, 1, 1) }, { keystrokesSaved: 3 }]), 2);
  assert.equal(ledger.entries()[0].kind, "expansion");
  assert.equal(ledger.entries()[0].keystrokesSaved, 7);
  const seen = [];
  const off = ledger.onRecord((entry) => seen.push(entry));
  ledger.record({ keystrokesSaved: 1 });
  off();
  ledger.record({ keystrokesSaved: 1 });
  assert.equal(seen.length, 1);
  assert.equal(ledger.prune(30), 1);
  assert.equal(ledger.size(), 3);
  assert.equal(ledger.prune("no"), 0);
});

test("an undefined or invalid typing speed keeps the default", () => {
  assert.equal(metrics.createLedger({ charsPerMinute: undefined }).charsPerMinute, 200);
  assert.equal(metrics.createLedger({ charsPerMinute: -5 }).charsPerMinute, 200);
  assert.equal(metrics.createLedger({ charsPerMinute: 300 }).charsPerMinute, 300);
});

test("a shown warning is counted per kind but is not an insert", () => {
  const ledger = metrics.createLedger({ now: () => T(2026, 10, 20) });
  ledger.record({ kind: "expansion", inserted: "abcdef", typed: "a/" });
  ledger.record({ kind: "warning", trigger: "card-numbers", source: "organization", keystrokesSaved: 0 });
  ledger.record({ kind: "warning", trigger: "card-numbers", source: "organization", keystrokesSaved: 999 });
  const s = ledger.summary();
  assert.equal(s.expansions, 1);
  assert.equal(s.keystrokesSaved, 4);
  assert.deepEqual(s.byKind, { expansion: 1, warning: 2 });
  assert.deepEqual(ledger.byApp().map((a) => a.expansions), [1]);
  assert.ok(metrics.KINDS.includes("lookup"));
});
