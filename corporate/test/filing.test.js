// Document filing through the desktop assistant (plain Node): propose,
// apply, undo, search, folders, and what reaches the index, audit and metrics.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const extract = require("../core/extract.js");
const { createAssistant } = require("../desktop/assistant.js");

function temp(prefix) {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), prefix || "actle-filing-"));
}

function desk(extraPolicy, extra) {
  const dataDir = temp();
  const root = temp("actle-filing-docs-");
  const policy = Object.assign({
    typing: { secondsPerFiling: 30 },
    filing: {
      watch: [{ path: path.join(root, "inbox"), label: "Inbox" }, { path: "~/Downloads", label: "Downloads" }],
      fields: { client: { values: ["Acme Logistics GmbH"], aliases: { ACME: "Acme Logistics GmbH" } }, ref: { pattern: "INV-\\d{4,}" } },
      rules: [
        { id: "invoice", label: "Supplier invoice", when: { keywords: ["invoice"] }, name: "[[date]]_[[client]]_invoice_[[ref]]", folder: path.join(root, "Invoices", "[[year]]") },
        { id: "memo", label: "Memo", when: { keywords: ["memo"] }, name: "[[date]]_memo_[[original]]", folder: "" },
        { id: "relative", label: "Relative", when: { keywords: ["relative"] }, name: "[[original]]", folder: "sorted/[[year]]" },
      ],
      fallback: { label: "Other", name: "[[date]]_[[original]]" },
    },
  }, extraPolicy);
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(policy));
  fs.mkdirSync(path.join(root, "inbox"));
  const assistant = createAssistant(Object.assign({ dataDir, now: () => new Date(2026, 9, 21, 10).getTime() }, extra));
  return { assistant, dataDir, root, inbox: path.join(root, "inbox") };
}

