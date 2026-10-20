const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const license = require("../core/license.js");
const signing = require("../core/policy-signing.js");
const orgPolicy = require("../core/org-policy.js");
const { createAssistant } = require("../desktop/assistant.js");
const { run } = require("../admin/actle-admin.js");

const vendor = signing.generateKeyPair();
const other = signing.generateKeyPair();
const T = (y, m, d) => Date.UTC(y, m - 1, d, 12);
const fields = { id: "LIC-1", organization: "Example Ltd", seats: 25, issuedAt: "2026-01-01", expiresAt: "2026-12-31", graceDays: 30 };

test("a licence round-trips and is refused when tampered, forged or malformed", () => {
  const token = license.issueLicence(fields, vendor.privateKey);
  assert.match(token, /^actlebiz1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const ok = license.verifyLicence(token, [other.publicKey, vendor.publicKey]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.licence, Object.assign({ version: 2, tier: "business" }, fields), "issued tokens are version 2 and default to the Business tier");
  assert.equal(ok.keyId, vendor.keyId);
  const [prefix, body, sig] = token.split(".");
  const tampered = JSON.parse(Buffer.from(body, "base64url").toString());
  tampered.seats = 2500;
  assert.match(license.verifyLicence(prefix + "." + Buffer.from(JSON.stringify(tampered)).toString("base64url") + "." + sig, [vendor.publicKey]).error, /signature does not match/);
  assert.match(license.verifyLicence(license.issueLicence(fields, other.privateKey), [vendor.publicKey]).error, /signature does not match/);
  assert.match(license.verifyLicence(token, []).error, /no vendor key/);
  assert.match(license.verifyLicence("actle1.x.y", [vendor.publicKey]).error, /not a business licence/);
  assert.match(license.verifyLicence(prefix + "." + body + ".AAAA", [vendor.publicKey]).error, /malformed/);
  assert.match(license.verifyLicence("", [vendor.publicKey]).error, /no licence/);
  assert.throws(() => license.issueLicence(Object.assign({}, fields, { seats: 0 }), vendor.privateKey), /seats/);
  assert.throws(() => license.issueLicence(Object.assign({}, fields, { expiresAt: "2025-01-01" }), vendor.privateKey), /after issuedAt/);
  assert.throws(() => license.issueLicence(Object.assign({}, fields, { graceDays: 400 }), vendor.privateKey), /graceDays/);
  // A payload with an extra field, signed by hand with the vendor key, is refused.
  const crypto = require("node:crypto");
  const extra = Buffer.from(JSON.stringify(Object.assign({ version: 1, extra: true }, fields))).toString("base64url");
  const forgedSig = crypto.sign(null, Buffer.from("actlebiz1." + extra), crypto.createPrivateKey(vendor.privateKey)).toString("base64url");
  assert.match(license.verifyLicence("actlebiz1." + extra + "." + forgedSig, [vendor.publicKey]).error, /unexpected or missing fields/);
});

const ok = (token) => license.verifyLicence(token, [vendor.publicKey]).licence;

test("licence state follows the clock, the organisation and the pinned keys", () => {
  const token = license.issueLicence(fields, vendor.privateKey);
  const at = (date, extra) => license.licenceState(token, Object.assign({ now: date, publicKeys: [vendor.publicKey], organization: "example ltd " }, extra));
  assert.equal(at(T(2026, 6, 1)).status, "valid");
  assert.equal(at(T(2026, 6, 1)).daysLeft, 213);
  assert.equal(at(T(2027, 1, 10)).status, "grace");
  assert.match(at(T(2027, 1, 10)).reason, /20 day\(s\) of grace remain/);
  assert.equal(at(T(2027, 3, 1)).status, "expired");
  assert.equal(at(T(2026, 6, 1), { organization: "Other Ltd" }).status, "mismatch");
  assert.equal(license.licenceState(null, { publicKeys: [vendor.publicKey] }).status, "missing");
  assert.equal(license.licenceState("junk", { publicKeys: [vendor.publicKey] }).status, "invalid");
  assert.equal(license.licenceState(token, { now: T(2026, 6, 1), publicKeys: [] }).status, "unenforced");
  assert.equal(license.licenceState(token, { now: T(2026, 6, 1) }).status, "unenforced", "nothing pinned in this version yet");
  for (const status of ["valid", "grace"]) assert.equal(license.entitlements({ status, licence: ok(token) }).features.learning, true, status);
  assert.equal(license.entitlements({ status: "unenforced" }).features.learning, true);
  for (const status of ["expired", "missing", "invalid", "mismatch"]) assert.equal(license.entitlements({ status }).features.learning, false, status);
  assert.equal(license.entitlements({ status: "unenforced" }).enforced, false);
  assert.equal(license.entitlements({ status: "valid" }).enforced, true);
});

test("the free tier keeps shortcuts and statistics and switches organisation features off", () => {
  const policy = orgPolicy.parse({
    capture: { defaultMode: "learn", apps: [{ id: "mail", match: { process: "outlook" }, mode: "learn" }, { id: "bank", match: { title: "Bank" }, mode: "off" }] },
    library: [{ trigger: "sig/", expansion: "Kind regards" }],
    keywordRules: [{ id: "r", keywords: ["refund"], insert: "x" }],
    documents: { shortcuts: [{ trigger: "/sld", documents: [{ path: "p" }] }] },
    reporting: { endpoint: "https://collect.example/x" },
  });
  const free = license.applyTier(policy, license.entitlements({ status: "expired" }));
  assert.equal(license.entitlements({ status: "expired" }).tier, "free");
  assert.equal(free.library.length, 1);
  assert.equal(free.capture.defaultMode, "triggers");
  assert.deepEqual(free.capture.apps.map((r) => r.mode), ["triggers", "off"]);
  assert.deepEqual(free.keywordRules, []);
  assert.deepEqual(free.documents.shortcuts, []);
  assert.equal(free.reporting.endpoint, null);
  assert.match(free.warnings[free.warnings.length - 1], /^Free tier/);
  assert.equal(policy.keywordRules.length, 1, "the original policy is untouched");
  assert.equal(license.applyTier(policy, license.entitlements({ status: "valid", licence: ok(license.issueLicence(fields, vendor.privateKey)) })), policy);
});

test("the tier table is ordered, monotonic and complete", () => {
  assert.deepEqual(license.TIER_IDS, ["free", "team", "business", "enterprise"]);
  const keys = (t) => JSON.stringify([Object.keys(t.limits).sort(), Object.keys(t.features).sort()]);
  for (const [i, id] of license.TIER_IDS.entries()) {
    const t = license.TIERS[id];
    assert.equal(t.rank, i, id);
    assert.equal(keys(t), keys(license.TIERS.free), id + " has the same limit and feature keys");
    if (i) {
      const below = license.TIERS[license.TIER_IDS[i - 1]];
      for (const limit of Object.keys(t.limits)) {
        assert.ok(t.limits[limit] === null || (below.limits[limit] !== null && t.limits[limit] >= below.limits[limit]), id + " " + limit + " is at least " + below.name + "'s");
      }
      for (const feature of Object.keys(t.features)) assert.ok(t.features[feature] || !below.features[feature], id + " keeps " + feature);
    }
  }
  for (const limit of Object.values(license.TIERS.enterprise.limits)) assert.equal(limit, null);
  assert.equal(Object.values(license.TIERS.enterprise.features).every(Boolean), true);
  assert.equal(license.tierOf("platinum"), "free");
  assert.match(license.FREE_TIER_NOTE, /learning, keyword rules and warnings, document shortcuts, lookups, report upload are off/);
  assert.equal(license.tierNote("enterprise"), "");
  assert.match(license.tierNote("team"), /^lookups, report upload are off/);
});

test("version 2 tokens carry a tier; version 1 tokens count as Business; bad tiers and over-cap seats are refused", () => {
  const team = license.issueLicence(Object.assign({}, fields, { tier: "team" }), vendor.privateKey);
  assert.equal(ok(team).tier, "team");
  assert.equal(license.tierOfLicence(ok(team)), "team");
  assert.equal(license.entitlements({ status: "valid", licence: ok(team) }).tier, "team");
  assert.equal(license.entitlements({ status: "grace", licence: ok(team) }).tier, "team");
  assert.throws(() => license.issueLicence(Object.assign({}, fields, { tier: "team", seats: 26 }), vendor.privateKey), /Team tier allows at most 25 seats/);
  assert.throws(() => license.issueLicence(Object.assign({}, fields, { tier: "free" }), vendor.privateKey), /tier must be one of team, business, enterprise/);
  assert.throws(() => license.issueLicence(Object.assign({}, fields, { tier: "platinum" }), vendor.privateKey), /tier must be/);
  assert.equal(license.issueLicence(Object.assign({}, fields, { tier: "enterprise", seats: 100000 }), vendor.privateKey).startsWith("actlebiz1."), true);
  // Hand-signed payloads: version 1 without a tier is accepted and is Business; version 1 with a tier or version 2 without one is not.
  const crypto = require("node:crypto");
  const signed = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return "actlebiz1." + body + "." + crypto.sign(null, Buffer.from("actlebiz1." + body), crypto.createPrivateKey(vendor.privateKey)).toString("base64url");
  };
  const v1 = signed(Object.assign({ version: 1 }, fields));
  assert.equal(license.verifyLicence(v1, [vendor.publicKey]).ok, true);
  assert.equal(license.tierOfLicence(ok(v1)), "business");
  assert.equal(license.entitlements({ status: "valid", licence: ok(v1) }).tier, "business");
  assert.match(license.verifyLicence(signed(Object.assign({ version: 1, tier: "team" }, fields)), [vendor.publicKey]).error, /unexpected or missing fields/);
  assert.match(license.verifyLicence(signed(Object.assign({ version: 2 }, fields)), [vendor.publicKey]).error, /unexpected or missing fields/);
  assert.match(license.verifyLicence(signed(Object.assign({ version: 2, tier: "free" }, fields)), [vendor.publicKey]).error, /tier must be/);
  assert.match(license.verifyLicence(signed(Object.assign({ version: 3, tier: "team" }, fields)), [vendor.publicKey]).error, /unsupported licence version 3/);
  // The desk does not re-check the seat cap: a table change must not invalidate a token already issued.
  assert.equal(license.verifyLicence(signed(Object.assign({ version: 2, tier: "team" }, fields, { seats: 400 })), [vendor.publicKey]).ok, true);
});

