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
    deployment: { policySources: [{ layer: "org", label: "Organisation", url: ORG }, { layer: "team", label: "Shipping", path: TEAM }], publicKeys: [pair.publicKey] },
    fetch: async (url) => (url in served ? { ok: true, status: 200, text: async () => served[url] } : Promise.reject(new Error("offline"))),
    readFile: async (p) => (p in served ? served[p] : Promise.reject(new Error("ENOENT"))),
  }, extra));
  return { assistant, dataDir, tick: (ms) => { clock += ms; } };
}

const signed = (policy) => JSON.stringify(signing.signPolicy(policy, pair.privateKey));

test("a managed desk applies the signed layers, records the change and keeps working offline", async () => {
  const served = {
    [ORG]: signed({ layer: "org", serial: 1, organization: "Example Ltd", library: [{ trigger: "sig/", expansion: "Org sig" }] }),
    [TEAM]: signed({ layer: "team", serial: 1, library: [{ trigger: "sld/", expansion: "Shipping desk" }] }),
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
    deployment: { policySources: [{ layer: "org", label: "Organisation", url: ORG }, { layer: "team", label: "Shipping", path: TEAM }], publicKeys: [pair.publicKey] },
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
    [ORG]: signed({ layer: "org", serial: 1, library: [{ trigger: "sig/", expansion: "Org sig" }] }),
    [TEAM]: signed({ layer: "team", serial: 1 }),
  };
  const { assistant } = managedDesk(served);
  await assistant.refreshPolicy();
  assert.equal(assistant.paused, false);
  served[ORG] = signed({ layer: "org", serial: 2, paused: { message: "Paused while IT reviews the rollout" }, library: [{ trigger: "sig/", expansion: "Org sig" }] });
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
  served[ORG] = signed({ layer: "org", serial: 3, library: [{ trigger: "sig/", expansion: "Org sig" }] });
  await assistant.refreshPolicy();
  assert.equal(assistant.paused, false);
  assistant.focusChanged({ process: "notepad" });
  for (const ch of "sig/") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.equal(actions[0].text, "Org sig");
});

test("on a managed desk an unsigned local policy file is ignored with a warning", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ capture: { defaultMode: "learn" } }), "utf8");
  fs.writeFileSync(path.join(dataDir, "deployment.json"), JSON.stringify({ policySources: [{ layer: "org", url: ORG }], publicKeys: [pair.publicKey] }), "utf8");
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

test("a policy refresh keeps the learning session and field state of the field being typed in", async () => {
  const keychain = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from("K" + t), decryptString: (b) => Buffer.from(b).toString().slice(1) };
  const served = {
    [ORG]: signed({ layer: "org", serial: 1, capture: { defaultMode: "learn" }, keywordRules: [{ id: "d", action: "warn", keywords: ["contract"], unless: ["CONFIDENTIAL"], message: "Add it." }] }),
    [TEAM]: signed({ layer: "team", serial: 1 }),
  };
  const { assistant } = managedDesk(served, { keychain });
  await assistant.refreshPolicy();
  assistant.focusChanged({ process: "outlook" });
  for (const ch of "CONFIDENTIAL. This message has more than twenty characters in it ") assistant.keyTyped({ text: ch });
  served[ORG] = signed({ layer: "org", serial: 2, organization: "Changed", capture: { defaultMode: "learn" }, keywordRules: [{ id: "d", action: "warn", keywords: ["contract"], unless: ["CONFIDENTIAL"], message: "Add it." }] });
  await assistant.refreshPolicy();
  assert.equal(assistant.policyInfo().organization, "Changed");
  assert.match(assistant.engine.session.text, /^CONFIDENTIAL\. This message/, "the session survived the refresh");
  let actions = [];
  for (const ch of "about the contract ") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.deepEqual(actions, [], "the disclaimer typed before the refresh still counts");

  // A policy that stops learning in this application stores the session instead of dropping it.
  served[ORG] = signed({ layer: "org", serial: 3, capture: { defaultMode: "triggers" } });
  await assistant.refreshPolicy();
  assert.equal(assistant.engine.session, null);
  assert.equal(assistant.corpusInfo().sessions, 1);
});

