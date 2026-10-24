// extle usage counts (core/sheets-usage.js): what the add-in records per day,
// the names it keeps and drops, the caps, the day window, the usage text and
// its parser, which refuses anything malformed with a reason and never throws.
const test = require("node:test");
const assert = require("node:assert/strict");
const usage = require("../core/sheets-usage.js");
const sheets = require("../core/sheets.js");

const DAY = "2026-10-23";
const fixed = (byte) => () => new Uint8Array(16).fill(byte);
const vocab = (name, inserted, typed) => ({ kind: "completion", source: "vocabulary", name, inserted, typed });

test("the core re-exports the usage model, so the add-in bundle carries it", () => {
  assert.equal(sheets.usage, usage);
});

test("a new usage state has a 32-character hexadecimal instance id from the random source", () => {
  assert.deepEqual(usage.createUsage({ random: fixed(0xab) }), { instance: "ab".repeat(16), days: {} });
  assert.equal(usage.createUsage({ random: () => [1, 2, 300] }).instance, "01022c" + "00".repeat(13), "bytes are taken modulo 256 and missing ones are 0");
  const a = usage.createUsage();
  const b = usage.createUsage();
  assert.match(a.instance, /^[0-9a-f]{32}$/);
  assert.notEqual(a.instance, b.instance, "crypto.getRandomValues by default");
});

test("record counts a use and the keystrokes it saved in graphemes, keeps a vocabulary's name or a block's trigger, and no name for the column, notes or a document's configuration", () => {
  const state = usage.createUsage({ random: fixed(1) });
  assert.deepEqual(usage.record(state, vocab("customers", "Acme Logistics GmbH", "acm"), DAY), { kind: "completion", source: "vocabulary", name: "customers", keystrokes: 16, day: DAY });
  assert.deepEqual(usage.record(state, vocab("customers", "Acme Logistics GmbH", "ACME"), new Date(2026, 9, 23, 18)), { kind: "completion", source: "vocabulary", name: "customers", keystrokes: 15, day: DAY }, "a Date counts on its local day");
  assert.equal(usage.record(state, { kind: "completion", source: "column", name: "secret", inserted: "Zed Transport", typed: "zed" }, DAY).name, "", "a column completion carries no name, whatever is given");
  assert.equal(usage.record(state, { kind: "completion", source: "notes", inserted: "Driver was late. Promised a call back.", typed: "Driver was late. Prom" }, DAY).keystrokes, 17);
  assert.deepEqual(usage.record(state, { kind: "block", source: "formula", name: "/vat", inserted: "=ROUND(B2*0.19, 2)", typed: "/vat" }, DAY), { kind: "block", source: "formula", name: "/vat", keystrokes: 14, day: DAY });
  assert.deepEqual(usage.record(state, { kind: "block", source: "rows", name: "/vat", inserted: "a\tb", typed: "/vat", document: true }, DAY), { kind: "block", source: "document", name: "", keystrokes: 0, day: DAY }, "a document's configuration: no name, and never below 0");
  assert.equal(usage.record(state, Object.assign(vocab("customers", "x", ""), { document: true }), DAY).source, "document");
  // Graphemes, not UTF-16 units: an emoji with a skin tone and a combined accent are one keystroke each.
  assert.equal(usage.record(state, vocab("customers", "👍🏽é", ""), DAY).keystrokes, 2);
  assert.deepEqual(state.days[DAY], [
    ["completion", "vocabulary", "customers", 3, 33],
    ["completion", "column", "", 1, 10],
    ["completion", "notes", "", 1, 17],
    ["block", "formula", "/vat", 1, 14],
    ["block", "document", "", 1, 0],
    ["completion", "document", "", 1, 1],
  ]);
  for (const [event, day] of [[{ kind: "paste", source: "column" }, DAY], [{ kind: "block", source: "column" }, DAY], [{ kind: "completion", source: "vocabulary" }, "2026-02-30"], [{ kind: "completion", source: "vocabulary" }, "yesterday"], [null, DAY], [{ kind: "completion", source: "vocabulary" }, undefined]]) {
    assert.equal(usage.record(state, event, day), null, JSON.stringify([event, day]));
  }
  assert.deepEqual(Object.keys(state.days), [DAY], "nothing else was counted");
  // The pane runs in the page's realm; a Date made there is a Date here too.
  assert.equal(usage.dayOf(require("node:vm").runInNewContext("new Date(2026, 9, 23, 10)")), DAY);
  assert.equal(usage.dayOf(new Date(NaN)), null);
  assert.equal(usage.dayOf({ getTime: () => 0 }), null);
});

