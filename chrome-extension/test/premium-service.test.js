const test = require("node:test");
const assert = require("node:assert/strict");
const { create, STORAGE_KEY } = require("../src/premium-service.js");

function fixture(overrides = {}) {
  let currentTime = new Date(2026, 9, 13, 12);
  let data = {};
  let sequence = 0;
  let writeError = false;
  let readError = false;
  let listener;
  const calls = { writes: 0, verifications: 0, options: 0 };
  const config = { dailyLimit: 100, enforceDailyLimit: true, checkoutUrl: "https://example.test/coffee", priceLabel: "$5 once", publicKeyJwk: { fixture: true }, ...overrides };
  const chrome = {
    runtime: { id: "actle-test", getURL: (path) => `chrome-extension://actle-test/${path}`, openOptionsPage: async () => { calls.options++; }, onMessage: { addListener: (fn) => { listener = fn; } } },
    storage: { local: {
      get: async (key) => { assert.equal(key, STORAGE_KEY); if (readError) throw new Error("read"); return structuredClone(data); },
      set: async (value) => { calls.writes++; if (writeError) throw new Error("write"); data = { ...data, ...structuredClone(value) }; },
    } },
  };
  const license = {
    isConfigured: async (key) => key?.fixture === true,
    verify: async (token, key) => { calls.verifications++; return token.trim() === "valid-token" && key?.fixture === true ? { valid: true, token: "valid-token", license: { plan: "forever" } } : { valid: false, reason: "invalid-signature" }; },
  };
  const args = { chrome, config, license, now: () => new Date(currentTime), randomId: () => `receipt-${String(++sequence).padStart(16, "0")}` };
  let service = create(args);
  const sender = { id: chrome.runtime.id, tab: { id: 1 }, frameId: 0, documentId: "first-document", url: "https://example.test/page" };
  const page = { id: chrome.runtime.id, url: chrome.runtime.getURL("src/options.html") };
  return {
    calls, config, sender, page,
    send: (action, fields = {}, from = sender) => service.handle({ type: "actle-premium", action, ...fields }, from),
    state: () => structuredClone(data[STORAGE_KEY]),
    seed: (state) => { data[STORAGE_KEY] = structuredClone(state); },
    time: (value) => { currentTime = value; },
    failWrite: (value) => { writeError = value; },
    failRead: (value) => { readError = value; },
    restart: () => { service = create(args); },
    install: () => { service.install(); return listener; },
  };
}

test("preview remains unlimited while counting successful local insertions", async () => {
  const f = fixture({ enforceDailyLimit: false, checkoutUrl: "", publicKeyJwk: null });
  for (let n = 0; n < 105; n++) assert.equal((await f.send("record")).ok, true);
  const { result } = await f.send("status");
  assert.equal(result.usedToday, 105);
  assert.equal(result.dailyLimit, 100);
  assert.equal(result.enforced, false);
  assert.equal(result.tier, "free");
  assert.deepEqual(result.checkout, { available: false, url: "", price: "$5 once" });
  assert.equal(result.activationAvailable, false);
  assert.deepEqual((await f.send("claim")).result, { approved: true, id: null, status: result });
  assert.deepEqual(Object.keys(f.state()).sort(), ["day", "licenseToken", "pending", "used", "version"]);
  assert.equal(JSON.stringify(f.state()).includes("example.test"), false);
});

test("parallel requests share one durable 100-insertion allowance", async () => {
  const f = fixture();
  const replies = await Promise.all(Array.from({ length: 110 }, () => f.send("claim")));
  assert.equal(replies.filter((r) => r.ok && r.result.approved).length, 100);
  assert.equal(replies.filter((r) => r.ok && !r.result.approved).length, 10);
  assert.equal(new Set(replies.filter((r) => r.result.id).map((r) => r.result.id)).size, 100);
  assert.equal(f.state().used, 100);
  assert.equal(Object.keys(f.state().pending).length, 100);
  assert.equal((await f.send("record")).ok, false, "strict free cannot use post-insertion accounting");
});

test("receipts bind to browser sender, finish once, and refund only failed insertion", async () => {
  const f = fixture({ dailyLimit: 2 });
  const first = (await f.send("claim")).result;
  const other = { ...f.sender, tab: { id: 2 } };
  const changedDocument = { ...f.sender, documentId: "replacement-document" };
  const changedFrame = { ...f.sender, frameId: 3 };
  for (const sender of [other, changedDocument, changedFrame]) {
    assert.equal((await f.send("finish", { id: first.id, success: false }, sender)).result.finished, false);
  }
  assert.equal(f.state().used, 1);
  assert.equal((await f.send("finish", { id: first.id, success: false })).result.finished, true);
  assert.equal(f.state().used, 0);
  assert.equal((await f.send("finish", { id: first.id, success: false })).result.finished, false);
  const second = (await f.send("claim")).result;
  assert.equal((await f.send("finish", { id: second.id, success: true })).result.finished, true);
  assert.equal(f.state().used, 1);
  assert.equal((await f.send("finish", { id: second.id, success: false })).result.finished, false);
  assert.deepEqual(f.state().pending, {});
});

test("unfinished approvals remain charged across background restarts and reset at local midnight", async () => {
  const f = fixture({ dailyLimit: 1 });
  const { id } = (await f.send("claim")).result;
  f.restart();
  assert.equal((await f.send("claim")).result.approved, false);
  const reset = (await f.send("status")).result.resetsAt;
  assert.equal(reset, new Date(2026, 9, 14).toISOString());
  f.time(new Date(2026, 9, 14, 0, 1));
  assert.equal((await f.send("status")).result.usedToday, 0);
  const next = (await f.send("claim")).result;
  assert.equal(next.approved, true);
  assert.equal((await f.send("finish", { id, success: false })).result.finished, false);
  assert.equal(f.state().used, 1, "yesterday's receipt cannot refund today's use");
  assert.equal(f.state().day, "2026-10-14");
});

