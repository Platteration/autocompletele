// The desktop assistant is plain Node (main.js adds Electron around it), so
// its policy handling is tested here end to end with a temp data folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const signing = require("../core/policy-signing.js");
const { createAssistant } = require("../desktop/assistant.js");

const pair = signing.generateKeyPair();
const ORG = "https://intranet.example/org.signed.json";
const TEAM = "S:/IT/shipping.signed.json";

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-assistant-"));
}

function managedDesk(served, extra) {
  let clock = 1_000_000;
  const dataDir = temp();
  const assistant = createAssistant(Object.assign({
    dataDir,
    now: () => clock,
    deployment: { policySources: [{ label: "Organisation", url: ORG }, { label: "Shipping", path: TEAM }], publicKeys: [pair.publicKey] },
    fetch: async (url) => (url in served ? { ok: true, status: 200, text: async () => served[url] } : Promise.reject(new Error("offline"))),
    readFile: async (p) => (p in served ? served[p] : Promise.reject(new Error("ENOENT"))),
  }, extra));
  return { assistant, dataDir, tick: (ms) => { clock += ms; } };
}

const signed = (policy) => JSON.stringify(signing.signPolicy(policy, pair.privateKey));

test("a managed desk applies the signed layers, records the change and keeps working offline", async () => {
  const served = {
    [ORG]: signed({ serial: 1, organization: "Example Ltd", library: [{ trigger: "sig/", expansion: "Org sig" }] }),
    [TEAM]: signed({ serial: 1, library: [{ trigger: "sld/", expansion: "Shipping desk" }] }),
  };
  const { assistant, dataDir } = managedDesk(served);
  assert.equal(assistant.managed, true);
  assert.equal(assistant.policyInfo().organization, "", "nothing fetched yet");
  const result = await assistant.refreshPolicy();
  assert.deepEqual(result.sources.map((s) => s.status), ["fresh", "fresh"]);
  const info = assistant.policyInfo();
  assert.equal(info.organization, "Example Ltd");
  assert.equal(info.managed, true);
  assert.equal(info.refreshMinutes, 60);
  assert.deepEqual(info.organizationLibrary.map((s) => s.trigger).sort(), ["sig/", "sld/"]);
  assistant.focusChanged({ process: "notepad" });
  let actions = [];
  for (const ch of "sld/") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.equal(actions[0].text, "Shipping desk");

  const events = assistant.audit().map((e) => e.event);
  assert.ok(events.includes("policy-applied"));
  const applied = assistant.audit().filter((e) => e.event === "policy-applied").pop();
  assert.equal(applied.origin, "refresh");
  assert.deepEqual(applied.sources.map((s) => s.serial), [1, 1]);
  assert.equal(JSON.stringify(assistant.audit()).includes("Shipping desk"), false, "the audit log never holds shortcut text");

  // Restart offline: the last good copies apply immediately.
  const restarted = createAssistant({
    dataDir,
    deployment: { policySources: [{ label: "Organisation", url: ORG }, { label: "Shipping", path: TEAM }], publicKeys: [pair.publicKey] },
    fetch: async () => { throw new Error("offline"); },
    readFile: async () => { throw new Error("offline"); },
  });
  assert.equal(restarted.policyInfo().organization, "Example Ltd");
  const offline = await restarted.refreshPolicy();
  assert.deepEqual(offline.sources.map((s) => s.status), ["cached", "cached"]);
  assert.ok(restarted.warnings().some((w) => /using the last good copy/.test(w)));
  const problems = restarted.audit().filter((e) => e.event === "policy-source-problem");
  assert.equal(problems.length, 2);
  await restarted.refreshPolicy();
  assert.equal(restarted.audit().filter((e) => e.event === "policy-source-problem").length, 2, "a persisting problem is logged once");
});

