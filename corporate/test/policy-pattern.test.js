// Policy regular expressions are untrusted input: refused at load when their
// shape backtracks exponentially, capped and time-budgeted at run time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const policyPattern = require("../core/policy-pattern.js");
const { createPatternRunner } = require("../desktop/pattern-runner.js");
const orgPolicy = require("../core/org-policy.js");

const folders = [];
test.after(() => {
  policyPattern.setRunner(null);
  policyPattern.reset();
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true });
});

// Every pattern written in this repository's example and sample policies.
const SAFE = ["\\b(INV|PO|CT)-\\d{4,}\\b", "INV-\\d{4,}", "^(customer|client)", "notes?$", "\\bPRJ-[A-Z]{3,8}\\b", "Dear ([^,]+),",
  "parcel\\s+(\\d{10,})", "\\b1Z[A-Z0-9]{16}\\b", "A-\\d{5}", "(Gmail|Outlook|Mail) - ", "Online Banking", "card\\s*(?:no|number)?:?\\s*([0-9 ]{13,19})",
  "\\s*:\\s*(\\S+)", "(?<name>ab)c", "[(]+x", "a{2,3}", "\\p{L}+\\s\\d+", "[\\]]+"];
const UNSAFE = {
  "(a+)+$": /nested quantifiers/, "(a*)*b": /nested quantifiers/, "(x+x+)+y": /nested quantifiers/, "(\\w+\\s?)+$": /nested quantifiers/,
  "(.*a){12}": /nested quantifiers/, "^(([a-z])+.)+[A-Z]([a-z])+$": /nested quantifiers/, "(?:a+){2}": /nested quantifiers/, "((ab)*)*": /nested quantifiers/,
  "(a|aa)+$": /alternatives/, "(a|b)*c": /alternatives/, "(a)\\1": /backreferences/, "\\k<n>(?<n>a)": /backreferences/,
  "a+b+c+d+e+": /more than 4 unbounded/, ["x".repeat(257)]: /longer than 256/, "(": /invalid pattern/, "": /empty/,
};

test("check accepts every pattern the repository's policies use and refuses the backtracking shapes", () => {
  for (const source of SAFE) assert.equal(policyPattern.check(source, "iu"), null, source);
  for (const [source, reason] of Object.entries(UNSAFE)) assert.match(String(policyPattern.check(source, "u")), reason, source);
  assert.equal(policyPattern.unsafeShape("a{1,40}b"), null, "a bounded repeat is not counted as unbounded");
  assert.match(policyPattern.unsafeShape("(a+){1,40}"), /nested/, "but a large bounded repeat of a repeated group is nested");
});

test("without a runner, patterns run directly on capped text; matchAll adds the g flag", () => {
  policyPattern.setRunner(null);
  policyPattern.reset();
  const m = policyPattern.exec("INV-(\\d{4,})", "i", "see inv-20481 now");
  assert.deepEqual([m[0], m[1], m.index], ["inv-20481", "20481", 4]);
  assert.equal(policyPattern.test("^(customer|client)", "iu", "Customer name"), true);
  assert.deepEqual(policyPattern.matchAll("PRJ-[A-Z]+", "", "PRJ-ABC and PRJ-XYZ").map((x) => x[0]), ["PRJ-ABC", "PRJ-XYZ"]);
  assert.equal(policyPattern.exec("x$", "", "a".repeat(20000) + "x"), null, "text past the default cap is not seen");
  assert.equal(policyPattern.exec("x$", "", "a".repeat(20000) + "x", 30000)[0], "x", "a caller may raise the cap");
});

test("the desk's runner stops a pattern that runs too long, disables it and reports it once", () => {
  const reported = [];
  policyPattern.reset();
  policyPattern.setRunner(createPatternRunner({ budgetMs: 30 }), (source, flags) => reported.push(source + "/" + flags));
  const cubic = "\\d+\\d+\\d+x"; // passes the static check, still polynomial
  assert.equal(policyPattern.check(cubic, ""), null);
  const started = Date.now();
  assert.equal(policyPattern.exec(cubic, "", "1".repeat(5000)), null);
  assert.ok(Date.now() - started < 2000, "interrupted, not run to the end");
  assert.deepEqual(reported, ["\\d+\\d+\\d+x/"]);
  assert.equal(policyPattern.test(cubic, "", "1x"), false, "disabled for the session, even on input it would match");
  assert.deepEqual(policyPattern.disabledPatterns().length, 1);
  assert.equal(reported.length, 1, "reported once");
  assert.equal(policyPattern.exec("INV-\\d+", "", "INV-12")[0], "INV-12", "other patterns keep working");
  policyPattern.setRunner(null);
  policyPattern.reset();
});

test("every policy section refuses a backtracking pattern with a warning, so `sign` refuses the policy", () => {
  const evil = "(a+)+$";
  const policy = orgPolicy.parse({
    capture: { apps: [{ id: "cap", match: { title: evil }, mode: "off" }] },
    filing: { fields: { client: { pattern: evil } }, rules: [{ id: "r", when: { keywords: ["x"] }, name: "[[client]]" }] },
    forms: { lookups: [{ id: "orders", key: "ref", keyPattern: evil, rows: [{ ref: "A" }] }], forms: [{ id: "f", match: { title: evil }, fields: [{ name: "a", selector: "s" }] }] },
    guard: { internalCodes: [evil], packs: [] },
    reply: { extract: { name: { pattern: evil } }, replies: [] },
    sheets: { vocabularies: { v: ["A"] }, columns: [{ match: { header: evil }, vocabulary: "v" }] },
  });
  const refused = policy.warnings.filter((w) => /nested quantifiers/.test(w));
  assert.equal(refused.length, 7, policy.warnings.join("\n"));
  for (const where of ["capture rule cap", "filing field client", "form lookup orders keyPattern", "form f", "guard internal code", "reply section extractor name", "sheets column 0"]) {
    assert.ok(refused.some((w) => w.startsWith(where)), where + " in:\n" + refused.join("\n"));
  }
  assert.equal(policy.capture.apps.length, 0);
  assert.equal(policy.guard.internalCodes.length, 0);
  assert.equal(policy.sheets.columns.length, 0);
});

test("the assistant installs the runner and audits a pattern it had to turn off", () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-pattern-"));
  folders.push(dataDir);
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ guard: { internalCodes: ["\\d+\\d+\\d+x"], packs: [{ id: "p", rules: [{ id: "codes", detect: ["internal-code"], message: "No codes." }] }] } }));
  policyPattern.reset();
  const { createAssistant } = require("../desktop/assistant.js");
  const assistant = createAssistant({ dataDir, now: () => new Date(2026, 9, 21, 10).getTime(), patternBudgetMs: 30, appIds: ["guard"] });
  const result = assistant.invoke("guard:check", { text: "1".repeat(4000) });
  assert.ok(result, "the check returned instead of hanging");
  assert.ok(assistant.warnings().some((w) => /took too long and was turned off until restart/.test(w)));
  const audited = assistant.audit().filter((e) => e.event === "policy-pattern-disabled");
  assert.equal(audited.length, 1);
  assert.equal(audited[0].pattern, "\\d+\\d+\\d+x");
  policyPattern.setRunner(null);
  policyPattern.reset();
});
