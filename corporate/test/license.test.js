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
  assert.deepEqual(ok.licence, Object.assign({ version: 1 }, fields));
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
  for (const status of ["valid", "grace", "unenforced"]) assert.equal(license.entitlements({ status }).learning, true, status);
  for (const status of ["expired", "missing", "invalid", "mismatch"]) assert.equal(license.entitlements({ status }).learning, false, status);
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
  assert.equal(free.library.length, 1);
  assert.equal(free.capture.defaultMode, "triggers");
  assert.deepEqual(free.capture.apps.map((r) => r.mode), ["triggers", "off"]);
  assert.deepEqual(free.keywordRules, []);
  assert.deepEqual(free.documents.shortcuts, []);
  assert.equal(free.reporting.endpoint, null);
  assert.match(free.warnings[free.warnings.length - 1], /^Free tier/);
  assert.equal(policy.keywordRules.length, 1, "the original policy is untouched");
  assert.equal(license.applyTier(policy, license.entitlements({ status: "valid" })), policy);
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