test("the organisation kill switch pauses the desk and the person cannot resume it", async () => {
  const served = {
    [ORG]: signed({ serial: 1, library: [{ trigger: "sig/", expansion: "Org sig" }] }),
    [TEAM]: signed({ serial: 1 }),
  };
  const { assistant } = managedDesk(served);
  await assistant.refreshPolicy();
  assert.equal(assistant.paused, false);
  served[ORG] = signed({ serial: 2, paused: { message: "Paused while IT reviews the rollout" }, library: [{ trigger: "sig/", expansion: "Org sig" }] });
  await assistant.refreshPolicy();
  assert.equal(assistant.paused, true);
  assert.equal(assistant.policyInfo().paused.message, "Paused while IT reviews the rollout");
  assistant.setEnabled(true);
  assistant.focusChanged({ process: "notepad" });
  let actions = [];
  for (const ch of "sig/") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.deepEqual(actions, []);
  const applied = assistant.audit().filter((e) => e.event === "policy-applied");
  assert.equal(applied.pop().paused, true);
  served[ORG] = signed({ serial: 3, library: [{ trigger: "sig/", expansion: "Org sig" }] });
  await assistant.refreshPolicy();
  assert.equal(assistant.paused, false);
  assistant.focusChanged({ process: "notepad" });
  for (const ch of "sig/") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.equal(actions[0].text, "Org sig");
});

test("on a managed desk an unsigned local policy file is ignored with a warning", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ capture: { defaultMode: "learn" } }), "utf8");
  fs.writeFileSync(path.join(dataDir, "deployment.json"), JSON.stringify({ policySources: [{ url: ORG }], publicKeys: [pair.publicKey] }), "utf8");
  const assistant = createAssistant({ dataDir, fetch: async () => { throw new Error("offline"); } });
  assert.equal(assistant.managed, true);
  assert.equal(assistant.policyInfo().capture.defaultMode, "triggers");
  assert.ok(assistant.warnings().some((w) => /local policy file is ignored/.test(w)));
});

test("an unmanaged desk keeps using its local policy and cannot refresh", async () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ organization: "Local" }), "utf8");
  const assistant = createAssistant({ dataDir });
  assert.equal(assistant.managed, false);
  assert.equal(assistant.policyInfo().organization, "Local");
  assert.deepEqual(await assistant.refreshPolicy(), { ok: false, managed: false, sources: [], warnings: [] });
});

test("changing one's own capture rules is recorded in the audit log", () => {
  const assistant = createAssistant({ dataDir: temp() });
  assistant.saveSettings({ charsPerMinute: 220 });
  assert.equal(assistant.audit().filter((e) => e.event === "capture-rules-changed").length, 0);
  assistant.saveSettings({ captureApps: [{ label: "Slack", mode: "learn", match: { process: "slack" } }] });
  const changes = assistant.audit().filter((e) => e.event === "capture-rules-changed");
  assert.equal(changes.length, 1);
  assert.equal(changes[0].by, "person");
  assert.deepEqual(changes[0].rules, [{ label: "Slack", mode: "learn", match: { process: "slack" } }]);
});

test("the usage report uses the policy's reporting settings and a stable desk id", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({
    organization: "Example", library: [{ trigger: "sig/", expansion: "Kind regards" }],
    reporting: { team: "Shipping", hourlyRate: 42, currency: "EUR", period: "month", periods: 3 },
  }), "utf8");
  const assistant = createAssistant({ dataDir, now: () => new Date(2026, 9, 20, 12).getTime() });
  assistant.saveShorthand({ trigger: "secret/", expansion: "my private text" });
  assistant.focusChanged({ process: "notepad" });
  for (const ch of "sig/ secret/ ") assistant.keyTyped({ text: ch });
  const first = assistant.usageReport();
  assert.equal(first.team, "Shipping");
  assert.equal(first.period, "month");
  assert.equal(first.series.length, 3);
  assert.match(first.installId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first.byShortcut.map((s) => s.trigger), ["sig/"]);
  assert.equal(first.personal.inserts, 1);
  assert.equal(JSON.stringify(first).includes("secret"), false);
  assert.equal(assistant.usageReport().installId, first.installId, "the desk id is kept");
});
