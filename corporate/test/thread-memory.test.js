const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSubject, threadKey, createThreadMemory, MAIL_APPS } = require("../core/thread-memory.js");
const { template } = require("../core/personal.js");

const DAY = 86400000;
const outlook = (title) => ({ process: "OUTLOOK.EXE", title });

test("window titles normalise to one subject per conversation", () => {
  const cases = [
    ["RE: Order 1234 - Message (HTML)", "order 1234"],
    ["Re: Order 1234 - Message (Plain Text)", "order 1234"],
    ["FW: RE[2]: AW: Order 1234 - Outlook", "order 1234"],
    ["Fwd: WG: SV: Order 1234 – Microsoft Outlook", "order 1234"],
    ["RE(3): Order 1234", "order 1234"],
    ["Order 1234 - jo@x.com - Gmail - Google Chrome", "order 1234"],
    ["Order 1234 - jo@x.com - Gmail - Mozilla Firefox", "order 1234"],
    ["Re: Order 1234 - jo@x.com - Outlook - Microsoft Edge", "order 1234"],
    ["Order 1234 - Gmail - Google Chrome and 3 more pages - Profile 1", "order 1234"],
    ["Write: Re: Order 1234 - Mozilla Thunderbird", "order 1234"],
    ["(2) Order 1234 - Gmail", "order 1234"],
    ["  Order   1234  ", "order 1234"],
    ["Order 1234", "order 1234"],
    ["Café order - Mail", "café order"],
  ];
  for (const [title, subject] of cases) assert.equal(normalizeSubject(title), subject, title);
  // Folders and views are not conversations.
  for (const title of ["Inbox - jo@x.com - Outlook", "Inbox (3) - jo@gmail.com - Gmail - Mozilla Firefox", "Sent Items - Outlook", "Drafts", "Posteingang - Outlook", "(No subject) - Gmail", "ab", "", "Calendar - jo@x.com - Outlook"]) {
    assert.equal(normalizeSubject(title), "", JSON.stringify(title));
  }
  assert.equal(normalizeSubject("Order 4111 1111 1111 1111 - Outlook"), "order [card]", "a card number in a subject is masked, deterministically");
});

test("a conversation is recognised only in a mail window with a real subject", () => {
  const key = threadKey(outlook("RE: Order 1234 - Message (HTML)"));
  assert.deepEqual([key.app, key.subject], ["outlook", "order 1234"]);
  assert.match(key.id, /^[0-9a-f]{16}$/);
  assert.equal(threadKey(outlook("FW: Re: order 1234 - Outlook")).id, key.id, "the same conversation yields the same id");
  assert.notEqual(threadKey({ process: "thunderbird", title: "Re: Order 1234 - Mozilla Thunderbird" }).id, key.id, "another mail app is another conversation");
  assert.equal(threadKey({ process: "chrome.exe", title: "Order 1234 - jo@x.com - Gmail - Google Chrome" }).app, "gmail");
  assert.equal(threadKey({ process: "msedge.exe", title: "Re: Order 1234 - Outlook - Microsoft Edge" }).app, "outlook-web");
  assert.equal(threadKey({ bundleId: "com.apple.mail", title: "Re: Order 1234" }).app, "apple-mail");
  assert.equal(threadKey({ process: "notepad.exe", title: "Order 1234" }), null, "not a mail application");
  assert.equal(threadKey({ process: "ms-teams.exe", title: "Order 1234 | Microsoft Teams" }), null);
  assert.equal(threadKey(outlook("Inbox - jo@x.com - Outlook")), null, "a folder is not a conversation");
  assert.equal(threadKey(outlook("")), null, "no title (macOS without Accessibility, Wayland)");
  assert.equal(threadKey({ process: "", title: "" }), null);
  assert.equal(threadKey(outlook("Password reset for order 1234 - Message (HTML)")), null, "sensitive titles are never a conversation");
  assert.equal(threadKey(Object.assign(outlook("Re: Order 1234"), { ownWindow: true })), null, "actle's own windows never are");
  assert.equal(threadKey(Object.assign(outlook("Re: Order 1234"), { secureInput: true })), null);
  assert.ok(MAIL_APPS.every((rule) => rule.id && Array.isArray(rule.processes)));
});

function memory(extra) {
  let saved = null;
  let saves = 0;
  const state = { now: 1_700_000_000_000 };
  const mem = createThreadMemory(Object.assign({
    load: () => (saved ? JSON.parse(saved) : []),
    save: (records) => { saved = JSON.stringify(records); saves++; return true; },
    now: () => state.now,
    presets: template.pronounPresets,
  }, extra || {}));
  return { mem, state, saved: () => saved, saves: () => saves };
}