test("the testing tier override lowers an unenforced desk live and is only honoured downwards once enforced", async () => {
  const license = require("../core/license.js");
  const vendor = signing.generateKeyPair();
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({
    organization: "Example Ltd",
    capture: { defaultMode: "learn" },
    library: [{ trigger: "sig/", expansion: "Kind regards" }],
    keywordRules: [{ id: "r", keywords: ["refund"], insert: "Policy text" }],
    lookups: [{ trigger: "/cust", label: "Customer", source: { kind: "csv", path: "S:/x.csv", key: "id" }, template: "[[id]]" }],
    reporting: { endpoint: "https://collect.example/actle" },
  }));
  const keychain = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from("K" + t), decryptString: (b) => Buffer.from(b).toString().slice(1) };
  const desk = createAssistant({ dataDir, keychain, now: () => Date.UTC(2026, 5, 1) });
  desk.saveSettings({ captureApps: [{ label: "Notepad", mode: "learn", match: { process: "notepad" } }] });
  assert.deepEqual([desk.licence().status, desk.licence().tier, desk.licence().tierSource], ["unenforced", "enterprise", "unenforced"]);
  assert.equal(desk.licence().override.allowed, true);
  assert.equal(desk.licence().usage.shortcuts, 1);

  desk.saveSettings({ tierOverride: "free" });
  assert.deepEqual([desk.licence().tier, desk.licence().tierSource, desk.licence().entitled], ["free", "override", false]);
  assert.equal(desk.focusChanged({ process: "notepad" }).mode, "triggers", "the person's own learn rule cannot restore learning on Free");
  let actions = [];
  for (const ch of "about the refund sig/") actions = actions.concat(desk.keyTyped({ text: ch }));
  assert.deepEqual(actions.map((a) => a.type), ["expand"], "no keyword offer; the shortcut still expands");
  assert.ok(desk.warnings().some((w) => /^Testing override: this desk runs the Free tier/.test(w)));
  assert.ok(desk.warnings().some((w) => /^Free tier/.test(w)));
  assert.deepEqual(desk.policyInfo().lookups, []);
  assert.equal(desk.policyInfo().reporting.endpoint, null);
  assert.equal(desk.usageReport().tier, "free");
  const changed = desk.audit().filter((e) => e.event === "tier-override-changed");
  assert.deepEqual(changed.map((e) => [e.from, e.to, e.honoured]), [[null, "free", true]]);
  assert.equal(desk.licence().status, "unenforced", "the licence state itself is untouched");

  desk.saveSettings({ tierOverride: "team" });
  assert.equal(desk.licence().tier, "team");
  assert.equal(desk.focusChanged({ process: "notepad" }).mode, "learn");
  actions = [];
  for (const ch of "about the refund ") actions = actions.concat(desk.keyTyped({ text: ch }));
  assert.deepEqual(actions.map((a) => a.type), ["keyword"], "offers are back on Team");
  assert.deepEqual(desk.policyInfo().lookups, [], "lookups stay off on Team");

  desk.saveSettings({ tierOverride: null });
  assert.deepEqual([desk.licence().tier, desk.licence().tierSource], ["enterprise", "unenforced"]);
  assert.equal(desk.policyInfo().lookups.length, 1, "everything is back without a restart");
  assert.equal(desk.warnings().some((w) => /^Testing override/.test(w)), false);

  // Enforced: a valid Business licence; the override is ignored unless the policy allows it, and never upwards.
  const token = license.issueLicence({ id: "LIC-7", organization: "Example Ltd", seats: 10, issuedAt: "2026-01-01", expiresAt: "2026-12-31", graceDays: 30 }, vendor.privateKey);
  const policy = JSON.parse(fs.readFileSync(path.join(dataDir, "policy.json"), "utf8"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(Object.assign({ licence: token }, policy)));
  const enforced = createAssistant({ dataDir, keychain, now: () => Date.UTC(2026, 5, 1), vendorPublicKeys: [vendor.publicKey] });
  assert.deepEqual([enforced.licence().status, enforced.licence().tier, enforced.licence().licensedTier], ["valid", "business", "business"]);
  enforced.saveSettings({ tierOverride: "free" });
  assert.deepEqual([enforced.licence().tier, enforced.licence().override.allowed, enforced.licence().override.honoured], ["business", false, false]);
  assert.match(enforced.licence().override.note, /does not allow trying other tiers/);
  assert.equal(enforced.audit().filter((e) => e.event === "tier-override-changed").pop().honoured, false);
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(Object.assign({ licence: token, licensing: { allowTierOverride: true } }, policy)));
  const allowed = createAssistant({ dataDir, keychain, now: () => Date.UTC(2026, 5, 1), vendorPublicKeys: [vendor.publicKey] });
  assert.deepEqual([allowed.licence().tier, allowed.licence().tierSource], ["free", "override"], "the stored override applies once the policy allows it");
  allowed.saveSettings({ tierOverride: "enterprise" });
  assert.deepEqual([allowed.licence().tier, allowed.licence().override.honoured], ["business", false], "never above the licence");
  assert.match(allowed.licence().override.note, /Enterprise is above this desk's Business tier/);
  assert.equal(JSON.stringify(allowed.audit()).includes("Kind regards"), false);
});

