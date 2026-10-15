const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("../src/premium-client.js");

const ready = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup({ enforced = false, handle = () => ({}), tabs } = {}) {
  const messages = [];
  const notices = [];
  const chrome = {
    runtime: {
      sendMessage(message) {
        messages.push(message);
        return Promise.resolve(handle(message)).then((result) => ({ ok: true, result }));
      },
    },
    tabs,
  };
  const client = createClient({ chrome, config: { enforceDailyLimit: enforced }, notice: (text) => notices.push(text) });
  return { client, chrome, messages, notices };
}

test("preview inserts synchronously, then counts only the insertion without sending field text", async () => {
  const pending = deferred();
  const { client, messages } = setup({ handle: () => pending.promise });
  let inserted = false;
  assert.equal(client.execute(() => { inserted = true; }, () => true), true);
  assert.equal(inserted, true);
  assert.deepEqual(messages, [{ type: "actle-premium", action: "record" }]);
  pending.resolve({ usedToday: 1 });
  await ready();
});

test("failed or stale preview insertions never consume an autocomplete", async () => {
  const { client, messages, notices } = setup();
  assert.equal(client.execute(() => assert.fail("stale action ran"), () => false), false);
  assert.equal(client.execute(() => false, () => true), false);
  assert.equal(client.execute(() => { throw new Error("editor disappeared"); }, () => true), false);
  assert.equal(client.execute(() => assert.fail("invalid action ran"), () => { throw new Error("selection unavailable"); }), false);
  await ready();
  assert.deepEqual(messages, []);
  assert.equal(notices.length, 4);
});

test("preview accounting failure leaves inserted text and reports unsaved usage", async () => {
  const { client, notices } = setup({ handle: () => Promise.reject(new Error("disk unavailable")) });
  let inserted = 0;
  assert.equal(client.execute(() => { inserted++; }, () => true), true);
  await ready();
  assert.equal(inserted, 1);
  assert.match(notices[0], /inserted.*usage.*saved/i);
  assert.equal(client.lastError(), notices[0]);
});

test("preview rejects asynchronous validators without inserting or leaking a rejection", async () => {
  for (const validate of [async () => true, async () => { throw new Error("read failed"); }]) {
    const { client, messages } = setup();
    assert.equal(client.execute(() => assert.fail("async preview validation inserted"), validate), false);
    await ready();
    assert.deepEqual(messages, []);
  }
});

test("enforcement waits for a reservation and rechecks the target before insertion", async () => {
  const pending = deferred();
  const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim" ? pending.promise : {} });
  let inserted = false;
  let valid = true;
  let validations = 0;
  const outcome = client.execute(() => { inserted = true; }, () => { validations++; return valid; });
  assert.equal(typeof outcome.then, "function");
  assert.equal(inserted, false);
  valid = false;
  pending.resolve({ approved: true, id: "receipt" });
  assert.equal(await outcome, false);
  assert.equal(inserted, false);
  assert.equal(validations, 2);
  assert.deepEqual(messages, [
    { type: "actle-premium", action: "claim" },
    { type: "actle-premium", action: "finish", id: "receipt", success: false },
  ]);
});

test("an approved successful insertion commits its receipt exactly once", async () => {
  const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim" ? { approved: true, id: "receipt" } : {} });
  let count = 0;
  assert.equal(await client.execute(() => { count++; return true; }, () => true), true);
  assert.equal(count, 1);
  assert.deepEqual(messages, [
    { type: "actle-premium", action: "claim" },
    { type: "actle-premium", action: "finish", id: "receipt", success: true },
  ]);
});

test("successful insertion returns while receipt cleanup is still pending", async () => {
  const pending = deferred();
  const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim"
    ? { approved: true, id: "receipt" } : pending.promise });
  const completed = await client.execute(() => true, () => true);
  assert.equal(completed, true);
  assert.equal(messages[1].action, "finish");
  pending.resolve({ finished: true });
  await ready();
});

test("false and throwing actions release an approved reservation", async () => {
  for (const action of [() => false, () => { throw new Error("editor error"); }]) {
    const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim" ? { approved: true, id: "receipt" } : {} });
    assert.equal(await client.execute(action, () => true), false);
    assert.deepEqual(messages[1], { type: "actle-premium", action: "finish", id: "receipt", success: false });
  }
});

test("a throwing post-reservation validation releases its reservation", async () => {
  const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim" ? { approved: true, id: "receipt" } : {} });
  let first = true;
  assert.equal(await client.execute(() => assert.fail("invalid target action ran"), () => {
    if (first) { first = false; return true; }
    throw new Error("detached");
  }), false);
  assert.equal(messages[1].success, false);
});

test("strict mode waits for an asynchronous settings check and refunds a now-disabled target", async () => {
  const validation = deferred();
  const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim" ? { approved: true, id: "receipt" } : {} });
  let validations = 0;
  let inserted = false;
  const result = client.execute(() => { inserted = true; }, async () => {
    validations++;
    return validations === 1 ? true : validation.promise;
  });
  await ready();
  assert.equal(validations, 2);
  assert.equal(inserted, false);
  assert.equal(messages.length, 1);
  validation.resolve(false);
  assert.equal(await result, false);
  assert.equal(inserted, false);
  assert.deepEqual(messages[1], { type: "actle-premium", action: "finish", id: "receipt", success: false });
});

