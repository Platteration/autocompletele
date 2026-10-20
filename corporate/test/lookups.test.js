const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lookups = require("../core/lookups.js");
const orgPolicy = require("../core/org-policy.js");
const { createAssistant } = require("../desktop/assistant.js");

const CSV = 'id,name,address\r\n1001,"Acme, Ltd","12 Harbour Road\nHull"\r\n1002,"Says ""hi""",Oslo\r\n\r\n 1003 ,Spaced,Bergen\r\n';
const policyRaw = { lookups: [
  { trigger: "/cust", label: "Customer", source: { kind: "csv", path: "S:/customers.csv", key: "id" }, template: "[[name]] ([[id]])\n[[address]]\nSeen {date}" },
  { trigger: "/ord", label: "Order", source: { kind: "json", url: "https://data.example/orders.json", key: "ref", refreshMinutes: 5 }, template: "Order [[ref]]: [[status]]" },
] };

test("parseCsv handles quotes, doubled quotes, embedded newlines, CRLF and blank lines", () => {
  const rows = lookups.parseCsv(CSV);
  assert.deepEqual(rows, [
    { id: "1001", name: "Acme, Ltd", address: "12 Harbour Road\nHull" },
    { id: "1002", name: 'Says "hi"', address: "Oslo" },
    { id: " 1003 ", name: "Spaced", address: "Bergen" },
  ]);
  assert.deepEqual(lookups.parseCsv(""), []);
  assert.deepEqual(lookups.parseCsv("\uFEFFa,b\n1,2"), [{ a: "1", b: "2" }]);
  assert.deepEqual(lookups.rowsFrom("json", '{"rows":[{"ref":"A"},5,null]}'), [{ ref: "A" }]);
  assert.throws(() => lookups.rowsFrom("json", '{"nope":1}'), /array of objects/);
});

test("normalizeLookups validates triggers, sources, keys and templates", () => {
  const { lookups: ok, warnings } = lookups.normalizeLookups(policyRaw.lookups.concat([
    { trigger: "two words", source: { kind: "csv", path: "x" }, template: "[[a]]" },
    { trigger: "/dup", source: { kind: "csv", path: "x", key: "k" }, template: "[[a]]" },
    { trigger: "/dup", source: { kind: "csv", path: "y", key: "k" }, template: "[[a]]" },
    { trigger: "/http", source: { kind: "json", url: "http://plain.example/x", key: "k" }, template: "[[a]]" },
    { trigger: "/nokey", source: { kind: "csv", path: "x" }, template: "[[a]]" },
    { trigger: "/nofield", source: { kind: "csv", path: "x", key: "k" }, template: "static text" },
    { trigger: "/xml", source: { kind: "xml", path: "x", key: "k" }, template: "[[a]]" },
    { trigger: "/nowhere", source: { kind: "csv", key: "k" }, template: "[[a]]" },
    null,
  ]));
  assert.deepEqual(ok.map((l) => l.trigger), ["/cust", "/ord", "/dup"]);
  assert.deepEqual(ok[0].fields, ["name", "id", "address"]);
  assert.equal(ok[0].source.refreshMinutes, 60);
  assert.equal(ok[1].source.refreshMinutes, 5);
  assert.equal(lookups.normalizeLookups([Object.assign({}, policyRaw.lookups[0], { source: Object.assign({}, policyRaw.lookups[0].source, { refreshMinutes: 2 }) })]).lookups[0].source.refreshMinutes, 60, "below the minimum falls back to the default");
  assert.equal(ok[1].source.location, "https://data.example/orders.json");
  assert.equal(warnings.length, 8);
  assert.ok(warnings.some((w) => /only https/.test(w)));
  const parsed = orgPolicy.parse(policyRaw);
  assert.equal(parsed.lookups.length, 2);
  assert.deepEqual(orgPolicy.merge([{ lookups: [policyRaw.lookups[0]] }, { lookups: [Object.assign({}, policyRaw.lookups[0], { label: "Team customer" })] }]).lookups.map((l) => l.label), ["Team customer"]);
});