test("a name longer than 40 characters, with a control character or a surrogate, or past 12 names a day, is counted without it", () => {
  const state = usage.createUsage({ random: fixed(2) });
  assert.equal(usage.record(state, vocab("x".repeat(40), "a", ""), DAY).name, "x".repeat(40));
  assert.equal(usage.record(state, vocab("x".repeat(41), "a", ""), DAY).name, "");
  assert.equal(usage.record(state, vocab("line\nbreak", "a", ""), DAY).name, "");
  assert.equal(usage.record(state, vocab("emoji 😀", "a", ""), DAY).name, "");
  assert.equal(usage.record(state, vocab("Kostenstellen €", "a", ""), DAY).name, "Kostenstellen €", "other text is kept");
  for (let i = 0; i < 10; i++) usage.record(state, { kind: "block", source: "formula", name: "/f" + i, inserted: "=1", typed: "" }, DAY);
  assert.equal(state.days[DAY].filter((c) => c[2]).length, 12);
  assert.equal(usage.record(state, vocab("thirteenth", "a", ""), DAY).name, "", "the 13th name of the day");
  assert.equal(usage.record(state, vocab("Kostenstellen €", "a", ""), DAY).name, "Kostenstellen €", "a name already counted that day keeps counting");
  assert.equal(usage.record(state, vocab("thirteenth", "a", ""), "2026-10-24").name, "thirteenth", "the next day starts afresh");
  assert.equal(usage.keepsName(""), false);
  assert.equal(usage.keepsName(7), false);
});

test("a counter stops at its caps: a use past 100,000 a day is not counted, keystrokes stop at 100,000,000", () => {
  const state = usage.createUsage({ random: fixed(3) });
  usage.record(state, vocab("customers", "Acme", ""), DAY);
  state.days[DAY][0][3] = usage.LIMITS.count - 1;
  state.days[DAY][0][4] = usage.LIMITS.keystrokes - 2;
  assert.equal(usage.record(state, vocab("customers", "Acme", ""), DAY).keystrokes, 4);
  assert.deepEqual(state.days[DAY][0].slice(3), [usage.LIMITS.count, usage.LIMITS.keystrokes]);
  assert.equal(usage.record(state, vocab("customers", "Acme", ""), DAY), null);
  assert.deepEqual(state.days[DAY][0].slice(3), [usage.LIMITS.count, usage.LIMITS.keystrokes]);
});

test("days older than the 120 that end on the day counted are dropped; days after it are kept, up to 120 days in all", () => {
  const state = usage.createUsage({ random: fixed(4) });
  for (const day of ["2026-06-25", "2026-06-26", "2026-10-22"]) usage.record(state, vocab("customers", "a", ""), day);
  usage.record(state, vocab("customers", "a", ""), DAY);
  assert.deepEqual(Object.keys(state.days).sort(), ["2026-06-26", "2026-10-22", DAY], "2026-06-26 is the 120th day back from 2026-10-23");
  usage.record(state, vocab("customers", "a", ""), "2026-09-01");
  assert.deepEqual(Object.keys(state.days).sort(), ["2026-06-26", "2026-09-01", "2026-10-22", DAY], "a clock that went back drops nothing");
  const full = usage.createUsage({ random: fixed(5) });
  const day = new Date(2026, 9, 23);
  for (let i = 0; i < 120; i++, day.setDate(day.getDate() - 1)) usage.record(full, vocab("customers", "a", ""), new Date(day));
  assert.equal(Object.keys(full.days).length, 120);
  usage.record(full, vocab("customers", "a", ""), "2026-06-25");
  assert.equal(Object.keys(full.days).length, 120, "never more than 120 days");
  assert.equal(Object.hasOwn(full.days, "2026-06-25"), false, "the oldest goes");
});