function docx(text) {
  return extract.zipArchive({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>" + text + "</w:t></w:r></w:p></w:body></w:document>" });
}

test("a proposal reads the document, names it from the rule and says what it could not read", () => {
  const { assistant, inbox } = desk();
  const file = path.join(inbox, "scan 12.docx");
  fs.writeFileSync(file, docx("INVOICE INV-20481 from ACME, 21.10.2026"));
  const proposal = assistant.filingProposal(file);
  assert.equal(proposal.rule.id, "invoice");
  assert.equal(proposal.name, "2026-10-21_Acme_Logistics_GmbH_invoice_INV-20481.docx");
  assert.equal(proposal.folder, path.join(path.dirname(inbox), "Invoices", "2026"));
  assert.equal(proposal.ready, true);
  assert.equal(proposal.inPlace, false);
  assert.deepEqual(proposal.read, { kind: "docx", unsupported: false, truncated: false, error: null });
  const pdf = path.join(inbox, "Invoice_9.pdf");
  fs.writeFileSync(pdf, "%PDF");
  const byName = assistant.filingProposal(pdf);
  assert.equal(byName.rule.id, "invoice");
  assert.equal(byName.read.unsupported, true);
  assert.deepEqual(byName.missing, ["client", "ref"]);
  assert.equal(byName.ready, false);
  const answered = assistant.filingProposal(pdf, { client: "Birch & Co", ref: "INV-5" });
  assert.equal(answered.ready, true);
  assert.equal(answered.name, "2026-10-21_Birch_&_Co_invoice_INV-5.pdf");
  assert.equal(assistant.filingProposal(path.join(inbox, "missing.txt")), null);
  assert.equal(assistant.filingProposal(inbox), null, "a folder is not a document");
  const memo = path.join(inbox, "memo.txt");
  fs.writeFileSync(memo, "Memo to all staff, 2026-01-05");
  const inPlace = assistant.filingProposal(memo);
  assert.equal(inPlace.inPlace, true);
  assert.equal(inPlace.folder, inbox);
  assert.equal(inPlace.name, "2026-01-05_memo_memo.txt");
});

test("applying a filing moves the file, never overwrites, indexes it, audits it and credits the time", () => {
  const { assistant, inbox, root, dataDir } = desk();
  const file = path.join(inbox, "scan 12.docx");
  fs.writeFileSync(file, docx("INVOICE INV-20481 from ACME, 21.10.2026"));
  const result = assistant.applyFiling({ path: file });
  assert.equal(result.ok, true, result.error);
  const target = path.join(root, "Invoices", "2026", "2026-10-21_Acme_Logistics_GmbH_invoice_INV-20481.docx");
  assert.equal(result.to, target);
  assert.ok(fs.existsSync(target));
  assert.ok(!fs.existsSync(file));
  assert.equal(assistant.filingProposal(target), null, "a filed document is not proposed again");

  fs.writeFileSync(file, docx("INVOICE INV-20481 from ACME, 21.10.2026"));
  const second = assistant.applyFiling({ path: file });
  assert.equal(second.ok, true);
  assert.equal(second.name, "2026-10-21_Acme_Logistics_GmbH_invoice_INV-20481 (2).docx");

  const recent = assistant.filingRecent();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].name, second.name, "newest first");
  assert.equal(recent[1].originalName, "scan 12.docx");
  assert.deepEqual(recent[1].values.client, "Acme Logistics GmbH");
  assert.equal(assistant.filingInfo().indexed, 2);
  const onDisk = fs.readFileSync(path.join(dataDir, "filing-index.json"), "utf8");
  assert.equal(onDisk.includes("from ACME"), false, "the index never holds document text");
  assert.ok(onDisk.includes("INV-20481"));

  const audit = assistant.audit().filter((e) => e.event === "document-filed");
  assert.equal(audit.length, 2);
  assert.equal(audit[0].rule, "invoice");
  assert.equal(audit[0].to, target);
  const summary = assistant.summary({ period: "all" });
  assert.equal(summary.expansions, 2);
  assert.equal(summary.secondsSaved, 60, "two filings at the policy's 30 s each");
  assert.equal(assistant.usageReport().byShortcut.find((s) => s.kind === "filed").trigger, "invoice");

  assert.deepEqual(assistant.filingSearch("acme invoice").map((r) => r.name), [second.name, recent[1].name]);
  assert.deepEqual(assistant.filingSearch("zzz"), []);
  assert.equal(assistant.paletteSearch("acme")[0].kind, "file");
  const choice = assistant.paletteChoose({ kind: "file", trigger: second.name, query: "acme" });
  assert.equal(choice.type, "documents");
  assert.equal(choice.documents[0].path, second.to);
  assert.equal(assistant.paletteChoose({ kind: "file", trigger: "nope", query: "" }), null);
});

test("a name with blanks is refused; an edited name is filled, cleaned and keeps its extension", () => {
  const { assistant, inbox } = desk();
  const pdf = path.join(inbox, "Invoice_9.pdf");
  fs.writeFileSync(pdf, "%PDF");
  const refused = assistant.applyFiling({ path: pdf });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.missing, ["client", "ref"]);
  assert.ok(fs.existsSync(pdf));
  const edited = assistant.applyFiling({ path: pdf, answers: { client: "Birch", ref: "INV-7" }, name: "[[ref]] for [[client]]: draft?.pdf" });
  assert.equal(edited.ok, true, edited.error);
  assert.equal(edited.name, "INV-7_for_Birch_draft.pdf");
  fs.writeFileSync(pdf, "%PDF");
  const noExt = assistant.applyFiling({ path: pdf, answers: { client: "Birch", ref: "INV-8" }, name: "plain name" });
  assert.equal(noExt.name, "plain_name.pdf");
  fs.writeFileSync(pdf, "%PDF");
  const stillBlank = assistant.applyFiling({ path: pdf, answers: { client: "Birch" }, name: "[[ref]]_[[client]]" });
  assert.equal(stillBlank.ok, false);
  assert.deepEqual(stillBlank.missing, ["ref"]);
  assert.equal(assistant.applyFiling({ path: path.join(inbox, "nope.pdf") }).ok, false);
  assert.equal(assistant.applyFiling(null).ok, false);
});