test("a managed desk over its tier's layer cap applies every layer and warns; the shortcut cap trims the last layer's entries first", async () => {
  const org = [];
  for (let i = 0; i < 20; i++) org.push({ trigger: "o" + i + "/", expansion: "org " + i });
  const team = [];
  for (let i = 0; i < 10; i++) team.push({ trigger: "t" + i + "/", expansion: "team " + i });
  const served = {
    [ORG]: signed({ layer: "org", serial: 1, organization: "Example Ltd", library: org, capture: { apps: [{ id: "bank", label: "Bank", mode: "off", match: { title: "Bank" } }] } }),
    [TEAM]: signed({ layer: "team", serial: 1, library: team }),
  };
  const { assistant } = managedDesk(served);
  await assistant.refreshPolicy();
  assert.equal(assistant.policyInfo().organizationLibrary.length, 30);
  assistant.saveSettings({ tierOverride: "free" });
  const info = assistant.policyInfo();
  assert.equal(info.organizationLibrary.length, 25, "Free keeps the first 25 in policy order");
  assert.deepEqual(info.organizationLibrary.slice(20, 25).map((s) => s.trigger), ["t0/", "t1/", "t2/", "t3/", "t4/"], "the organisation layer comes first, the team layer is cut");
  assert.ok(assistant.warnings().some((w) => w === "5 organisation shortcuts ignored: the Free tier allows 25 (the first 25 in policy order are kept)"));
  assert.ok(assistant.warnings().some((w) => w === "policy layers: 2 applied, the Free tier allows 1; nothing was dropped"));
  assert.equal(info.capture.apps.some((r) => r.label === "Bank" && r.mode === "off"), true, "no layer was dropped: the bank rule from the second layer still applies");
  assert.deepEqual(assistant.licence().usage, { shortcuts: 30, layers: 2 });
  assert.deepEqual(assistant.licence().limits, { seats: 1, shortcuts: 25, layers: 1 });
  assistant.focusChanged({ process: "notepad" });
  let actions = [];
  for (const ch of "t9/") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.deepEqual(actions, [], "a trimmed shortcut does not expand");
  actions = [];
  for (const ch of "t4/") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.equal(actions[0] && actions[0].text, "team 4");
});