test("totals adds the uses and keystrokes of today and of the last 7 days", () => {
  const state = usage.createUsage({ random: fixed(6) });
  usage.record(state, vocab("customers", "Acme Logistics GmbH", "acm"), DAY);
  usage.record(state, { kind: "block", source: "formula", name: "/vat", inserted: "=ROUND(B2*0.19, 2)", typed: "/vat" }, "2026-10-17");
  usage.record(state, vocab("customers", "Acme", ""), "2026-10-16");
  usage.record(state, vocab("customers", "Acme", ""), "2026-10-24");
  assert.deepEqual(usage.totals(state, DAY, 1), { uses: 1, keystrokes: 16 });
  assert.deepEqual(usage.totals(state, new Date(2026, 9, 23, 9), 7), { uses: 2, keystrokes: 30 }, "2026-10-17 to 2026-10-23");
  assert.deepEqual(usage.totals(state, "nonsense", 7), { uses: 0, keystrokes: 0 });
});

test("the usage text holds the format, the version, the instance id and the days, oldest first, and reads back as it was", () => {
  const state = usage.createUsage({ random: fixed(0x0f) });
  usage.record(state, vocab("customers", "Acme Logistics GmbH", "acm"), DAY);
  usage.record(state, { kind: "block", source: "rows", name: "/exp", inserted: "Date\tAmount", typed: "/exp" }, "2026-10-01");
  state.days["2026-10-02"] = [];
  const text = usage.serializeUsage(state);
  assert.equal(text, '{"format":"extle-usage","version":1,"instance":"' + "0f".repeat(16) + '","days":{"2026-10-01":[["block","rows","/exp",1,7]],"2026-10-23":[["completion","vocabulary","customers",1,16]]}}');
  assert.deepEqual(usage.parseUsage(text), { ok: true, usage: { instance: "0f".repeat(16), days: { "2026-10-01": [["block", "rows", "/exp", 1, 7]], "2026-10-23": [["completion", "vocabulary", "customers", 1, 16]] } } });
  assert.deepEqual(usage.parseUsage(JSON.stringify(Object.assign(JSON.parse(text), { extra: 1 }), null, 2)).ok, true, "formatting and extra fields do not matter");
});

test("the longest text the add-in can write stays below the parser's cap and a Google user property store", () => {
  // Every day of 120 holds 12 names of 40 three-byte characters (the most a kept character takes: no surrogate, no
  // control character, and JSON escapes " and \ in 2 bytes) under the longest kind and source, and every unnamed counter, each at its caps.
  const state = usage.createUsage({ random: fixed(7) });
  const day = new Date(2026, 9, 23);
  const unnamed = [["completion", "vocabulary"], ["completion", "column"], ["completion", "notes"], ["completion", "document"], ["block", "formula"], ["block", "rows"], ["block", "document"]];
  const wide = "€₤₥₦₧₨₩₪₫₭₮₯"; // a character of three UTF-8 bytes for each name
  assert.equal(Buffer.byteLength(wide), 3 * wide.length);
  for (let d = 0; d < usage.LIMITS.days; d++, day.setDate(day.getDate() - 1)) {
    const list = [];
    for (let i = 0; i < usage.LIMITS.namesPerDay; i++) list.push(["completion", "vocabulary", wide[i].repeat(usage.LIMITS.nameLength), usage.LIMITS.count, usage.LIMITS.keystrokes]);
    for (const [kind, source] of unnamed) list.push([kind, source, "", usage.LIMITS.count, usage.LIMITS.keystrokes]);
    state.days[usage.dayOf(new Date(day))] = list;
  }
  const text = usage.serializeUsage(state);
  assert.equal(usage.parseUsage(text).ok, true, "the parser takes it");
  assert.ok(text.length <= usage.LIMITS.characters, text.length + " characters");
  // developers.google.com/apps-script/guides/services/quotas: 500 KB per property store; Code.gs adds a key per 8,192-byte piece.
  const bytes = Buffer.byteLength(text, "utf8");
  assert.ok(bytes + Math.ceil(bytes / 8192) * 40 < 500000, bytes + " bytes");
  assert.equal(bytes, 279691, "the figure the add-in README gives");
  assert.equal(text.length, 164491);
});