test("undo puts the document back under its original name and removes it from the index", () => {
  const { assistant, inbox } = desk();
  const file = path.join(inbox, "memo.txt");
  fs.writeFileSync(file, "Memo to all staff, 2026-01-05");
  const filed = assistant.applyFiling({ path: file });
  assert.equal(filed.ok, true);
  assert.equal(filed.folder, inbox, "a rule without a folder renames in place");
  fs.writeFileSync(file, "another memo took the old name");
  const undone = assistant.undoFiling(filed.id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(undone.to, path.join(inbox, "memo (2).txt"), "the original name was taken, so the next free one is used");
  assert.ok(!fs.existsSync(filed.to));
  assert.equal(assistant.filingRecent().length, 0);
  assert.equal(assistant.audit().pop().event, "document-unfiled");
  assert.equal(assistant.undoFiling(filed.id).ok, false);
  const again = assistant.applyFiling({ path: undone.to });
  fs.unlinkSync(again.to);
  const gone = assistant.undoFiling(again.id);
  assert.equal(gone.ok, false);
  assert.match(gone.error, /no longer at/);
  assert.equal(assistant.filingRecent().length, 0, "a vanished file leaves the index");
  assert.deepEqual(assistant.filingClear(), { ok: true, removed: 0 });
});

test("relative rule folders resolve next to the document, and moving across a boundary falls back to copy", () => {
  const { assistant, inbox } = desk();
  const file = path.join(inbox, "notes.txt");
  fs.writeFileSync(file, "relative stuff 2025-12-31");
  const result = assistant.applyFiling({ path: file });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.to, path.join(inbox, "sorted", "2025", "notes.txt"));
});

test("watch folders combine the policy's and the person's, and a policy folder can be turned off", () => {
  const { assistant, inbox } = desk();
  const home = os.homedir();
  let folders = assistant.filingFolders();
  assert.deepEqual(folders.policy.map((f) => [f.label, f.ignored]), [["Inbox", false], ["Downloads", false]]);
  assert.equal(folders.policy[1].path, path.join(home, "Downloads"));
  assert.deepEqual(folders.own, []);
  assert.equal(folders.active.length, 2);
  assert.equal(assistant.filingIgnoreFolder("~/Downloads").ok, true);
  folders = assistant.filingFolders();
  assert.deepEqual(folders.policy.map((f) => f.ignored), [false, true]);
  assert.deepEqual(folders.active.map((f) => f.path), [inbox]);
  assistant.filingIgnoreFolder("~/Downloads", false);
  assert.equal(assistant.filingFolders().active.length, 2);
  assert.equal(assistant.filingAddFolder("~/Scans").ok, true);
  assert.equal(assistant.filingAddFolder("  ").ok, false);
  folders = assistant.filingFolders();
  assert.deepEqual(folders.own.map((f) => [f.path, f.source]), [[path.join(home, "Scans"), "personal"]]);
  assert.equal(folders.active.length, 3);
  assistant.filingRemoveFolder("~/Scans");
  assert.deepEqual(assistant.filingFolders().own, []);
  assert.equal(assistant.filingInfo().enabled, true);
  assert.equal(assistant.filingInfo().rules.length, 3);
});

test("without filing rules, or while paused, nothing is proposed", () => {
  const empty = desk({ filing: {} });
  const file = path.join(empty.inbox, "a.txt");
  fs.writeFileSync(file, "invoice");
  assert.equal(empty.assistant.filingInfo().enabled, false);
  assert.equal(empty.assistant.filingProposal(file), null);
  const paused = desk({ paused: true });
  const other = path.join(paused.inbox, "a.txt");
  fs.writeFileSync(other, "invoice");
  assert.equal(paused.assistant.filingProposal(other), null);
  assert.equal(paused.assistant.applyFiling({ path: other }).ok, false);
});