test("a testing override can lower the tier, and raise it only while licensing is unenforced", () => {
  const business = { status: "valid", licence: ok(license.issueLicence(fields, vendor.privateKey)) };
  const none = license.entitlements(business);
  assert.deepEqual([none.tier, none.source, none.override.requested, none.override.honoured], ["business", "licence", null, false]);
  const unenforced = license.entitlements({ status: "unenforced" }, { override: "free" });
  assert.deepEqual([unenforced.tier, unenforced.source, unenforced.licensedTier, unenforced.override.honoured, unenforced.override.allowed], ["free", "override", "enterprise", true, true]);
  assert.equal(license.entitlements({ status: "unenforced" }, { override: "team" }).tier, "team");
  const ignored = license.entitlements(business, { override: "free" });
  assert.deepEqual([ignored.tier, ignored.override.honoured, ignored.override.allowed], ["business", false, false]);
  assert.match(ignored.override.note, /does not allow trying other tiers/);
  const lowered = license.entitlements(business, { override: "team", allowOverride: true });
  assert.deepEqual([lowered.tier, lowered.source, lowered.override.honoured], ["team", "override", true]);
  const raised = license.entitlements(business, { override: "enterprise", allowOverride: true });
  assert.deepEqual([raised.tier, raised.override.honoured, raised.override.allowed], ["business", false, true]);
  assert.match(raised.override.note, /Enterprise is above this desk's Business tier/);
  const expired = license.entitlements({ status: "expired", licence: business.licence }, { override: "enterprise", allowOverride: true });
  assert.equal(expired.tier, "free", "a hand-edited override cannot lift an expired desk");
  assert.equal(license.entitlements(business, { override: "platinum", allowOverride: true }).override.requested, null, "unknown tiers are ignored");
  assert.equal(license.entitlements(business, { override: "business", allowOverride: true }).source, "override");
});

test("caps degrade: shortcuts beyond the cap are dropped from the end in policy order, layers only warn, nothing refuses", () => {
  const library = [];
  for (let i = 0; i < 30; i++) library.push({ trigger: "z" + (29 - i) + "/", expansion: "entry " + i });
  const policy = orgPolicy.parse({
    library,
    keywordRules: [{ id: "early", keywords: ["a"], insert: { kind: "shorthand", trigger: "z29/" } }, { id: "late", keywords: ["b"], insert: { kind: "shorthand", trigger: "z0/" } }, { id: "warn", keywords: ["card"], action: "warn", message: "no" }],
    lookups: [{ trigger: "/cust", label: "Customer", source: { kind: "csv", path: "x.csv", key: "id" }, template: "[[id]]" }],
    updates: { url: "https://updates.example" },
  });
  assert.equal(policy.library.length, 30);
  const team = license.applyTier(policy, license.entitlements({ status: "unenforced" }, { override: "team" }), { layers: 3 });
  assert.equal(team.library.length, 30, "the Team cap is 1,000; nothing trimmed");
  assert.deepEqual(team.lookups, [], "lookups are a Business feature");
  assert.equal(team.keywordRules.length, 3, "keyword rules stay on Team");
  assert.equal(team.updates.url, "https://updates.example", "the update server is never gated");
  assert.ok(team.warnings.some((w) => w === "policy layers: 3 applied, the Team tier allows 2; nothing was dropped"));
  assert.ok(team.warnings.some((w) => /^Testing override: this desk runs the Team tier/.test(w)));
  assert.match(team.warnings[team.warnings.length - 1], /^Team tier: lookups, report upload are off/);
  assert.equal(policy.lookups.length, 1, "the original policy is untouched");

  const free = license.applyTier(policy, license.entitlements({ status: "missing" }), { layers: 1 });
  assert.equal(free.library.length, 25);
  assert.deepEqual(free.library.map((s) => s.trigger).slice(0, 3), ["z29/", "z28/", "z27/"], "policy order, never sorted");
  assert.equal(free.library.some((s) => s.trigger === "z0/"), false, "the last entries are the ones cut");
  assert.ok(free.warnings.some((w) => w === "5 organisation shortcuts ignored: the Free tier allows 25 (the first 25 in policy order are kept)"));
  assert.deepEqual(free.keywordRules, [], "no rules on Free");
  assert.equal(free.updates.url, "https://updates.example");
  assert.match(free.warnings[free.warnings.length - 1], /^Free tier/);
  assert.equal(policy.library.length, 30);

  // With rules kept (Team cap lowered by hand to prove the reference check), a rule pointing past the cap is dropped.
  const capped = license.applyTier(policy, Object.assign(license.entitlements({ status: "unenforced" }, { override: "team" }), { limits: { seats: 25, shortcuts: 10, layers: 2 } }), { layers: 1 });
  assert.equal(capped.library.length, 10);
  assert.deepEqual(capped.keywordRules.map((r) => r.id), ["early", "warn"], "the rule pointing at a trimmed shortcut is gone, the warning rule stays");
  assert.ok(capped.warnings.some((w) => /keyword rule late ignored: shortcut z0\/ is not in the policy library/.test(w)));
  assert.deepEqual(license.usage(policy, 2), { shortcuts: 30, layers: 2 });
  assert.deepEqual(license.tierWarnings(policy, "enterprise", { layers: 99 }), []);
  assert.equal(license.applyTier(policy, license.entitlements({ status: "unenforced" }), { layers: 99 }), policy, "Enterprise returns the same object");
  const chosen = license.applyTier(policy, license.entitlements({ status: "unenforced" }, { override: "enterprise" }), { layers: 1 });
  assert.notEqual(chosen, policy);
  assert.deepEqual(chosen.warnings.filter((w) => /^Testing override/.test(w)), ["Testing override: this desk runs the Enterprise tier chosen on the Policy tab, not the tier its licence gives"], "an override is always announced, even when it changes nothing else");
});

function desk(policyExtra, options) {
  const dataDir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-lic-"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(Object.assign({
    organization: "Example Ltd",
    capture: { defaultMode: "learn" },
    library: [{ trigger: "sig/", expansion: "Kind regards" }],
    keywordRules: [{ id: "r", keywords: ["refund"], insert: "Policy text" }],
  }, policyExtra)));
  return createAssistant(Object.assign({ dataDir, vendorPublicKeys: [vendor.publicKey] }, options));
}