test("a rejected post-reservation settings check releases its reservation", async () => {
  const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim" ? { approved: true, id: "receipt" } : {} });
  let first = true;
  assert.equal(await client.execute(() => assert.fail("rejected settings check inserted"), async () => {
    if (first) { first = false; return true; }
    throw new Error("settings unavailable");
  }), false);
  assert.equal(messages[1].success, false);
});

test("an invalid initial target never requests a reservation", async () => {
  const { client, messages } = setup({ enforced: true });
  assert.equal(await client.execute(() => assert.fail("action ran"), () => false), false);
  assert.deepEqual(messages, []);
});

test("quota denial preserves the trigger, reports the limit and never records an insertion", async () => {
  const { client, messages, notices } = setup({ enforced: true, handle: () => ({ approved: false, id: null, status: { dailyLimit: 100 } }) });
  assert.equal(await client.execute(() => assert.fail("denied action ran"), () => true), false);
  assert.deepEqual(messages, [{ type: "actle-premium", action: "claim" }]);
  assert.match(notices[0], /100/);
});

test("reservation transport and malformed response errors do not insert text", async () => {
  for (const handle of [() => Promise.reject(new Error("worker offline")), () => null, () => ({ approved: "yes" }), () => ({ approved: true })]) {
    const { client, notices } = setup({ enforced: true, handle });
    assert.equal(await client.execute(() => assert.fail("unapproved action ran"), () => true), false);
    assert.equal(notices.length, 1);
  }
});

test("a failed final save does not undo or refund an already successful insertion", async () => {
  const { client, messages, notices } = setup({ enforced: true, handle: (m) => m.action === "claim"
    ? { approved: true, id: "receipt" } : Promise.reject(new Error("storage full")) });
  let count = 0;
  assert.equal(await client.execute(() => { count++; }, () => true), true);
  await ready();
  assert.equal(count, 1);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].success, true);
  assert.match(notices[0], /inserted.*usage.*saved/i);
});

test("preview and forever approvals without receipts still record a completed insertion", async () => {
  const { client, messages } = setup({ enforced: true, handle: (m) => m.action === "claim" ? { approved: true, id: null } : {} });
  assert.equal(await client.execute(() => true, () => true), true);
  assert.deepEqual(messages, [
    { type: "actle-premium", action: "claim" },
    { type: "actle-premium", action: "record" },
  ]);
});

test("templates may surface insertion errors in their own form without a duplicate notice", async () => {
  const { client, notices } = setup({ enforced: true, handle: () => ({ approved: false, id: null, status: { dailyLimit: 100 } }) });
  assert.equal(await client.execute(() => assert.fail("denied"), () => true, { notice: false }), false);
  assert.equal(notices.length, 0);
  assert.match(client.lastError(), /100/);
});

test("successful template accounting failures remain visible after the form closes", async () => {
  const { client, notices } = setup({ handle: () => Promise.reject(new Error("storage unavailable")) });
  assert.equal(client.execute(() => true, () => true, { notice: false }), true);
  await ready();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /usage.*saved/i);
});

test("status and license actions use the background service and propagate its errors", async () => {
  const { client, chrome, messages } = setup({ handle: (m) => ({ action: m.action }) });
  assert.deepEqual(await client.status(), { action: "status" });
  assert.deepEqual(await client.activate("signed-license-placeholder"), { action: "activate" });
  assert.deepEqual(await client.deactivate(), { action: "deactivate" });
  assert.deepEqual(messages, [
    { type: "actle-premium", action: "status" },
    { type: "actle-premium", action: "activate", token: "signed-license-placeholder" },
    { type: "actle-premium", action: "deactivate" },
  ]);
  chrome.runtime.sendMessage = async () => ({ ok: false, error: "Invalid license" });
  await assert.rejects(client.activate("invalid"), /Invalid license/);
  chrome.runtime.sendMessage = async () => undefined;
  await assert.rejects(client.status(), /response/i);
});

test("checkout opens only the current configured credential-free HTTPS address", async () => {
  const opened = [];
  const status = { checkout: { available: true, url: "https://checkout.example.test/actle?plan=forever" } };
  const { client } = setup({ handle: () => status, tabs: { create: async (tab) => opened.push(tab) } });
  await client.openCheckout();
  assert.deepEqual(opened, [{ url: status.checkout.url }]);
  for (const url of ["http://checkout.example.test", "javascript:alert(1)", "https://user:secret@checkout.example.test", "not a URL"]) {
    status.checkout.url = url;
    await assert.rejects(client.openCheckout(), /checkout/i);
  }
  status.checkout = { available: false, url: "https://checkout.example.test" };
  await assert.rejects(client.openCheckout(), /not available/i);
  assert.equal(opened.length, 1);
});

test("checkout cannot claim to open when extension tab access fails", async () => {
  const response = { checkout: { available: true, url: "https://checkout.example.test" } };
  const unavailable = setup({ handle: () => response });
  await assert.rejects(unavailable.client.openCheckout(), /extension/i);
  const failed = setup({ handle: () => response, tabs: { create: async () => { throw new Error("tabs failed"); } } });
  await assert.rejects(failed.client.openCheckout(), /tabs failed/);
});