test("parseUsage refuses malformed or oversized text with a reason, and never throws", () => {
  const good = { format: "extle-usage", version: 1, instance: "ab".repeat(16), days: { [DAY]: [["completion", "vocabulary", "customers", 2, 10]] } };
  const with_ = (change) => { const copy = JSON.parse(JSON.stringify(good)); change(copy); return JSON.stringify(copy); };
  const counter = (value) => with_((u) => { u.days[DAY] = [value]; });
  const cases = [
    [undefined, /^there is no text; copy it from the Usage section of the extle add-in$/],
    ["   ", /^there is no text/],
    [{ format: "extle-usage" }, /^there is no text/],
    [" ".repeat(usage.LIMITS.characters) + "{}", /^it is longer than 300000 characters, more than the extle add-in writes$/],
    ["{bad", /^it is not valid JSON \(/],
    ["[1]", /^it is not a usage text from the extle add-in \(format extle-usage\)$/],
    ["null", /^it is not a usage text/],
    [with_((u) => { u.format = "actle-usage-report"; }), /^it is not a usage text/],
    [with_((u) => { u.version = 2; }), /^it is version 2 of the usage text; this version reads 1$/],
    [with_((u) => { u.instance = "AB".repeat(16); }), /^its instance id is not 32 hexadecimal characters$/],
    [with_((u) => { u.instance = 7; }), /instance id/],
    [with_((u) => { u.days = []; }), /^its days are not an object$/],
    [with_((u) => { u.days = null; }), /^its days are not an object$/],
    [with_((u) => { for (let i = 0; i < 121; i++) u.days["k" + i] = []; }), /^it holds 122 days, more than the 120 the add-in keeps$/],
    [with_((u) => { u.days["2026-02-30"] = []; }), /^day "2026-02-30" is not a date \(YYYY-MM-DD\)$/],
    [with_((u) => { u.days["23.10.2026"] = []; }), /is not a date/],
    [with_((u) => { u.days[DAY] = {}; }), /^day 2026-10-23 is not a list of counters$/],
    [counter("x"), /^day 2026-10-23: a counter is not \[kind, source, name, count, keystrokes\]$/],
    [counter(["completion", "vocabulary", "customers", 1]), /a counter is not/],
    [counter(["paste", "column", "", 1, 0]), /^day 2026-10-23: unknown kind "paste"$/],
    [counter([["completion"], "column", "", 1, 0]), /unknown kind \[/],
    [counter(["block", "column", "", 1, 0]), /^day 2026-10-23: unknown source "column" for block$/],
    [counter(["completion", "column", 5, 1, 0]), /a name is not text/],
    [counter(["completion", "column", "Zed Transport", 1, 0]), /^day 2026-10-23: the name "Zed Transport" is not one the add-in keeps for completion column$/],
    [counter(["block", "document", "/vat", 1, 0]), /is not one the add-in keeps for block document/],
    [counter(["completion", "vocabulary", "x".repeat(41), 1, 0]), /the name "x{38}… is not one the add-in keeps/],
    [counter(["completion", "vocabulary", "a\u0000b", 1, 0]), /is not one the add-in keeps/],
    [counter(["completion", "vocabulary", "customers", 0, 0]), /^day 2026-10-23: a count is not a whole number from 1 to 100000$/],
    [counter(["completion", "vocabulary", "customers", 100001, 0]), /a count is not/],
    [counter(["completion", "vocabulary", "customers", 1.5, 0]), /a count is not/],
    [counter(["completion", "vocabulary", "customers", "1", 0]), /a count is not/],
    [counter(["completion", "vocabulary", "customers", 1, -1]), /^day 2026-10-23: a keystroke count is not a whole number from 0 to 100000000$/],
    [counter(["completion", "vocabulary", "customers", 1, 100000001]), /a keystroke count is not/],
    [counter(["completion", "vocabulary", "customers", 1, null]), /a keystroke count is not/],
    [with_((u) => { u.days[DAY].push(["completion", "vocabulary", "customers", 1, 0]); }), /^day 2026-10-23: \["completion","vocabulary","customers"\] is counted twice$/],
    [with_((u) => { u.days[DAY] = Array.from({ length: 13 }, (_, i) => ["block", "formula", "/f" + i, 1, 0]); }), /^day 2026-10-23: more than 12 names$/],
  ];
  for (const [input, expected] of cases) {
    const result = usage.parseUsage(input);
    assert.equal(result.ok, false, String(input).slice(0, 80));
    assert.match(result.error, expected);
    assert.deepEqual(Object.keys(result), ["ok", "error"]);
  }
  assert.equal(usage.parseUsage(" ".repeat(usage.LIMITS.characters - JSON.stringify(good).length) + JSON.stringify(good)).ok, true, "exactly at the cap is read");
  assert.equal(usage.parseUsage(with_((u) => { u.days[DAY] = Array.from({ length: 12 }, (_, i) => ["block", "formula", "/f" + i, 1, 0]); })).ok, true, "12 names are read");
  assert.equal(usage.parseUsage(with_((u) => { u.days = {}; })).ok, true, "no days is an empty text, not an error");
});

test("mergeUsage adds what one pane counted since its last save to what is stored, under the same limits as record", () => {
  const stored = usage.createUsage({ random: fixed(8) });
  usage.record(stored, vocab("customers", "Acme Logistics GmbH", "acm"), DAY);
  const delta = { instance: "00".repeat(16), days: {} };
  usage.record(delta, vocab("customers", "Acme Logistics GmbH", "acm"), DAY);
  usage.record(delta, { kind: "block", source: "formula", name: "/vat", inserted: "=ROUND(B2*0.19, 2)", typed: "/vat" }, "2026-10-22");
  assert.equal(usage.mergeUsage(stored, delta), stored, "the stored state is changed and returned");
  assert.equal(stored.instance, "08".repeat(16), "the stored instance stays");
  assert.deepEqual(stored.days, { [DAY]: [["completion", "vocabulary", "customers", 2, 32]], "2026-10-22": [["block", "formula", "/vat", 1, 14]] });
  // Caps: a counter stops at 100,000 uses; a 13th name of a day goes to the unnamed counter; old days go.
  const full = usage.createUsage({ random: fixed(9) });
  for (let i = 0; i < 12; i++) usage.record(full, { kind: "block", source: "formula", name: "/f" + i, inserted: "=1", typed: "" }, DAY);
  full.days[DAY][0][3] = usage.LIMITS.count - 1;
  full.days["2026-01-01"] = [["completion", "column", "", 1, 1]];
  usage.mergeUsage(full, { instance: "", days: { [DAY]: [["block", "formula", "/f0", 5, 5], ["block", "formula", "/new", 2, 4]] } });
  assert.deepEqual(full.days[DAY][0].slice(3), [usage.LIMITS.count, 7], "2 keystrokes from \"=1\" and 5 merged; the uses stop at the cap");
  assert.deepEqual(full.days[DAY][12], ["block", "formula", "", 2, 4]);
  assert.equal(Object.hasOwn(full.days, "2026-01-01"), false, "dropped from the newest day of what was merged");
  assert.deepEqual(usage.mergeUsage(usage.createUsage({ random: fixed(1) }), { instance: "", days: {} }).days, {}, "nothing to add changes nothing");
});