test("findArgument applies the boundary rule and the argument limits", () => {
  const list = lookups.normalizeLookups(policyRaw.lookups).lookups;
  const hit = lookups.findArgument("see /cust 1001 ", list);
  assert.deepEqual([hit.lookup.trigger, hit.argument, hit.start, hit.typed], ["/cust", "1001", 4, "/cust 1001 "]);
  assert.equal(lookups.findArgument("/cust 1001 ", list).start, 0);
  assert.equal(lookups.findArgument("x/cust 1001 ", list), null, "letter before the trigger");
  assert.equal(lookups.findArgument("/cust 1001", list), null, "not complete until the space");
  assert.equal(lookups.findArgument("/cust ", list), null, "no argument");
  assert.equal(lookups.findArgument("/cust  1001 ", list), null, "double space is an empty argument");
  assert.equal(lookups.findArgument("/cust " + "9".repeat(65) + " ", list), null, "too long");
  assert.equal(lookups.findArgument("/customer 1001 ", list), null);
  assert.equal(lookups.findArgument("", list), null);
  assert.equal(lookups.findArgument("/cust 1 ", []), null);
});

function harness(options) {
  const served = Object.assign({ "S:/customers.csv": CSV, "https://data.example/orders.json": JSON.stringify([{ ref: "A-1", status: "shipped" }]) }, options && options.served);
  const cache = new Map();
  let clock = 1_000_000;
  const store = lookups.createLookupStore(Object.assign({
    lookups: lookups.normalizeLookups(policyRaw.lookups).lookups,
    cache: { load: (id) => cache.get(id) || null, save: (id, v) => cache.set(id, JSON.parse(JSON.stringify(v))) },
    now: () => clock,
    readFile: async (p) => { if (!(p in served)) throw new Error("ENOENT"); return served[p]; },
    fetch: async (url) => {
      if (!(url in served)) throw new Error("ECONNREFUSED");
      const body = served[url];
      if (typeof body === "object") return body;
      return { ok: true, status: 200, url, text: async () => body };
    },
  }, options && options.store));
  return { store, served, cache, tick: (ms) => { clock += ms; } };
}

test("the store fetches, indexes case-insensitively, caches, and keeps the last good copy", async () => {
  const h = harness();
  assert.deepEqual(h.store.loadCached().lookups.map((l) => l.status), ["pending", "pending"]);
  assert.deepEqual(h.store.due().map((l) => l.trigger), ["/cust", "/ord"]);
  const first = await h.store.refresh();
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(first.lookups.map((l) => [l.status, l.rows]), [["fresh", 3], ["fresh", 1]]);
  assert.equal(h.store.find("/cust", " 1003 ").name, "Spaced", "keys are trimmed on both sides");
  assert.equal(h.store.find("/ord", "a-1").status, "shipped", "case-insensitive");
  assert.equal(h.store.find("/cust", "9999"), null);
  assert.equal(h.store.find("/none", "1"), null);
  assert.deepEqual(h.store.due(), [], "just fetched");
  h.tick(5 * 60 * 1000 + 1);
  assert.deepEqual(h.store.due().map((l) => l.trigger), ["/ord"], "only the five-minute source is due");

  delete h.served["S:/customers.csv"];
  h.served["https://data.example/orders.json"] = { ok: false, status: 503, url: "https://data.example/orders.json" };
  const second = await h.store.refresh();
  assert.deepEqual(second.lookups.map((l) => l.status), ["cached", "cached"]);
  assert.equal(second.warnings.length, 2);
  assert.equal(h.store.find("/cust", "1001").name, "Acme, Ltd", "last good copy still answers");

  const fresh = harness({ served: { "S:/customers.csv": undefined } });
  delete fresh.served["S:/customers.csv"];
  const result = await fresh.store.refresh();
  assert.equal(result.lookups[0].status, "failed");
  assert.match(result.warnings[0], /no data yet/);
  // A new store on the same cache starts from the cached rows.
  const restarted = lookups.createLookupStore({ lookups: h.store.lookups, cache: { load: (id) => h.cache.get(id) || null, save: () => {} } });
  restarted.loadCached();
  assert.equal(restarted.find("/cust", "1002").name, 'Says "hi"');
});