test("unsafe or unconfigured checkout and verification keep enforcement inactive", async () => {
  for (const config of [
    { checkoutUrl: "http://example.test/pay" }, { checkoutUrl: "https://user:secret@example.test/pay" },
    { checkoutUrl: "javascript:alert(1)" }, { checkoutUrl: "" }, { publicKeyJwk: null },
    { publicKeyJwk: { invalid: true } },
  ]) {
    const f = fixture(config);
    const { result } = await f.send("status");
    assert.equal(result.enforced, false);
    assert.equal(result.checkout.available, false, "checkout is unavailable until its licenses can activate");
    assert.equal(result.checkout.url, "");
    assert.equal((await f.send("claim")).result.id, null);
  }
});

test("only extension pages activate or remove a verified perpetual token", async () => {
  const f = fixture();
  assert.equal((await f.send("activate", { token: "valid-token" })).ok, false);
  assert.equal((await f.send("activate", { token: "invalid" }, f.page)).ok, false);
  assert.equal((await f.send("activate", { token: " valid-token " }, { ...f.page, url: "chrome-extension://actle-test.evil/src/options.html" })).ok, false);
  const activated = await f.send("activate", { token: " valid-token " }, f.page);
  assert.equal(activated.result.tier, "forever");
  assert.equal(f.state().licenseToken, "valid-token");
  const before = f.calls.verifications;
  assert.equal((await f.send("status")).result.tier, "forever");
  assert.equal(f.calls.verifications, before + 1, "stored license is verified afresh");
  assert.equal((await f.send("claim")).result.id, null);
  assert.equal((await f.send("record")).result.usedToday, 1);
  assert.equal((await f.send("deactivate")).ok, false);
  assert.equal((await f.send("deactivate", {}, f.page)).result.tier, "free");
  assert.equal(f.state().licenseToken, "");
  assert.equal(f.state().used, 1, "removing a license does not clear usage");
});

test("paid flags and invalid stored tokens never unlock forever", async () => {
  const f = fixture();
  await f.send("claim");
  f.seed({ ...f.state(), paid: true, tier: "forever", licenseToken: "forged-token" });
  assert.equal((await f.send("status")).result.tier, "free");
  assert.equal((await f.send("status")).result.enforced, true);
  f.config.publicKeyJwk = null;
  assert.equal((await f.send("activate", { token: "valid-token" }, f.page)).ok, false);
});

test("malformed messages and foreign senders cannot choose dates, counters, or recipients", async () => {
  const f = fixture();
  for (const [action, fields] of [
    ["missing", {}], ["claim", { day: "2099-01-01" }], ["record", { amount: -1 }],
    ["status", { text: "private message" }], ["finish", { id: "short", success: true }],
    ["finish", { id: "receipt-1234567890123456", success: "yes" }], ["activate", { token: "x".repeat(9000) }],
  ]) assert.equal((await f.send(action, fields)).ok, false);
  for (const sender of [{ ...f.sender, id: "other-extension" }, {}, null]) {
    assert.equal((await f.send("claim", {}, sender)).ok, false);
  }
  assert.equal(f.calls.writes, 0);
});

test("storage errors are visible, fail closed, and do not poison the serial queue", async () => {
  const f = fixture({ dailyLimit: 1 });
  f.failWrite(true);
  const failed = await f.send("claim");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /save/i);
  assert.equal(f.state(), undefined);
  f.failWrite(false);
  const { id } = (await f.send("claim")).result;
  f.failWrite(true);
  assert.equal((await f.send("finish", { id, success: false })).ok, false);
  assert.equal(f.state().used, 1);
  f.failWrite(false);
  assert.equal((await f.send("finish", { id, success: false })).result.finished, true);
  f.failRead(true);
  assert.match((await f.send("status")).error, /read/i);
  f.failRead(false);
  assert.equal((await f.send("claim")).result.approved, true);
});

test("invalid stored accounting data fails visibly rather than silently resetting usage", async () => {
  const f = fixture();
  for (const state of [
    { version: 1, day: "2026-10-13", used: -1, pending: {}, licenseToken: "" },
    { version: 1, day: "2026-10-13", used: 0, pending: { "receipt-1234567890123456": "tab:1" }, licenseToken: "" },
    { version: 1, day: "2026-10-13", used: 101, pending: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`receipt-${String(i).padStart(16, "0")}`, "tab:1"])), licenseToken: "" },
  ]) {
    f.seed(state);
    assert.equal((await f.send("claim")).ok, false);
    assert.deepEqual(f.state(), state);
  }
});

test("runtime listener responds asynchronously only to its namespace", async () => {
  const f = fixture();
  const listener = f.install();
  assert.equal(listener({ type: "another-feature" }, f.sender, () => assert.fail("unexpected response")), false);
  const reply = await new Promise((resolve) => {
    assert.equal(listener({ type: "actle-premium", action: "status" }, f.sender, resolve), true);
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.usedToday, 0);
});

test("the notice opens only the extension options, even when accounting is unavailable", async () => {
  const f = fixture();
  f.failRead(true);
  assert.deepEqual(await f.send("openOptions"), { ok: true, result: { opened: true } });
  assert.equal(f.calls.options, 1);
  assert.equal((await f.send("openOptions", { url: "https://another.test/" })).ok, false);
  assert.equal((await f.send("openOptions", {}, { ...f.sender, id: "other-extension" })).ok, false);
  assert.equal(f.calls.options, 1);
  assert.equal(f.calls.writes, 0);
});