test("an expired licence puts the desk on the free tier: shortcuts work, nothing organisational fires", () => {
  const token = license.issueLicence(fields, vendor.privateKey);
  const keychain = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from("K" + t), decryptString: (b) => Buffer.from(b).toString().slice(1) };
  const expired = desk({ licence: token }, { now: () => T(2027, 6, 1), keychain });
  expired.saveSettings({ captureApps: [{ label: "Notepad", mode: "learn", match: { process: "notepad" } }] });
  assert.equal(expired.licence().status, "expired");
  assert.equal(expired.licence().entitled, false);
  assert.equal(expired.licence().tier, "free");
  assert.equal(expired.licence().tier, "free");
  assert.equal(expired.focusChanged({ process: "notepad" }).mode, "triggers", "the person's own learn rule cannot restore learning");
  let actions = [];
  for (const ch of "about the refund sig/") actions = actions.concat(expired.keyTyped({ text: ch }));
  assert.deepEqual(actions.map((a) => a.type), ["expand"], "no keyword offer, the shortcut still expands");
  assert.ok(expired.warnings().some((w) => /^Free tier/.test(w)));
  assert.equal(expired.usageReport().licenceId, "LIC-1");
  assert.deepEqual(expired.audit().filter((e) => e.event === "licence-changed").map((e) => [e.status, e.id]), [["expired", "LIC-1"]]);

  const valid = desk({ licence: token }, { now: () => T(2026, 6, 1) });
  assert.equal(valid.licence().status, "valid");
  assert.equal(valid.policyInfo().licence.seats, 25);
  valid.focusChanged({ process: "notepad" });
  actions = [];
  for (const ch of "about the refund ") actions = actions.concat(valid.keyTyped({ text: ch }));
  assert.deepEqual(actions.map((a) => a.type), ["keyword"]);

  const none = desk({}, { now: () => T(2026, 6, 1) });
  assert.equal(none.licence().status, "missing");
  assert.equal(none.policyInfo().keywordRules.length, 0);

  const unenforced = desk({}, { now: () => T(2026, 6, 1), vendorPublicKeys: undefined });
  assert.equal(unenforced.licence().status, "unenforced");
  assert.equal(unenforced.policyInfo().keywordRules.length, 1, "nothing is switched off while no vendor key is built in");
  assert.equal(unenforced.audit().some((e) => e.event === "licence-changed"), false);
});