test("a desk receives the collections its groups are in; two desks on the same policy see different content", async () => {
  const served = {
    [ORG]: signed({
      layer: "org", serial: 1, organization: "Example Ltd",
      library: [{ trigger: "sig/", expansion: "Org sig" }],
      collections: [
        { id: "shipping-catalogue", label: "Shipping catalogue", audience: ["shipping"], library: [{ trigger: "eta/", expansion: "ETA" }], documents: { shortcuts: [{ trigger: "/ship", label: "Shipping forms", documents: [{ path: "S:/forms/ship.pdf" }] }] }, lookups: [{ trigger: "/cust", label: "Customer", source: { kind: "csv", path: "S:/c.csv", key: "id" }, template: "[[id]]" }] },
        { id: "shipping-contacts", label: "Shipping contacts", audience: ["engineering", "shipping"], library: [{ trigger: "shipdesk/", expansion: "shipping@example.com" }], keywordRules: [{ keywords: ["shipping desk"], insert: { kind: "shorthand", trigger: "shipdesk/" } }] },
      ],
    }),
    [TEAM]: signed({ layer: "team", serial: 1, library: [{ trigger: "sld/", expansion: "Shipping desk" }] }),
  };
  const groups = (list) => ({ deployment: { policySources: [{ layer: "org", label: "Organisation", url: ORG }, { layer: "team", label: "Shipping", path: TEAM }], publicKeys: [pair.publicKey], groups: list } });
  const eng = managedDesk(served, groups(["Engineering"])).assistant;
  const ship = managedDesk(served, groups(["shipping"])).assistant;
  const nobody = managedDesk(served).assistant;
  await Promise.all([eng.refreshPolicy(), ship.refreshPolicy(), nobody.refreshPolicy()]);

  assert.deepEqual(eng.policyInfo().groups, ["engineering"]);
  assert.deepEqual(eng.policyInfo().organizationLibrary.map((s) => s.trigger), ["sig/", "sld/", "shipdesk/"]);
  assert.deepEqual(eng.policyInfo().collections.map((c) => [c.id, c.counts.shortcuts, c.counts.keywordRules]), [["shipping-contacts", 1, 1]]);
  assert.deepEqual(eng.policyInfo().hiddenCollections.map((c) => c.label), ["Shipping catalogue"]);
  assert.deepEqual(eng.policyInfo().collectionOf.library, { "shipdesk/": "shipping-contacts" });
  assert.equal(eng.policyInfo().lookups.length, 0);
  assert.equal(eng.policyInfo().documents.length, 0);
  assert.deepEqual(eng.paletteSearch("ship").map((i) => i.trigger).sort(), ["shipdesk/", "sld/"]);

  assert.deepEqual(ship.policyInfo().organizationLibrary.map((s) => s.trigger), ["sig/", "sld/", "eta/", "shipdesk/"]);
  assert.deepEqual(ship.policyInfo().hiddenCollections, []);
  assert.deepEqual(ship.policyInfo().lookups.map((l) => l.trigger), ["/cust"]);
  assert.deepEqual(ship.policyInfo().collectionOf.documents, { "/ship": "shipping-catalogue" });
  assert.deepEqual(ship.policyInfo().collectionOf.lookups, { "/cust": "shipping-catalogue" });
  ship.focusChanged({ process: "notepad" });
  let actions = [];
  for (const ch of "eta/") actions = actions.concat(ship.keyTyped({ text: ch }));
  assert.equal(actions[0] && actions[0].text, "ETA");

  assert.deepEqual(nobody.policyInfo().groups, []);
  assert.deepEqual(nobody.policyInfo().organizationLibrary.map((s) => s.trigger), ["sig/", "sld/"]);
  assert.deepEqual(nobody.policyInfo().hiddenCollections.map((c) => c.id), ["shipping-catalogue", "shipping-contacts"]);
  nobody.focusChanged({ process: "notepad" });
  actions = [];
  for (const ch of "eta/") actions = actions.concat(nobody.keyTyped({ text: ch }));
  assert.deepEqual(actions, [], "a collection not shared with this desk never expands");
  assert.equal(JSON.stringify(nobody.policyInfo()).includes("shipping@example.com"), false, "hidden content is not exposed to the dashboard");
});

test("groups apply to an unmanaged desk with a groups-only deployment file, and the tier cap counts only what the desk receives", () => {
  const library = [];
  for (let i = 0; i < 20; i++) library.push({ trigger: "s" + i + "/", expansion: "shared " + i });
  const extra = [];
  for (let i = 0; i < 10; i++) extra.push({ trigger: "c" + i + "/", expansion: "collection " + i });
  const policy = { organization: "Example Ltd", library, collections: [{ id: "ops", audience: ["ops"], library: extra }] };
  const plain = createAssistant({ dataDir: temp(), policy, deployment: { groups: ["ops"] } });
  assert.equal(plain.managed, false);
  assert.deepEqual(plain.policyInfo().groups, ["ops"]);
  assert.equal(plain.policyInfo().organizationLibrary.length, 30, "groups are read from the deployment file even without policy sources");
  plain.saveSettings({ tierOverride: "free" });
  assert.equal(plain.policyInfo().organizationLibrary.length, 25);
  assert.deepEqual(plain.licence().usage, { shortcuts: 30, layers: 1 });
  assert.ok(plain.warnings().some((w) => /^5 organisation shortcuts ignored/.test(w)));
  assert.deepEqual(Object.keys(plain.policyInfo().collectionOf.library).sort(), ["c0/", "c1/", "c2/", "c3/", "c4/"], "the collection's last entries are cut first and the index only lists what survived");

  const outsider = createAssistant({ dataDir: temp(), policy });
  outsider.saveSettings({ tierOverride: "free" });
  assert.equal(outsider.policyInfo().organizationLibrary.length, 20);
  assert.deepEqual(outsider.licence().usage, { shortcuts: 20, layers: 1 });
  assert.equal(outsider.warnings().some((w) => /organisation shortcuts ignored/.test(w)), false, "no cap warning for content the desk does not receive");
});

