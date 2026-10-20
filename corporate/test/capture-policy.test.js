const test = require("node:test");
const assert = require("node:assert/strict");
const capture = require("../core/capture-policy.js");

test("rules are normalised and unusable ones skipped with a warning", () => {
  const policy = capture.createPolicy({
    defaultMode: "learn",
    apps: [
      { process: "C:\\Program Files\\OUTLOOK.EXE", mode: "learn" },
      { id: "bad-regex", match: { title: "(" }, mode: "learn" },
      { id: "empty", mode: "learn" },
      "nope",
      { id: "mail", match: { title: "Gmail", bundleId: "Com.Apple.Mail" }, mode: "off" },
    ],
  });
  assert.equal(policy.defaultMode, "learn");
  assert.deepEqual(policy.apps.map((a) => a.id), ["app-0", "mail"]);
  assert.deepEqual(policy.apps[0].processes, ["outlook"]);
  assert.deepEqual(policy.apps[1].bundleIds, ["com.apple.mail"]);
  assert.equal(policy.warnings.length, 3);
  assert.equal(capture.createPolicy(null).defaultMode, "triggers");
  assert.equal(capture.createPolicy({ defaultMode: "weird" }).defaultMode, "triggers");
});

test("decide matches by process, bundle id or title, first rule wins", () => {
  const policy = capture.createPolicy({ apps: [
    { id: "a", match: { process: ["outlook.exe", "thunderbird"] }, mode: "learn" },
    { id: "b", match: { title: "gmail" }, mode: "learn" },
    { id: "c", match: { title: "." }, mode: "off" },
  ] });
  assert.equal(capture.decide({ process: "/Applications/Thunderbird.app" }, policy).mode, "learn");
  assert.equal(capture.decide({ process: "chrome", title: "Inbox - Gmail" }, policy).rule.id, "b");
  assert.equal(capture.decide({ process: "chrome", title: "Anything" }, policy).mode, "off");
  assert.equal(capture.decide({}, policy).mode, "triggers");
  assert.equal(capture.decide({}, policy).reason, "default");
  assert.equal(capture.decide({ process: "x" }, { defaultMode: "learn" }).mode, "learn");
});

test("learn mode is downgraded for credential prompts, password managers and terminals", () => {
  const policy = capture.createPolicy({ defaultMode: "learn", apps: [{ match: { process: "keepassxc" }, mode: "learn" }] });
  assert.equal(capture.decide({ process: "keepassxc.exe" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "chrome", title: "Sign in - Google Accounts" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "WindowsTerminal" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "notepad", title: "Enter your two-factor code" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "notepad", title: "Draft" }, policy).mode, "learn");
  assert.equal(capture.decide({ process: "notepad", secureInput: true }, policy).mode, "off");
  assert.equal(capture.decide({ process: "notepad", passwordField: true }, policy).mode, "off");
  assert.equal(capture.isSensitiveContext({ title: "My passwords.txt - Notepad" }), true);
  assert.equal(capture.isSensitiveContext({ title: "Weekly report" }), false);
});

test("scrub masks card numbers that pass Luhn, labelled secrets and long tokens", () => {
  const input = "Card 4111 1111 1111 1111 expires soon. Password: hunter2! Token X7KQ2M9ZP4WT8NB6RH3VLC5J1Y and order 1234567890123 is fine.";
  const out = capture.scrub(input);
  assert.equal(out.redactions, 3);
  assert.match(out.text, /Card \[card\] expires/);
  assert.match(out.text, /Password: \[redacted\] Token \[token\] and order 1234567890123 is fine/);
  assert.equal(capture.scrub("Our office is at 123 Main Street").text, "Our office is at 123 Main Street");
  assert.equal(capture.scrub("see https://example.com/path and mail me@example.com").redactions, 0);
  assert.equal(capture.scrub("api_key = abcdefghijklmnopqrstuvwxyz").redactions, 1);
  assert.equal(capture.scrub(null).text, "");
});