test("the admin tool issues and shows licences and counts desks against seats", () => {
  const dir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-licadmin-"));
  fs.writeFileSync(path.join(dir, "vendor.key"), vendor.privateKey);
  fs.writeFileSync(path.join(dir, "vendor.pub"), vendor.publicKey);
  const out = [];
  const err = [];
  const cli = (argv) => ({ code: run(argv, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }), text: out.splice(0).join("\n"), errors: err.splice(0).join("\n") });
  const issued = cli(["license", "issue", "--key", path.join(dir, "vendor.key"), "--org", "Example Ltd", "--seats", "3", "--expires", "2030-01-01", "--id", "LIC-9", "--out", path.join(dir, "lic.txt")]);
  assert.equal(issued.code, 0, issued.errors);
  const token = fs.readFileSync(path.join(dir, "lic.txt"), "utf8").trim();
  assert.equal(license.verifyLicence(token, [vendor.publicKey]).ok, true);
  const shown = cli(["license", "show", path.join(dir, "lic.txt"), "--pub", path.join(dir, "vendor.pub")]);
  assert.equal(shown.code, 0, shown.errors);
  assert.match(shown.text, /seats:\s+3/);
  assert.match(shown.text, /signature:\s+valid/);
  assert.equal(cli(["license", "show", token, "--pub", path.join(dir, "vendor.pub")]).code, 0);
  fs.writeFileSync(path.join(dir, "other.pub"), other.publicKey);
  assert.equal(cli(["license", "show", path.join(dir, "lic.txt"), "--pub", path.join(dir, "other.pub")]).code, 1);
  assert.equal(cli(["license", "issue", "--key", path.join(dir, "vendor.key"), "--org", "X"]).code, 1);

  fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ organization: "Example Ltd", licence: token }));
  const reportModule = require("../core/report.js");
  for (const id of ["a", "b", "c", "d"]) {
    fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(reportModule.buildReport([], { now: Date.now(), installId: id, licenceId: "LIC-9" })));
  }
  const rolled = cli(["report", ...["a", "b", "c", "d"].map((id) => path.join(dir, id + ".json")), "--policy", path.join(dir, "policy.json")]);
  assert.equal(rolled.code, 0, rolled.errors);
  assert.match(rolled.text, /licence LIC-9: 4 desk\(s\) of 3 seats/);
  assert.match(rolled.errors, /over its 3 seats by 1/);
});
