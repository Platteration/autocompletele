const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run } = require("../admin/actle-admin.js");

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-admin-"));
}

function cli(argv) {
  const out = [];
  const err = [];
  const code = run(argv, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("keygen, sign and verify round-trip; keys are never overwritten", () => {
  const dir = temp();
  const keys = path.join(dir, "keys");
  const gen = cli(["keygen", keys]);
  assert.equal(gen.code, 0, gen.err);
  assert.match(gen.out, /key id [0-9a-f]{16}/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(keys, "policy-signing.key")).mode & 0o777, 0o600);
  const again = cli(["keygen", keys]);
  assert.equal(again.code, 1);
  assert.match(again.err, /refusing to overwrite/);

  const policy = path.join(dir, "org.json");
  fs.writeFileSync(policy, JSON.stringify({ organization: "Example", library: [{ trigger: "sig/", expansion: "Hi" }] }));
  const missingSerial = cli(["sign", policy, "--key", path.join(keys, "policy-signing.key")]);
  assert.equal(missingSerial.code, 1);
  assert.match(missingSerial.err, /serial/);
  const signedFile = path.join(dir, "org.signed.json");
  const sign = cli(["sign", policy, "--key", path.join(keys, "policy-signing.key"), "--serial", "3", "--out", signedFile]);
  assert.equal(sign.code, 0, sign.err);
  assert.match(sign.out, /signed serial 3/);
  const verify = cli(["verify", signedFile, "--pub", path.join(keys, "policy-signing.pub")]);
  assert.equal(verify.code, 0, verify.err);
  assert.match(verify.out, /valid: serial 3/);

  const other = path.join(dir, "other");
  cli(["keygen", other]);
  const wrong = cli(["verify", signedFile, "--pub", path.join(other, "policy-signing.pub")]);
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /NOT VALID: signed by an untrusted key/);

  const validate = cli(["validate", signedFile]);
  assert.equal(validate.code, 0, validate.err);
  assert.match(validate.out, /signed policy/);
  assert.match(validate.out, /shared shortcuts: 1/);
});

test("sign refuses a policy with warnings unless told otherwise", () => {
  const dir = temp();
  cli(["keygen", dir]);
  const policy = path.join(dir, "bad.json");
  fs.writeFileSync(policy, JSON.stringify({ serial: 1, keywordRules: [{ id: "x", keywords: ["a"], insert: { kind: "shorthand", trigger: "missing/" } }] }));
  const refused = cli(["sign", policy, "--key", path.join(dir, "policy-signing.key")]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /warning: keyword rule x ignored/);
  assert.match(refused.err, /not signed/);
  const forced = cli(["sign", policy, "--key", path.join(dir, "policy-signing.key"), "--allow-warnings"]);
  assert.equal(forced.code, 0);
  assert.match(forced.out, /"format": "actle-signed-policy"/);
  assert.equal(cli(["sign", policy, "--key", path.join(dir, "policy-signing.key"), "--serial", "0"]).code, 1);
});

test("validate and layers report the effective policy", () => {
  const dir = temp();
  const org = path.join(dir, "org.json");
  const team = path.join(dir, "team.json");
  fs.writeFileSync(org, JSON.stringify({ organization: "Example", capture: { defaultMode: "triggers" } }));
  fs.writeFileSync(team, JSON.stringify({ capture: { apps: [{ label: "Outlook", match: { process: "outlook" }, mode: "learn" }] }, paused: { message: "hold" } }));
  const layered = cli(["layers", org, team]);
  assert.equal(layered.code, 0, layered.err);
  assert.match(layered.out, /organisation:\s+Example/);
  assert.match(layered.out, /paused:\s+YES \(hold\)/);
  assert.match(layered.out, /learn\s+Outlook/);
  const json = cli(["layers", org, team, "--json"]);
  assert.equal(JSON.parse(json.out).organization, "Example");
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  const broken = cli(["validate", path.join(dir, "broken.json")]);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /not valid JSON/);
});

test("usage and argument errors exit non-zero", () => {
  assert.equal(cli([]).code, 2);
  assert.equal(cli(["help"]).code, 0);
  assert.equal(cli(["frobnicate"]).code, 2);
  assert.equal(cli(["sign", "x.json", "--key"]).code, 2);
  assert.equal(cli(["verify", "x.json"]).code, 1);
});