test("template answers are remembered per email conversation and offered back in the same conversation only", () => {
  const dataDir = temp();
  const keychain = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from("K" + t), decryptString: (b) => Buffer.from(b).toString().slice(1) };
  const policy = {
    organization: "Example Ltd",
    capture: { defaultMode: "triggers", apps: [{ id: "bank", label: "Banking", mode: "off", match: { title: "Online Banking" } }] },
    library: [{ trigger: "ack/", expansion: "Hi [[name]], your order [[order]] ships [[date]]." }],
  };
  const now = Date.UTC(2026, 9, 20, 9);
  const desk = createAssistant({ dataDir, keychain, policy, now: () => now });
  const typed = (assistant, text) => { let actions = []; for (const ch of text) actions = actions.concat(assistant.keyTyped({ text: ch })); return actions; };
  const fields = ["name", "order", "date"];
  const fromPaletteShape = () => ({ type: "template", trigger: "ack/", fields: fields.map((name) => ({ name, label: name })), backspaces: 0, source: "organization", spentKeystrokes: 4 });

  desk.focusChanged({ process: "OUTLOOK.EXE", title: "RE: Order 1234 - Message (HTML)" });
  let [action] = typed(desk, "ack/");
  assert.equal(action.type, "template");
  assert.equal(action.origin.title, "RE: Order 1234 - Message (HTML)", "the action remembers the window it was typed in");
  let memory = desk.templateDefaults(action);
  assert.deepEqual([memory.thread.app, memory.thread.subject, memory.values], ["outlook", "order 1234", {}]);
  // The person switches to the popover (actle's own window) before submitting; the origin still counts.
  desk.focusChanged({ process: "electron", title: "actle", ownWindow: true });
  assert.equal(desk.templateInserted(action, { values: { name: "Jo Bloggs", order: "1234", date: "3 May", extra: "x" }, pronounPreset: "she/her" }, "Hi Jo Bloggs, your order 1234 ships 3 May."), 3);
  assert.equal(desk.summary({ period: "all" }).expansions, 1, "the insert is counted as before");

  desk.focusChanged({ process: "OUTLOOK.EXE", title: "FW: RE: Order 1234 - Message (HTML)" });
  [action] = typed(desk, "ack/");
  memory = desk.templateDefaults(action);
  assert.deepEqual(memory.values, { name: "Jo Bloggs", order: "1234", date: "3 May" });
  assert.equal(memory.pronouns, "she/her");
  desk.focusChanged({ process: "OUTLOOK.EXE", title: "RE: Order 9999 - Message (HTML)" });
  [action] = typed(desk, "ack/");
  assert.deepEqual(desk.templateDefaults(action).values, {}, "another conversation gets nothing");
  desk.focusChanged({ process: "notepad.exe", title: "Order 1234" });
  [action] = typed(desk, "ack/");
  assert.equal(desk.templateDefaults(action).thread, null, "not a mail window");
  const banking = { process: "OUTLOOK.EXE", title: "Online Banking - Order 1234 - Message (HTML)" };
  assert.equal(desk.threadFor(banking), null, "capture off for this window");
  const viaPalette = Object.assign({}, fromPaletteShape(), { origin: banking });
  assert.equal(desk.templateDefaults(viaPalette).thread, null);
  assert.equal(desk.templateInserted(viaPalette, { values: { name: "Nope" } }, "x"), 0);
  assert.equal(desk.threads().items.some((t) => t.answers.some((a) => a.value === "Nope")), false);

  // The palette: the conversation is the window that had the focus before the palette opened.
  desk.focusChanged({ process: "OUTLOOK.EXE", title: "Re: Order 1234 - Outlook" });
  desk.paletteOpened();
  desk.focusChanged({ process: "electron", title: "actle search", ownWindow: true });
  desk.paletteOpened();
  const fromPalette = desk.paletteChoose({ kind: "shortcut", trigger: "ack/", query: "ack" });
  assert.equal(fromPalette.type, "template");
  assert.equal(desk.templateDefaults(fromPalette).values.name, "Jo Bloggs");

  // What is stored, and what never leaves the desk.
  const list = desk.threads();
  assert.deepEqual([list.enabled, list.storing, list.reason, list.retentionDays], [true, true, null, 90]);
  assert.deepEqual(list.items.map((t) => [t.app, t.subject, t.answers.length]), [["outlook", "order 1234", 3]]);
  assert.equal(desk.corpusInfo().threads.count, 1);
  const raw = fs.readFileSync(path.join(dataDir, "threads.jsonl"), "utf8");
  assert.equal(raw.includes("Jo Bloggs") || raw.includes("order 1234"), false, "sealed on disk");
  for (const text of [JSON.stringify(desk.usageReport()), JSON.stringify(desk.audit()), JSON.stringify(desk.suggestionsExport())]) {
    assert.equal(text.includes("Jo Bloggs") || text.includes("order 1234"), false, "answers and subjects never leave the desk");
  }
  // A restart reads them back; forgetting and deleting learned text remove them.
  const again = createAssistant({ dataDir, keychain, policy, now: () => now + 1000 });
  assert.equal(again.threads().items.length, 1);
  assert.equal(again.forgetThread(again.threads().items[0].id), 1);
  assert.deepEqual(again.threads().items, []);
  desk.focusChanged({ process: "OUTLOOK.EXE", title: "RE: Order 1234 - Message (HTML)" });
  [action] = typed(desk, "ack/");
  desk.templateInserted(action, { values: { name: "Jo" } }, "Hi Jo");
  assert.equal(desk.threads().items.length, 1);
  desk.clearLearning();
  assert.deepEqual(desk.threads().items, []);
  assert.equal(desk.audit().filter((e) => e.event === "corpus-deleted").pop().threads, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, "threads.jsonl"), "utf8"), "");

  // Switched off by the person or by the organisation: nothing is offered or stored.
  desk.saveSettings({ rememberAnswers: false });
  desk.focusChanged({ process: "OUTLOOK.EXE", title: "RE: Order 1234 - Message (HTML)" });
  [action] = typed(desk, "ack/");
  assert.equal(desk.templateDefaults(action).thread, null);
  assert.deepEqual([desk.threads().enabled, desk.threads().reason], [false, "setting"]);
  desk.saveSettings({ rememberAnswers: true });
  const off = createAssistant({ dataDir: temp(), keychain, policy: Object.assign({ threadMemory: { enabled: false } }, policy), now: () => now });
  off.focusChanged({ process: "OUTLOOK.EXE", title: "RE: Order 1234 - Message (HTML)" });
  [action] = typed(off, "ack/");
  assert.equal(off.templateDefaults(action).thread, null);
  assert.deepEqual([off.threads().enabled, off.threads().reason], [false, "organisation"]);
  assert.equal(off.policyInfo().threadMemory.enabled, false);

  // Without a keychain the answers live for this run only.
  const noKey = createAssistant({ dataDir: temp(), policy, now: () => now });
  noKey.focusChanged({ process: "OUTLOOK.EXE", title: "RE: Order 1 - Message (HTML)" });
  [action] = typed(noKey, "ack/");
  noKey.templateInserted(action, { values: { name: "Sam" } }, "Hi Sam");
  assert.equal(noKey.templateDefaults(action).values.name, "Sam");
  assert.deepEqual([noKey.threads().storing, fs.existsSync(path.join(noKey.store.root, "threads.jsonl"))], [false, false]);
  assert.match(noKey.threads().problem, /keychain/);
});