test("answers are remembered per conversation, offered for the same blank names, and only when they are safe to offer back", () => {
  const { mem, state, saved } = memory();
  const order = threadKey(outlook("RE: Order 1234 - Message (HTML)"));
  const other = threadKey(outlook("RE: Order 9999 - Message (HTML)"));
  assert.deepEqual(Object.keys(mem.defaults(order, ["name"]).values), []);
  assert.equal(mem.remember(order, { name: "Jo Bloggs", date: " 3 May ", ignored: "x" }, ["name", "date"], "she/her"), 2, "only the template's own fields count");
  assert.deepEqual(mem.defaults(order, ["name", "date", "amount"]), { values: Object.assign(Object.create(null), { name: "Jo Bloggs", date: "3 May" }), pronouns: "she/her", updatedAt: state.now });
  assert.deepEqual(mem.defaults(threadKey(outlook("FW: Re: order 1234 - Outlook")), ["name"]).values, Object.assign(Object.create(null), { name: "Jo Bloggs" }), "the same conversation under a forward prefix");
  assert.deepEqual(Object.keys(mem.defaults(other, ["name"]).values), [], "another conversation gets nothing");
  assert.deepEqual(Object.keys(mem.defaults(null, ["name"]).values), []);
  assert.equal(mem.remember(null, { name: "x" }, ["name"]), 0);
  // A later answer replaces the earlier one.
  state.now += 1000;
  mem.remember(order, { name: "Jo B." }, ["name"]);
  assert.equal(mem.defaults(order, ["name"]).values.name, "Jo B.");
  assert.equal(mem.list()[0].answers.length, 2);
  // Never stored: secrets by name, values scrubbing would change, empty or oversized values, unknown presets.
  assert.equal(mem.remember(order, { PIN: "1234", password: "x", "API key": "k", "Card number": "4111 1111 1111 1111", note: "password: hunter2", long: "x".repeat(501), blank: "   ", ok: "fine" }, ["PIN", "password", "API key", "Card number", "note", "long", "blank", "ok"], "xe/xem"), 1);
  assert.deepEqual(mem.list()[0].answers.map((a) => a.name).sort(), ["date", "name", "ok"], "nothing secret, masked, empty or oversized was kept");
  const stored = JSON.stringify(mem.list());
  for (const secret of ["hunter2", "4111", "xe/xem", "x".repeat(501)]) assert.equal(stored.includes(secret), false, secret.slice(0, 12));
  assert.equal(mem.list()[0].pronouns, "she/her", "an unknown preset leaves the remembered one");
  assert.equal(mem.defaults(order, ["ok"]).values.ok, "fine");
  // Blank names that are object keys do not break anything.
  mem.remember(order, { __proto__: "p", constructor: "c" }, ["__proto__", "constructor"]);
  assert.deepEqual(Object.assign({}, mem.defaults(order, ["__proto__", "constructor"]).values), { __proto__: "p", constructor: "c" });
  assert.ok(saved().includes("Jo B."), "the store receives the records (the store seals them)");
  // Forget one, forget all.
  assert.equal(mem.remember(other, { name: "Sam" }, ["name"]), 1);
  assert.equal(mem.list().length, 2);
  assert.equal(mem.forget(mem.list().find((t) => t.subject === "order 9999").id), 1);
  assert.equal(mem.forget("nope"), 0);
  assert.equal(mem.list().length, 1);
  assert.equal(mem.clear(), 1);
  assert.deepEqual(mem.list(), []);
  assert.deepEqual(JSON.parse(saved()), []);
});

test("remembered answers expire with the retention and the caps keep the newest", () => {
  const { mem, state } = memory({ retentionDays: 90, maxThreads: 3, maxAnswersPerThread: 2 });
  const order = threadKey(outlook("Order 1 - Outlook"));
  mem.remember(order, { a: "1" }, ["a"]);
  state.now += 91 * DAY;
  assert.deepEqual(Object.keys(mem.defaults(order, ["a"]).values), [], "an expired record is not offered even before pruning runs");
  assert.deepEqual(mem.list(), []);
  assert.equal(mem.prune(), 1);
  for (let i = 0; i < 4; i++) {
    state.now += 1000;
    mem.remember(threadKey(outlook("Order " + (10 + i) + " - Outlook")), { a: "v" + i, b: "w" + i, c: "x" + i }, ["a", "b", "c"]);
  }
  assert.deepEqual(mem.list().map((t) => t.subject), ["order 13", "order 12", "order 11"], "the oldest conversation beyond the cap is gone");
  assert.deepEqual(mem.list()[0].answers.map((x) => x.name), ["b", "c"], "the oldest answers beyond the cap are gone");
  const again = createThreadMemory({ load: () => [{ app: "outlook", subject: "old", answers: [{ name: "a", value: "1", at: 1 }], updatedAt: 1 }, { app: "outlook", subject: "new", answers: [{ name: "a", value: "2", at: state.now }], updatedAt: state.now }, "junk", { nope: true }], save: () => true, now: () => state.now });
  assert.equal(again.size(), 2, "unreadable records are dropped on load");
  assert.equal(again.prune(), 1);
  assert.deepEqual(again.list().map((t) => t.subject), ["new"]);
});

test("without a store that can write, answers live for this run only", () => {
  const mem = createThreadMemory({ load: () => [], save: () => false, now: () => 1 });
  const order = threadKey(outlook("Order 1 - Outlook"));
  assert.equal(mem.remember(order, { a: "1" }, ["a"]), 1);
  assert.equal(mem.defaults(order, ["a"]).values.a, "1");
});
