const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { run, parseArgs } = require("../admin/actle-admin.js");

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
  const sign = cli(["sign", policy, "--key", path.join(keys, "policy-signing.key"), "--serial", "3", "--layer", "org", "--out", signedFile]);
  assert.equal(sign.code, 0, sign.err);
  assert.match(sign.out, /signed layer org serial 3/);
  const verify = cli(["verify", signedFile, "--pub", path.join(keys, "policy-signing.pub")]);
  assert.equal(verify.code, 0, verify.err);
  assert.match(verify.out, /valid: layer org, serial 3/);

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
  const forced = cli(["sign", policy, "--key", path.join(dir, "policy-signing.key"), "--allow-warnings", "--layer", "org"]);
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

test("validate lists the suite apps by name with the policy section each one reads", () => {
  const example = cli(["validate", path.join(__dirname, "..", "shared", "org-policy.example.json")]);
  assert.equal(example.code, 0, example.err);
  assert.equal(example.out.split("\n").find((line) => line.startsWith("suite apps:")),
    "suite apps:       mactle (reply: 4 replies), extle (sheets: 2 vocabularies), cactle (forms: 3 records), gactle (guard: 3 packs), dactle (notes: 3 documents)");
});

test("file shows how documents would be named and files them only with --apply", () => {
  const dir = temp();
  const extract = require("../core/extract.js");
  const policy = path.join(dir, "org.json");
  fs.writeFileSync(policy, JSON.stringify({
    filing: {
      fields: { client: { values: ["Acme Logistics GmbH"] }, ref: { pattern: "INV-\\d{4,}" } },
      rules: [{ id: "invoice", label: "Supplier invoice", when: { keywords: ["invoice"] }, name: "[[date]]_[[client]]_invoice_[[ref]]", folder: path.join(dir, "Invoices", "[[year]]") }],
      fallback: { name: "[[date]]_[[original]]" },
    },
  }));
  const inbox = path.join(dir, "inbox");
  fs.mkdirSync(inbox);
  const docx = path.join(inbox, "scan 12.docx");
  fs.writeFileSync(docx, extract.zipArchive({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>INVOICE INV-20481 Acme Logistics GmbH 21.10.2026</w:t></w:r></w:p></w:body></w:document>" }));
  const pdf = path.join(inbox, "Invoice_77.pdf");
  fs.writeFileSync(pdf, "%PDF");
  const photo = path.join(inbox, "photo.jpg");
  fs.writeFileSync(photo, "jpeg");
  const dry = cli(["file", docx, pdf, photo, path.join(inbox, "missing.txt"), "--policy", policy]);
  assert.equal(dry.code, 1, "an unreadable document is reported");
  assert.match(dry.out, /rule:\s+Supplier invoice \(matched invoice\)\n\s+name:\s+2026-10-21_Acme_Logistics_GmbH_invoice_INV-20481\.docx/);
  assert.match(dry.out, /Invoice_77\.pdf\n\s+rule:\s+Supplier invoice \(matched invoice; file name only \(pdf is not read\)\)[\s\S]*missing: client, ref/);
  assert.match(dry.out, /photo\.jpg\n\s+rule:\s+Other documents \(no rule matched; file name only \(jpg is not read\)\)/);
  assert.match(dry.err, /missing\.txt: ENOENT/);
  assert.ok(fs.existsSync(docx), "nothing moved without --apply");
  const applied = cli(["file", docx, pdf, "--policy", policy, "--apply"]);
  assert.equal(applied.code, 1, "the pdf with missing blanks is not filed");
  assert.match(applied.out, /not applied: blanks missing/);
  assert.ok(fs.existsSync(path.join(dir, "Invoices", "2026", "2026-10-21_Acme_Logistics_GmbH_invoice_INV-20481.docx")));
  assert.ok(!fs.existsSync(docx));
  assert.ok(fs.existsSync(pdf));
  fs.writeFileSync(docx, extract.zipArchive({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>INVOICE INV-20481 Acme Logistics GmbH 21.10.2026</w:t></w:r></w:p></w:body></w:document>" }));
  const again = cli(["file", docx, "--policy", policy, "--apply"]);
  assert.equal(again.code, 0, again.err);
  assert.ok(fs.existsSync(path.join(dir, "Invoices", "2026", "2026-10-21_Acme_Logistics_GmbH_invoice_INV-20481 (2).docx")), "a second copy never overwrites the first");
  assert.equal(cli(["file", docx, "--policy", policy]).code, 1, "the moved file is gone");
  assert.equal(cli(["file", "--policy", policy]).code, 1);
  assert.equal(cli(["file", photo]).code, 1);
  fs.writeFileSync(path.join(dir, "empty.json"), "{}");
  assert.match(cli(["file", photo, "--policy", path.join(dir, "empty.json")]).err, /no filing rules/);
  assert.match(cli(["validate", policy]).out, /filing rules:\s+invoice, \(fallback\)/);
});

test("usage and argument errors exit non-zero", () => {
  assert.equal(cli([]).code, 2);
  assert.equal(cli(["help"]).code, 0);
  assert.equal(cli(["frobnicate"]).code, 2);
  assert.equal(cli(["sign", "x.json", "--key"]).code, 2);
  assert.equal(cli(["verify", "x.json"]).code, 1);
});

test("report rolls up desk files, skips unreadable ones and writes CSV", () => {
  const dir = temp();
  const reportModule = require("../core/report.js");
  const metrics = require("../core/metrics.js");
  const now = new Date(2026, 9, 20, 12).getTime();
  const make = (id, team, saved) => reportModule.buildReport([metrics.normalizeEntry({ at: now, kind: "expansion", trigger: "sig/", source: "organization", keystrokesSaved: saved }, now)],
    { now, installId: id, team, hourlyRate: 36, currency: "EUR" });
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(make("a", "Shipping", 7200)));
  fs.writeFileSync(path.join(dir, "b.json"), JSON.stringify(make("b", "Sales", 3600)));
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ library: [{ trigger: "sig/", expansion: "x" }, { trigger: "hrs/", expansion: "y" }] }));
  const csv = path.join(dir, "out.csv");
  const result = cli(["report", path.join(dir, "a.json"), path.join(dir, "b.json"), path.join(dir, "broken.json"), "--policy", path.join(dir, "policy.json"), "--csv", csv]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /desks:\s+2/);
  assert.match(result.out, /time saved:\s+0\.9 h/);
  assert.match(result.out, /estimated value:\s+32\.40 EUR at 36 per hour/);
  assert.match(result.out, /Shipping\s+1 desks/);
  assert.match(result.out, /never used: hrs\//);
  assert.match(result.err, /broken\.json/);
  assert.match(result.err, /report 3 skipped/);
  assert.match(fs.readFileSync(csv, "utf8"), /^section,name,desks/);
  assert.equal(cli(["report", path.join(dir, "a.json"), "--rate", "-1"]).code, 1);
  assert.equal(cli(["report", path.join(dir, "broken.json")]).code, 1, "no readable report is a failure");
});

/** Run `body` in `dir` with HOME (and USERPROFILE) at `home`, restoring both however it ends. */
function inFolder(dir, home, body) {
  const before = { cwd: process.cwd(), HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.chdir(dir);
  if (home) process.env.HOME = process.env.USERPROFILE = home;
  try {
    return body();
  } finally {
    process.chdir(before.cwd);
    for (const name of ["HOME", "USERPROFILE"]) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
}

test("file resolves ~ and relative folders as the desk does, whatever folder it is run from", () => {
  const dir = temp();
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "elsewhere");
  const docs = path.join(dir, "docs");
  for (const folder of [home, cwd, docs]) fs.mkdirSync(folder);
  const policy = path.join(dir, "org.json");
  fs.writeFileSync(policy, JSON.stringify({ filing: { rules: [
    { id: "home", when: { keywords: ["alpha"] }, name: "[[original]]_filed", folder: "~/Clients/[[original]]" },
    { id: "near", when: { keywords: ["beta"] }, name: "[[original]]_filed", folder: "Sorted" },
  ] } }));
  fs.writeFileSync(path.join(docs, "a.txt"), "alpha");
  fs.writeFileSync(path.join(docs, "b.txt"), "beta");
  const dry = inFolder(cwd, home, () => cli(["file", path.join(docs, "a.txt"), path.join(docs, "b.txt"), "--policy", policy]));
  assert.equal(dry.code, 0, dry.err);
  assert.ok(dry.out.includes("folder: " + path.join(home, "Clients", "a")), "the dry run prints the folder --apply will use:\n" + dry.out);
  assert.ok(dry.out.includes("folder: " + path.join(docs, "Sorted")));
  const applied = inFolder(cwd, home, () => cli(["file", path.join(docs, "a.txt"), path.join(docs, "b.txt"), "--policy", policy, "--apply"]));
  assert.equal(applied.code, 0, applied.err);
  assert.ok(fs.existsSync(path.join(home, "Clients", "a", "a_filed.txt")), "~ is the home folder");
  assert.ok(fs.existsSync(path.join(docs, "Sorted", "b_filed.txt")), "a relative folder sits next to the document");
  assert.deepEqual(fs.readdirSync(cwd), [], "no \"~\" or \"Sorted\" folder appears where the tool was run");
});

test("file leaves folders, symbolic links and other non-documents alone, with a message", () => {
  const dir = temp();
  const policy = path.join(dir, "org.json");
  fs.writeFileSync(policy, JSON.stringify({ filing: { rules: [{ id: "inv", when: { keywords: ["invoice"] }, name: "[[date]]_[[original]]", folder: path.join(dir, "Clients") }], fallback: { name: "[[date]]_[[original]]", folder: path.join(dir, "Other") } } }));
  const downloads = path.join(dir, "Downloads");
  fs.mkdirSync(path.join(downloads, "Invoice scans.txt"), { recursive: true });
  fs.writeFileSync(path.join(downloads, "Invoice scans.txt", "keep.txt"), "kept");
  fs.mkdirSync(path.join(downloads, "Photos"));
  fs.writeFileSync(path.join(downloads, "Photos", "holiday.jpg"), "jpeg");
  fs.writeFileSync(path.join(dir, "outside.txt"), "invoice outside");
  fs.symlinkSync(path.join(dir, "outside.txt"), path.join(downloads, "invoice-link.txt"));
  fs.writeFileSync(path.join(downloads, "invoice 1.txt"), "invoice 2026-10-21");
  const args = ["Invoice scans.txt", "Photos", "invoice-link.txt", "invoice 1.txt"].map((name) => path.join(downloads, name));
  for (const mode of [[], ["--apply"]]) {
    const result = cli(["file", ...args, "--policy", policy, ...mode]);
    assert.equal(result.code, 1, "a skipped argument is a problem to report");
    assert.match(result.err, /Invoice scans\.txt: not a file \(a folder\), skipped/);
    assert.match(result.err, /Photos: not a file \(a folder\), skipped/);
    assert.match(result.err, /invoice-link\.txt: not a file \(a symbolic link\), skipped/);
    assert.equal(result.out.includes("Invoice scans.txt\n"), false, "nothing is proposed for a folder");
  }
  assert.deepEqual(fs.readdirSync(downloads).sort(), ["Invoice scans.txt", "Photos", "invoice-link.txt"], "only the document was filed");
  assert.equal(fs.readFileSync(path.join(downloads, "Invoice scans.txt", "keep.txt"), "utf8"), "kept");
  assert.ok(fs.lstatSync(path.join(downloads, "invoice-link.txt")).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(path.join(dir, "Clients")), ["2026-10-21_invoice_1.txt"]);
});

test("a file named like an option, put on the command line by a wildcard, is never obeyed", () => {
  const dir = temp();
  const inbox = path.join(dir, "inbox");
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(dir, "org.json"), JSON.stringify({ filing: { rules: [{ id: "inv", when: { keywords: ["invoice"] }, name: "[[date]]_invoice_[[original]]", folder: "filed" }] } }));
  fs.writeFileSync(path.join(dir, "evil.json"), JSON.stringify({ filing: { rules: [{ id: "x", when: { keywords: ["invoice"] }, name: "[[original]]", folder: path.join(dir, "attacker") }] } }));
  for (const name of ["--apply", "report-q3.txt", "supplier-a.txt"]) fs.writeFileSync(path.join(inbox, name), name === "--apply" ? "" : "invoice 2026-10-02");
  const glob = () => fs.readdirSync(inbox).sort();
  // `node actle-admin.js file * --policy ../org.json`, a dry run, run inside the inbox.
  const planted = inFolder(inbox, null, () => cli(["file", ...glob(), "--policy", "../org.json"]));
  assert.equal(planted.code, 2);
  assert.match(planted.err, /--apply is also the name of a file here/);
  assert.deepEqual(glob(), ["--apply", "report-q3.txt", "supplier-a.txt"], "nothing moved");
  // A planted --policy (with a policy of its own) is refused the same way, before or after the administrator's.
  fs.writeFileSync(path.join(inbox, "--policy"), "");
  fs.copyFileSync(path.join(dir, "evil.json"), path.join(inbox, "--policyx.json"));
  for (const argv of [["file", "--policy", "../org.json", ...glob()], ["file", ...glob(), "--policy", "../org.json"]]) {
    const result = inFolder(inbox, null, () => cli(argv));
    assert.equal(result.code, 2);
    assert.match(result.err, /is also the name of a file here/);
  }
  assert.ok(!fs.existsSync(path.join(dir, "attacker")) && !fs.existsSync(path.join(inbox, "filed")));
  // From another folder the wildcard yields inbox/--apply, a document name: the dry run lists them and moves nothing.
  const prefixed = inFolder(dir, null, () => cli(["file", ...glob().map((name) => path.join("inbox", name)), "--policy", "org.json"]));
  assert.equal(prefixed.code, 0, prefixed.err);
  assert.match(prefixed.out, /^DRY RUN: nothing is renamed or moved/);
  assert.match(prefixed.out, /--apply: no rule applies/);
  assert.match(prefixed.out, /report-q3\.txt\n\s+rule:/);
  assert.ok(!fs.existsSync(path.join(inbox, "filed")), "still a dry run");
  // After -- every name is a document too.
  fs.unlinkSync(path.join(inbox, "--policy"));
  const ended = inFolder(inbox, null, () => cli(["file", "--policy", "../org.json", "--", ...glob()]));
  assert.equal(ended.code, 0, ended.err);
  assert.match(ended.out, /\n--policyx\.json\n\s+rule:/, "the planted policy is listed as a document, not used as the policy");
  assert.ok(!fs.existsSync(path.join(inbox, "filed")));
  const applied = inFolder(dir, null, () => cli(["file", path.join("inbox", "report-q3.txt"), "--policy", "org.json", "--apply"]));
  assert.equal(applied.code, 0, applied.err);
  assert.match(applied.out, /^APPLYING: documents are renamed and moved/);
  assert.ok(fs.existsSync(path.join(inbox, "filed", "2026-10-02_invoice_report-q3.txt")));
  assert.ok(fs.existsSync(path.join(inbox, "supplier-a.txt")), "only the document named was filed");
});

test("each command takes only its own options, once, with real values", () => {
  const dir = temp();
  const policy = path.join(dir, "org.json");
  fs.writeFileSync(policy, JSON.stringify({ filing: { fallback: { name: "[[original]]" } } }));
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  const doc = path.join(dir, "a.txt");
  for (const [argv, message] of [
    [["file", doc, "--policy", policy, "--csv", "x.csv"], /file does not take --csv/],
    [["file", doc, "--policy", policy, "--apply.txt", doc], /file does not take --apply\.txt/],
    [["file", doc, "--policy", policy, "--policy", path.join(dir, "other.json")], /--policy is given more than once/],
    [["file", doc, "--policy", "--apply"], /--policy needs a value, not the option --apply/],
    [["report", doc, "--out", "x"], /report does not take --out/],
    [["validate", policy, "--json"], /validate does not take --json/],
    [["--json", "layers", policy], /put the command first/],
  ]) {
    const result = cli(argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.err, message);
  }
  assert.ok(fs.existsSync(doc));
  assert.deepEqual(parseArgs(["file", "--", "--apply", "-x"], { exists: () => false }), { positional: ["file", "--apply", "-x"], flags: {} });
  assert.deepEqual(parseArgs(["verify", "s.json", "--pub", "a.pem", "--pub", "b.pem"], { exists: () => false }).flags, { pub: ["a.pem", "b.pem"] }, "--pub may be repeated");
  assert.deepEqual(parseArgs(["file", "docs/a", "--apply", "--policy", "p"], { exists: () => false }).flags, { apply: true, policy: ["p"] });
  assert.throws(() => parseArgs(["file", "a", "--apply", "--policy", "p"], { exists: () => false }), /a is named without a folder/, "a bare name beside options may come from a wildcard");
  assert.equal(cli(["--help"]).code, 0, "--help prints the usage");
  assert.equal(cli(["report", doc, "--rate", "-1"]).code, 1, "a negative number is a value, not an option");
});

test("file --apply never overwrites a document that appears at the name between the check and the move", () => {
  const dir = temp();
  const policy = path.join(dir, "org.json");
  fs.writeFileSync(policy, JSON.stringify({ filing: { rules: [{ id: "inv", when: { keywords: ["invoice"] }, name: "[[date]]_Invoice", folder: path.join(dir, "filed") }] } }));
  const doc = path.join(dir, "scan.txt");
  fs.writeFileSync(doc, "INVOICE 21.10.2026");
  const target = path.join(dir, "filed", "2026-10-21_Invoice.txt");
  const real = fs.existsSync;
  let raced = 0;
  // A desk files the same name into the same folder while the tool runs.
  fs.existsSync = (p) => {
    if (p === target && !raced++) {
      fs.writeFileSync(target, "THE DESK'S INVOICE");
      return false;
    }
    return real(p);
  };
  let result;
  try {
    result = cli(["file", doc, "--policy", policy, "--apply"]);
  } finally {
    fs.existsSync = real;
  }
  assert.equal(result.code, 0, result.err);
  assert.equal(raced, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "THE DESK'S INVOICE");
  assert.match(result.out, /filed as .*2026-10-21_Invoice \(2\)\.txt/);
  assert.equal(fs.readFileSync(path.join(dir, "filed", "2026-10-21_Invoice (2).txt"), "utf8"), "INVOICE 21.10.2026");
});

test("a planted option still is not obeyed when the planted file is deleted before the tool looks", () => {
  const dir = temp();
  const inbox = path.join(dir, "inbox");
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(dir, "org.json"), JSON.stringify({ filing: { rules: [{ id: "inv", when: { keywords: ["invoice"] }, name: "[[date]]_invoice_[[original]]", folder: "filed" }] } }));
  fs.writeFileSync(path.join(inbox, "evil.json"), JSON.stringify({ filing: { rules: [{ id: "x", when: { keywords: ["invoice"] }, name: "[[original]]", folder: path.join(dir, "attacker") }] } }));
  for (const name of ["report-q3.txt", "supplier-a.txt"]) fs.writeFileSync(path.join(inbox, name), "invoice 2026-10-02");
  const before = fs.readdirSync(inbox).sort();
  // What the shell passed for `file * --policy ../org.json` while inbox/--apply existed;
  // a local process deleted --apply (and --policy) before the tool could see them.
  for (const argv of [
    ["file", "--apply", "report-q3.txt", "supplier-a.txt", "--policy", "../org.json"],
    ["file", "--apply", "--policy", "evil.json", "report-q3.txt", "supplier-a.txt"],
  ]) {
    const result = inFolder(inbox, null, () => cli(argv));
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.err, /report-q3\.txt is named without a folder/);
    assert.deepEqual(fs.readdirSync(inbox).sort(), before, "nothing moved");
  }
  assert.ok(!fs.existsSync(path.join(dir, "attacker")));
  // Documents named with a folder, or after --, are filed as asked; without options a bare name is harmless.
  const dotted = inFolder(inbox, null, () => cli(["file", "./report-q3.txt", "--policy", "../org.json"]));
  assert.equal(dotted.code, 0, dotted.err);
  assert.match(dotted.out, /^DRY RUN/);
  const ended = inFolder(inbox, null, () => cli(["file", "--policy", "../org.json", "--", "report-q3.txt"]));
  assert.equal(ended.code, 0, ended.err);
  assert.ok(!fs.existsSync(path.join(inbox, "filed")), "both were dry runs");

  // `report *` in a folder of desk reports, after a planted --csv was deleted: no desk's report is overwritten.
  const reports = path.join(dir, "reports");
  fs.mkdirSync(reports);
  const reportModule = require("../core/report.js");
  const metrics = require("../core/metrics.js");
  const now = new Date(2026, 9, 20, 12).getTime();
  for (const id of ["a", "b"]) {
    fs.writeFileSync(path.join(reports, "desk-" + id + ".json"), JSON.stringify(reportModule.buildReport([metrics.normalizeEntry({ at: now, kind: "expansion", trigger: "sig/", source: "organization", keystrokesSaved: 60 }, now)], { now, installId: id })));
  }
  const deskA = fs.readFileSync(path.join(reports, "desk-a.json"), "utf8");
  for (const argv of [["report", "--csv", "desk-a.json", "desk-b.json"], ["suggestions", "--out", "desk-a.json", "desk-b.json"]]) {
    const result = inFolder(reports, null, () => cli(argv));
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.err, /desk-b\.json is named without a folder/);
  }
  assert.equal(fs.readFileSync(path.join(reports, "desk-a.json"), "utf8"), deskA);
  assert.equal(inFolder(reports, null, () => cli(["report", "desk-a.json", "desk-b.json"])).code, 0, "without options, bare names are fine");
  // Whatever the command line, --csv and --out never replace a file.
  const over = inFolder(reports, null, () => cli(["report", "./desk-b.json", "--csv", "./desk-a.json"]));
  assert.equal(over.code, 1);
  assert.match(over.err, /desk-a\.json already exists; it was not replaced/);
  assert.equal(fs.readFileSync(path.join(reports, "desk-a.json"), "utf8"), deskA);
  const team = path.join(dir, "team.csv");
  assert.equal(cli(["report", path.join(reports, "desk-a.json"), "--csv", team]).code, 0);
  const csv = fs.readFileSync(team, "utf8");
  assert.equal(cli(["report", path.join(reports, "desk-b.json"), "--csv", team]).code, 1, "a second run does not replace the first CSV");
  assert.equal(fs.readFileSync(team, "utf8"), csv);
  const library = path.join(dir, "library.json");
  fs.writeFileSync(library, "keep");
  const suggestionsFile = path.join(dir, "suggestions.json");
  fs.writeFileSync(suggestionsFile, JSON.stringify(require("../core/suggestions.js").buildExport([{ kind: "paragraph", text: "We will get back to you today.", trigger: "wgb/" }], { installId: "a", now: 5 })));
  const kept = cli(["suggestions", suggestionsFile, "--out", library]);
  assert.equal(kept.code, 1);
  assert.match(kept.err, /library\.json already exists; it was not replaced/);
  assert.equal(fs.readFileSync(library, "utf8"), "keep");
});