test("size and row caps, https redirects and odd bodies fail per lookup", async () => {
  const big = harness({ store: { maxBytes: 50 } });
  const capped = await big.store.refresh();
  assert.match(capped.lookups[0].error, /larger than 50 bytes/);
  const headers = harness({ served: { "https://data.example/orders.json": { ok: true, status: 200, url: "https://data.example/orders.json", headers: { get: () => "99999999" }, text: async () => "[]" } } });
  assert.match((await headers.store.refresh()).lookups[1].error, /larger than/);
  const redirected = harness({ served: { "https://data.example/orders.json": { ok: true, status: 200, url: "http://data.example/orders.json", text: async () => "[]" } } });
  assert.match((await redirected.store.refresh()).lookups[1].error, /non-https/);
  const rows = harness({ store: { maxRows: 2 } });
  assert.match((await rows.store.refresh()).lookups[0].error, /more than 2 rows/);
  const junk = harness({ served: { "https://data.example/orders.json": "not json" } });
  assert.match((await junk.store.refresh()).lookups[1].error, /JSON/);
  const dir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-lookup-"));
  fs.writeFileSync(path.join(dir, "c.csv"), CSV);
  const real = lookups.createLookupStore({ lookups: lookups.normalizeLookups([{ trigger: "/c", source: { kind: "csv", path: path.join(dir, "c.csv"), key: "id" }, template: "[[name]]" }]).lookups });
  assert.equal((await real.refresh()).lookups[0].status, "fresh", "the default file reader works");
  assert.equal(real.find("/c", "1002").name, 'Says "hi"');
});

test("render fills the row's fields and then the built-in placeholders", () => {
  const list = lookups.normalizeLookups(policyRaw.lookups).lookups;
  const out = lookups.render(list[0], { id: "1001", name: "Acme", address: "Hull", extra: "ignored" }, new Date(2026, 9, 20));
  assert.equal(out.text, "Acme (1001)\nHull\nSeen 2026-10-20");
  assert.equal(lookups.render(list[0], { id: "7" }, new Date(2026, 9, 20)).text, "[[name]] (7)\n[[address]]\nSeen 2026-10-20", "missing fields stay visible");
});

test("a desk resolves hits and misses, counts a lookup insert, and lists it in the usage report", async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-lkdesk-"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(Object.assign({ organization: "Example" }, policyRaw)));
  const assistant = createAssistant({ dataDir, now: () => new Date(2026, 9, 20, 12).getTime(),
    readFile: async (p) => { if (p !== "S:/customers.csv") throw new Error("ENOENT"); return CSV; },
    fetch: async () => { throw new Error("offline"); } });
  const refreshed = await assistant.refreshLookups(true);
  assert.deepEqual(refreshed.lookups.map((l) => l.status), ["fresh", "failed"]);
  assert.ok(assistant.warnings().some((w) => /lookup \/ord: offline/.test(w)));
  assistant.focusChanged({ process: "outlook" });
  let actions = [];
  for (const ch of "Dear /cust 1001 ") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.equal(actions.length, 1);
  assert.deepEqual([actions[0].type, actions[0].argument, actions[0].backspaces, actions[0].typed], ["lookup", "1001", 11, "/cust 1001 "]);
  const resolved = assistant.resolveLookup(actions[0]);
  assert.equal(resolved.type, "expand");
  assert.equal(resolved.text, "Acme, Ltd (1001)\n12 Harbour Road\nHull\nSeen 2026-10-20");
  assert.equal(resolved.backspaces, 11);
  const entry = assistant.lookupInserted(resolved);
  assert.deepEqual([entry.kind, entry.trigger, entry.source, entry.keystrokesSaved], ["lookup", "/cust", "organization", resolved.text.length - 11]);
  const miss = assistant.resolveLookup({ trigger: "/cust", argument: "9999", typed: "/cust 9999 ", backspaces: 11 });
  assert.equal(miss.type, "lookup-miss");
  assert.match(miss.message, /No Customer found for "9999"/);
  assert.equal(assistant.ledger.size(), 1, "a miss counts nothing");
  const report = assistant.usageReport();
  assert.deepEqual(report.byShortcut.map((s) => [s.kind, s.trigger]), [["lookup", "/cust"]]);
  assert.equal(JSON.stringify(report).includes("Acme"), false, "no row data in the report");
  assert.equal(assistant.policyInfo().lookups[0].rows, 3);
  // Palette: "/cust 1002" resolves directly; "/cust" alone asks for a key.
  const found = assistant.paletteSearch("/cust 1002");
  assert.deepEqual([found[0].kind, found[0].argument, found[0].preview], ["lookup", "1002", "/cust 1002: Customer"]);
  const chosen = assistant.paletteChoose({ kind: "lookup", trigger: "/cust", argument: "1002", query: "/cust 1002" });
  assert.equal(chosen.type, "expand");
  assert.equal(chosen.spentKeystrokes, 11);
  assert.equal(assistant.paletteInserted(chosen).kind, "lookup");
  assert.equal(assistant.paletteChoose({ kind: "lookup", trigger: "/cust", query: "/cust" }).type, "lookup-needs-argument");
  assert.ok(assistant.paletteSearch("customer").some((i) => i.kind === "lookup" && i.preview === "/cust <id>: Customer"));
});
