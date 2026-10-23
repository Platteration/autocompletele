// cactle through the desktop assistant (plain Node): a record trigger
// typed in a form window opens the plan popover, its Fill closes the popover
// and types the values through a fake shell with a Tab per field passed
// over, and what reaches the metrics, the audit file, the app data (own
// records, stored fills, dismissals) and the dashboard channels. The two
// pages run under a few lines of DOM at the end.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const orgPolicy = require("../core/org-policy.js");
const signing = require("../core/policy-signing.js");
const metrics = require("../core/metrics.js");
const report = require("../core/report.js");
const { loadApps } = require("../desktop/apps/index.js");
const formsApp = require("../desktop/apps/forms/app.js");
const records = require("../desktop/apps/forms/records.js");
const { fakeShell, typeAll, TICKET, CLIPBOARD, REASON } = require("../desktop/apps/forms/simulate.js");
const { createAssistant } = require("../desktop/assistant.js");

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desktop", "apps", "forms", "sample-policy.json"), "utf8"));
const NOW = new Date(2026, 9, 21, 10).getTime();
const NOTEPAD = { process: "notepad.exe", title: "Untitled" };
const PORTAL = { process: "portal.exe", title: "Portal" };
const { SIZE } = formsApp;

const folders = [];
test.after(() => { for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true }); });

function temp() {
  const dir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-forms-"));
  folders.push(dir);
  return dir;
}

function desk(extraPolicy, extra) {
  const dataDir = temp();
  const policy = Object.assign({
    organization: "Example Logistics",
    library: [{ trigger: "sig/", expansion: "Kind regards" }],
    documents: { shortcuts: [{ trigger: "/sld", documents: [{ path: "S:/x.pdf" }] }] },
    forms: SAMPLE,
  }, extraPolicy);
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(policy));
  const assistant = createAssistant(Object.assign({ dataDir, now: () => NOW, appIds: ["forms"] }, extra));
  return { assistant, dataDir, app: assistant.app("forms"), submit: assistant.app("forms").popovers.plan.submit };
}

function withRecords(extra) {
  return Object.assign({}, SAMPLE, { records: SAMPLE.records.concat(extra) });
}

/** The simulator's stand-in, with a sender that answers through promises like Electron's. */
function asyncShell(clipboardText) {
  const shell = fakeShell(clipboardText);
  const replace = shell.sender.replace;
  const press = shell.sender.press;
  shell.sender.replace = (action) => Promise.resolve(replace(action));
  shell.sender.press = (name, count) => Promise.resolve(press(name, count));
  return shell;
}

function open(assistant, context, text) {
  assistant.focusChanged(context);
  let actions = [];
  for (const ch of text) actions = actions.concat(assistant.keyTyped({ text: ch }));
  return actions;
}

function state(action) {
  return Object.assign({ kind: "app" }, action);
}

function stored(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, "apps", "forms.json"), "utf8"));
}

test("the sample section parses with no warnings and the app loads through the registry with the contract's shape", () => {
  const parsed = orgPolicy.parse({ forms: SAMPLE });
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.forms.records.map((r) => [r.id, r.trigger]), [["refund-case", "refund/"], ["complaint", "cmp/"], ["address-change", undefined]]);
  const [app] = loadApps({ policy: () => parsed, engine: { library: [] }, appData: () => ({ load: () => ({}), save: () => {} }), now: () => NOW, log: () => {} }, { ids: ["forms"] });
  assert.equal(app.id, "forms");
  assert.equal(app.title, "cactle");
  assert.deepEqual(Object.keys(app.ipc), ["forms:info", "forms:lookup", "forms:clipboardReference", "forms:plan", "forms:acceptProposal", "forms:dismissProposal", "forms:deleteOwnRecord", "forms:clearSessions"]);
  assert.equal(app.extension.id, "forms");
  assert.equal(app.popovers.plan.file, "apps/forms-plan");
  assert.equal(typeof app.popovers.plan.submit, "function");
  assert.deepEqual(Object.keys(app).filter((key) => typeof app[key] === "function").sort(), ["onClearLearning", "onFocus", "onStart", "onStop", "simulate"], "nothing exposed beyond the contract (onClearLearning: assistant.clearLearning, \"Delete learned text\")");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "desktop", "renderer", "apps", "forms-plan.html")));
  assert.equal(app.trayItems, undefined, "no tray entry: a record has to be chosen first");

  // The height follows what the page shows: a line per 70 characters of "label: value", a sub-line for an open blank or for fields Tabbed over, a row per blank of the record.
  const short = { label: "Category", value: "Refund", missing: [], over: [] };
  const long = { label: "Internal note", value: "x".repeat(130), missing: ["reason"], over: ["E-mail", "SLA hours"] };
  assert.deepEqual(app.popovers.plan.size({ record: { blanks: ["customer", "orderRef", "reason"] }, plan: { steps: [short, short, long], missing: ["reason"] } }),
    { width: SIZE.width, height: SIZE.base + 3 * SIZE.blank + 3 * SIZE.step + (1 + 1 + 3) * SIZE.line + 2 * SIZE.sub }, "three blanks even though one is open: a typed reference can open the others");
  assert.equal(app.popovers.plan.size({ record: { blanks: [] }, plan: { steps: Array.from({ length: 40 }, () => short), missing: [] } }).height, SIZE.max, "capped");
  assert.equal(app.popovers.plan.size(null).height, SIZE.base);
  assert.equal(formsApp.FOCUS_DELAY_MS, 150, "the pause main.js gives the palette");
});

test("a record trigger typed in a form window opens the plan with the matched form and the clipboard reference; elsewhere the record order is used", () => {
  const { assistant, app } = desk();
  const shell = asyncShell(CLIPBOARD);
  app.onStart(shell);
  const [action] = open(assistant, TICKET, "Case: refund/");
  assert.equal(action.type, "app");
  assert.equal(action.app, "forms");
  assert.equal(action.popover, "plan");
  assert.equal(action.trigger, "refund/");
  assert.equal(action.backspaces, 7);
  assert.equal(action.via, "trigger");
  assert.equal(action.recordId, "refund-case");
  assert.equal(action.formId, "ticket");
  assert.deepEqual(action.record, { id: "refund-case", label: "Refund case", own: false, blanks: ["customer", "orderRef", "reason"] });
  assert.deepEqual(action.form, { id: "ticket", label: "Support ticket", selectors: ["combobox:Category", "combobox:Priority", "edit:Requester", "edit:Email", "edit:SLA", "document:Internal note"] });
  assert.equal(action.reference, "A-12345", "the clipboard was tried once");
  assert.deepEqual(action.lookup, { lookup: "orders", key: "A-12345", via: "exact", row: { orderRef: "A-12345", customer: "Mary Jones", email: "mary.jones@example.com" } }, "the state carries the key the clipboard text contained");
  assert.deepEqual(action.plan.steps.map((s) => [s.field, s.value, s.source, s.tabs, s.over]), [
    ["category", "Refund", "record", 0, []], ["priority", "P2", "record", 1, []], ["customer", "Mary Jones", "values", 1, []], ["email", "mary.jones@example.com", "values", 1, []], ["sla", "48", "record", 1, []],
    ["notes", "Hi Mary Jones, the refund for order A-12345 is on its way. [[reason]]", "record", 1, []],
  ]);
  assert.deepEqual(action.plan.missing, ["reason"]);
  assert.equal(action.plan.ready, false);
  assert.equal(action.notes.noForm, formsApp.NO_FORM_NOTE);
  assert.equal(assistant.engine.buffer, "", "the trigger was consumed");

  const [elsewhere] = open(assistant, NOTEPAD, "cmp/");
  assert.equal(elsewhere.formId, null);
  assert.equal(elsewhere.form, null);
  assert.deepEqual(elsewhere.plan.steps.map((s) => [s.field, s.label, s.tabs]), [["category", "category", 0], ["priority", "priority", 1], ["sla", "sla", 1], ["notes", "notes", 1]], "record order, the field names as labels, one Tab between them");
  assert.deepEqual(elsewhere.plan.missing, ["summary"], "the clipboard's row filled customer and orderRef");
  assert.deepEqual(open(assistant, TICKET, "xrefund/"), [], "a trigger glued to a word does not fire");
  assert.deepEqual(open(assistant, TICKET, "address-change "), [], "a record without a trigger is palette-only");
  assert.equal(open(assistant, TICKET, "sig/")[0].type, "expand", "a library shortcut keeps its trigger");

  // Form fields without a value cost a Tab each; the caret starts in the form's first field.
  const gaps = desk({ forms: withRecords([{ id: "note-only", trigger: "note/", fields: { notes: "Just a note" } }]) });
  const [noRow] = open(gaps.assistant, TICKET, "refund/");
  assert.deepEqual(noRow.plan.steps.map((s) => [s.field, s.tabs, s.over]), [["category", 0, []], ["priority", 1, []], ["sla", 3, ["Requester", "E-mail"]], ["notes", 1, []]]);
  const [last] = open(gaps.assistant, TICKET, "note/");
  assert.deepEqual(last.plan.steps.map((s) => [s.field, s.tabs, s.over]), [["notes", 5, ["Category", "Priority", "Requester", "E-mail", "SLA hours"]]]);

  app.onStop();
  const [noShell] = open(assistant, TICKET, "refund/");
  assert.equal(noShell.reference, "", "without the started shell there is no clipboard to try");
  const paused = desk({ paused: true });
  assert.deepEqual(open(paused.assistant, TICKET, "refund/"), []);
  assert.equal(paused.app.extension.trigger("refund/"), null);
  assert.deepEqual(paused.app.palette.items(), []);
});

test("Fill refuses an open blank, then closes the popover and types the values with Tab between them, counts, stores the fill and audits without any value", async () => {
  const { assistant, app, dataDir, submit } = desk();
  const shell = asyncShell(CLIPBOARD);
  app.onStart(shell);
  const [action] = open(assistant, TICKET, "refund/");
  const refused = await submit(state(action), { reference: "A-12345", answers: {} }, shell);
  assert.deepEqual(refused, { ok: false, error: "Fill in: reason", missing: ["reason"] });
  assert.deepEqual(await submit(state(action), { reference: "A-12345", answers: { reason: "   " } }, shell), { ok: false, error: "Fill in: reason", missing: ["reason"] });
  const noRow = await submit(state(action), { reference: "A-99999", answers: {} }, shell);
  assert.deepEqual(noRow, { ok: false, error: "Fill in: customer, orderRef, reason (no lookup row matches A-99999)", missing: ["customer", "orderRef", "reason"] });
  assert.deepEqual(await submit(state(Object.assign({}, action, { recordId: "gone" })), {}, shell), { ok: false, error: "This record is no longer available." });
  assert.deepEqual(shell.calls.replaced, [], "nothing was typed");
  assert.equal(shell.calls.closed, 0, "a refusal keeps the popover open");
  assert.equal(assistant.ledger.entries().length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, "apps", "forms.json")), false);

  const result = await submit(state(action), { reference: "A-12345", answers: { reason: REASON, extra: "ignored" } }, shell);
  assert.deepEqual(result, { ok: true, record: "refund-case", form: "ticket", fields: 6, keystrokesSaved: result.keystrokesSaved });
  assert.deepEqual(shell.calls.keys, [
    "close popover", "backspace x7, paste \"Refund\"", "tab", "paste \"P2\"", "tab", "paste \"Mary Jones\"", "tab", "paste \"mary.jones@example.com\"", "tab", "paste \"48\"", "tab",
    "paste \"Hi Mary Jones, the refund for order A-12345 is on its way. Sorry for the delay.\"",
  ], "the popover closes before the first key, so the keys reach the form");
  assert.deepEqual(shell.calls.replaced[0], { backspaces: 7, text: "Refund", cursorOffset: 6 });
  assert.deepEqual(shell.calls.pressed, Array.from({ length: 5 }, () => ["tab", 1]));
  assert.deepEqual(shell.calls.notified, ["Filled 6 fields of Refund case."]);
  const [entry] = assistant.ledger.entries();
  assert.equal(entry.kind, "form");
  assert.equal(entry.trigger, "refund-case");
  assert.equal(entry.source, "organization");
  assert.equal(entry.app, "zendesk");
  const inserted = shell.calls.replaced.map((c) => c.text).join("\n");
  assert.equal(entry.keystrokesSaved, metrics.graphemes(inserted) - 7 - metrics.graphemes(REASON), "the typed trigger and the typed answer are not savings; the clipboard reference is, and an answer for no blank is not typed");
  assert.equal(result.keystrokesSaved, entry.keystrokesSaved);
  const audit = assistant.audit().filter((e) => e.event === "form-filled");
  assert.deepEqual(audit, [{ at: NOW, event: "form-filled", record: "refund-case", form: "ticket", via: "trigger", fields: 6, blanksAnswered: 1, lookup: "orders", keystrokesSaved: entry.keystrokesSaved }]);
  const auditText = fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8");
  assert.equal(auditText.includes("Mary") || auditText.includes("A-12345") || auditText.includes("delay"), false, "no value, reference or answer in the audit file");
  const saved = stored(dataDir);
  // The note carries the typed reason, so the whole note stays off the disk; the record's constants and the lookup row's columns are kept.
  assert.deepEqual(saved, { version: records.DATA_VERSION, records: [], dismissed: [], sessions: [{ form: "ticket", at: NOW, values: { category: "Refund", priority: "P2", customer: "Mary Jones", email: "mary.jones@example.com", sla: "48" } }] });
  assert.equal(fs.readFileSync(path.join(dataDir, "apps", "forms.json"), "utf8").includes(REASON), false, "the answer typed into the popover never reaches apps/forms.json");
  assert.deepEqual(assistant.usageReport().byShortcut.map((s) => [s.kind, s.trigger, s.inserts]), [["form", "refund-case", 1]]);
  const merged = report.mergeReports([assistant.usageReport()], { organizationShortcuts: report.organizationShortcuts(assistant.policy()) });
  assert.deepEqual(merged.unused.filter((u) => u.kind === "form").map((u) => u.trigger), ["complaint", "address-change"], "organizationItems names the records never filled");

  // A typed reference costs keystrokes; a palette pick carries its own; no form means no stored fill.
  const palette = state(app.palette.choose({ kind: "app:forms", trigger: "form:address-change", query: "addr", spentKeystrokes: 5 }));
  assert.equal(palette.backspaces, 0);
  const second = await submit(palette, { reference: "a-54321", answers: { address: "1 Main St" } }, shell);
  assert.equal(second.ok, true);
  assert.equal(second.form, "ticket", "the palette pick uses the form of the window last focused");
  assert.equal(second.fields, 5, "category, priority, notes from the record; customer, email from the row; sla is not in the record");
  assert.deepEqual(shell.calls.keys.slice(12), ["close popover", "paste \"Account\"", "tab", "paste \"P3\"", "tab", "paste \"John Smith\"", "tab", "paste \"john.smith@example.com\"", "tab x2", "paste \"New delivery address for John Smith: 1 Main St\""], "SLA hours has no value: Tab twice to reach the note");
  const last = assistant.ledger.entries().pop();
  assert.equal(last.keystrokesSaved, metrics.graphemes(["Account", "P3", "John Smith", "john.smith@example.com", "New delivery address for John Smith: 1 Main St"].join("\n")) - 5 - 7 - 9);
  open(assistant, NOTEPAD, "");
  const plain = state(app.palette.choose({ kind: "app:forms", trigger: "cmp/", query: "", spentKeystrokes: 1 }));
  assert.equal(plain.formId, null);
  const third = await submit(plain, { reference: "A-10021", answers: { summary: "Box dented" } }, shell);
  assert.equal(third.ok, true);
  assert.equal(third.form, null);
  assert.equal(stored(dataDir).sessions.length, 2, "a fill with no matched form is counted but not stored for learning");

  // A gap before the first value: the typed trigger is deleted on its own, then Tab reaches the field.
  const gaps = desk({ forms: withRecords([{ id: "note-only", trigger: "note/", fields: { notes: "Just a note" } }]) });
  const quiet = asyncShell("");
  const [noteOnly] = open(gaps.assistant, TICKET, "note/");
  assert.equal((await gaps.submit(state(noteOnly), {}, quiet)).ok, true);
  assert.deepEqual(quiet.calls.keys, ["close popover", "backspace x5", "tab x5", "paste \"Just a note\""]);
  assert.deepEqual(quiet.calls.replaced, [{ backspaces: 5, text: "", cursorOffset: 0 }, { backspaces: 0, text: "Just a note", cursorOffset: 11 }]);

  // Electron's shell has no settle(): the first key waits for the focus to return to the form.
  const slow = asyncShell("");
  delete slow.settle;
  const pending = gaps.submit(state(noteOnly), {}, slow);
  assert.equal(slow.calls.closed, 1, "closed at once");
  assert.deepEqual(slow.calls.replaced, [], "nothing typed before the pause");
  assert.equal((await pending).ok, true);
  assert.equal(slow.calls.replaced.length, 2);
});

test("secrets never reach the stored fills, a failed keystroke stops the fill for good and records nothing, and a form without the record's fields is refused", async () => {
  const section = {
    records: [{ id: "login", trigger: "login/", fields: { user: "svc-account", password: "hunter2", note: "card 4111 1111 1111 1111 on file", memo: "token: abc" } }, { id: "lonely", trigger: "lonely/", fields: { nothing: "x" } }, { id: "late", trigger: "late/", fields: { memo: "last" } }],
    forms: [{ id: "portal", match: { process: "portal" }, fields: [{ name: "user", selector: "a" }, { name: "password", selector: "b" }, { name: "note", selector: "c" }, { name: "memo", selector: "d" }] }],
  };
  const { assistant, dataDir, submit } = desk({ forms: section });
  const shell = asyncShell("");
  const [action] = open(assistant, PORTAL, "login/");
  const result = await submit(state(action), { answers: {} }, shell);
  assert.equal(result.ok, true);
  assert.equal(result.fields, 4);
  assert.deepEqual(stored(dataDir).sessions[0].values, { user: "svc-account" }, "the password field by name, the card and the labelled token by the scrubber");
  const auditText = fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8");
  assert.equal(auditText.includes("hunter2") || auditText.includes("4111"), false);

  const [lonely] = open(assistant, PORTAL, "lonely/");
  assert.deepEqual(lonely.plan.steps, []);
  assert.deepEqual(await submit(state(lonely), {}, shell), { ok: false, error: "Nothing to fill: the form portal has none of this record's fields." });

  const failing = asyncShell("");
  failing.sender.press = () => Promise.resolve({ ok: false, error: "xdotool is not installed" });
  const [again] = open(assistant, PORTAL, "login/");
  const refused = await submit(state(again), {}, failing);
  assert.deepEqual(refused, { ok: false, error: "Could not move to password (2 of 4): xdotool is not installed. The fields before it were filled; the rest was not.", close: true }, "close: the popover is gone, so no retry can type the first value again");
  assert.equal(failing.calls.replaced.length, 1);
  assert.deepEqual(failing.calls.notified, [refused.error], "told through a notification, since the popover closed before typing");
  const broken = asyncShell("");
  broken.sender.replace = () => Promise.resolve({ ok: false });
  assert.deepEqual(await submit(state(again), {}, broken), { ok: false, error: "Could not fill user (1 of 4).", close: true });
  const [lateOnly] = open(assistant, PORTAL, "late/");
  assert.deepEqual(await submit(state(lateOnly), {}, broken), { ok: false, error: "Could not delete the trigger before memo (1 of 1).", close: true });
  assert.equal(assistant.ledger.entries().length, 1, "only the complete fill is counted");
  assert.equal(stored(dataDir).sessions.length, 1);
  const thrown = asyncShell("");
  thrown.sender.replace = () => Promise.reject(new Error("boom"));
  await assert.rejects(submit(state(again), {}, thrown), /boom/, "main.js turns a throw into a refusal");
  const unreadable = asyncShell("");
  unreadable.clipboard.readText = () => { throw new Error("no clipboard"); };
  assistant.app("forms").onStart(unreadable);
  assert.equal(open(assistant, { process: "portal.exe" }, "login/")[0].reference, "", "a clipboard that cannot be read counts as empty");
});

test("the palette lists every record under its trigger or form:id, and a choice opens the plan without deleting anything", () => {
  const { assistant, app } = desk();
  assistant.focusChanged(TICKET);
  const found = assistant.paletteSearch("refund");
  assert.deepEqual(found.map((i) => [i.kind, i.trigger, i.source]), [["app:forms", "refund/", "organization"]]);
  assert.match(found[0].preview, /^Refund case: category = Refund; priority = P2/);
  assert.deepEqual(assistant.paletteSearch("address").map((i) => i.trigger), ["form:address-change"], "a record without a trigger is found by its label");
  assert.deepEqual(assistant.paletteSearch("Account").map((i) => i.trigger), ["form:address-change"], "and by a field value");
  const action = assistant.paletteChoose({ kind: "app:forms", trigger: "form:address-change", query: "address" });
  assert.equal(action.type, "app");
  assert.equal(action.popover, "plan");
  assert.equal(action.recordId, "address-change");
  assert.equal(action.formId, "ticket");
  assert.equal(action.backspaces, 0);
  assert.equal(action.spentKeystrokes, 8, "the query and Enter");
  assert.equal(action.via, "palette");
  assert.equal(action.trigger, "form:address-change");
  assert.equal(assistant.paletteChoose({ kind: "app:forms", trigger: "nope", query: "" }), null);
  assert.equal(app.palette.choose(null), null);
});

test("three similar fills become a proposal; accepted it is an own record with a trigger the engine fires, dismissed it stays away, deleted it is gone", async () => {
  const notes = { documents: [{ id: "minutes", trigger: "/mins", label: "Meeting minutes", sections: [{ heading: "Details" }] }] };
  const { assistant, app, dataDir, submit } = desk({ notes });
  assert.deepEqual(assistant.policy().notes.documents.map((d) => d.trigger), ["/mins"]);
  for (const reference of ["A-12345", "A-54321", "A-10021"]) {
    const shell = asyncShell("order " + reference);
    app.onStart(shell);
    const [action] = open(assistant, TICKET, "refund/");
    assert.equal(action.reference, reference);
    assert.equal((await submit(state(action), { reference, answers: { reason: REASON } }, shell)).ok, true);
  }
  assert.deepEqual(assistant.invoke("forms:info").proposals.map((p) => [p.form, p.count, p.constant, p.templated]), [["ticket", 3, ["category", "priority", "sla"], ["email"]]], "the note held the typed reason, so it was never stored and is not learned");
  const [proposal] = assistant.invoke("forms:info").proposals;
  assert.match(proposal.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(proposal.fields, { category: "Refund", priority: "P2", sla: "48", email: "[[email]]" });
  assert.equal(proposal.label, "Learned record 1 on Support ticket", "a number and the policy's form label, never a learned value");

  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "" }), { ok: false, error: "Enter a trigger to type for this record." });
  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "two words" }), { ok: false, error: "A trigger has no spaces." });
  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "x".repeat(records.MAX_TRIGGER + 1) }), { ok: false, error: "A trigger has at most " + records.MAX_TRIGGER + " characters." });
  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "refund/" }), { ok: false, error: "The trigger refund/ is already used by the record Refund case." });
  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "sig/" }), { ok: false, error: "The trigger sig/ is already used by the shortcut sig/." });
  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "/sld" }), { ok: false, error: "The trigger /sld is already used by the document set /sld." });
  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "/mins" }), { ok: false, error: "The trigger /mins is already used by the notes document Meeting minutes." }, "Forms sits before Notes in the registry: its trigger would hide the document");
  assert.deepEqual(assistant.invoke("forms:acceptProposal", { digest: "sha256:0", trigger: "ok/" }), { ok: false, error: "This proposal has changed. Look at the cactle tab again." });
  assert.equal(stored(dataDir).records.length, 0);

  const unlabelled = assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "r3/" });
  assert.deepEqual(unlabelled.record, { id: "own-" + proposal.digest.slice(7, 15), label: "Learned record 1 on Support ticket", trigger: "r3/" }, "without a label the proposal's own is kept");
  assert.equal(stored(dataDir).records[0].label, "Learned record 1 on Support ticket");
  assert.equal(assistant.invoke("forms:deleteOwnRecord", { id: unlabelled.record.id }).ok, true);

  const accepted = assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: " refund2/ ", label: "Refund with apology" });
  assert.deepEqual(accepted, { ok: true, record: { id: "own-" + proposal.digest.slice(7, 15), label: "Refund with apology", trigger: "refund2/" }, broadcast: { apps: true } });
  const own = stored(dataDir).records[0];
  assert.deepEqual(own, { id: accepted.record.id, label: "Refund with apology", trigger: "refund2/", fields: proposal.fields, form: "ticket", acceptedAt: NOW });
  assert.deepEqual(assistant.invoke("forms:info").proposals, [], "an accepted proposal is a known record now");
  assert.deepEqual(assistant.invoke("forms:info").ownRecords.map((r) => [r.id, r.trigger, r.own, r.blanks]), [[own.id, "refund2/", true, ["email"]]]);
  assert.equal(assistant.audit().pop().event, "form-record-accepted");
  const [fired] = open(assistant, TICKET, "see refund2/");
  assert.equal(fired.recordId, own.id);
  assert.equal(fired.backspaces, 8);
  assert.deepEqual(fired.record, { id: own.id, label: "Refund with apology", own: true, blanks: ["email"] });
  assert.equal(fired.reference, "A-10021", "the last shell's clipboard");
  assert.deepEqual(fired.plan.missing, [], "the row filled the learned email blank");
  assert.deepEqual(assistant.paletteSearch("apology").map((i) => [i.trigger, i.source]), [["refund2/", "personal"]]);
  const shell = asyncShell("");
  const filled = await submit(state(fired), { reference: "A-10021", answers: {} }, shell);
  assert.equal(filled.ok, true);
  assert.deepEqual(shell.calls.notified, ["Filled 5 fields."], "an own record's label (typed or learned) never reaches a system notification");
  assert.equal(assistant.ledger.entries().pop().trigger, formsApp.OWN_TRIGGER, "an own record's fill is counted under one shared name");
  assert.equal(assistant.ledger.entries().pop().source, "organization", "the engine attributes form inserts to the organisation");
  assert.equal(JSON.stringify(assistant.usageReport()).includes(own.id), false, "no desk-local record id in the usage report");
  assert.equal(assistant.audit().filter((e) => e.event === "form-filled").pop().record, own.id, "the local audit file names it");

  // A policy record that later takes the same trigger wins; the own record stays usable from the palette.
  const clashing = desk({ forms: withRecords([{ id: "late", trigger: "refund2/", fields: { category: "Late" } }, { id: own.id, fields: { a: "b" } }]) });
  const data = records.normalizeData({ records: [own, { id: "own-other", trigger: "late/", fields: { x: "1" } }, { id: "bad" }] });
  fs.mkdirSync(path.join(clashing.dataDir, "apps"), { recursive: true });
  fs.writeFileSync(path.join(clashing.dataDir, "apps", "forms.json"), JSON.stringify(data));
  const info = clashing.assistant.invoke("forms:info");
  assert.deepEqual(info.warnings, ["own form record bad ignored: no fields", "own record " + own.id + " ignored: a policy record has this id"]);
  assert.deepEqual(info.ownRecords.map((r) => [r.id, r.trigger]), [["own-other", "late/"]]);
  assert.equal(open(clashing.assistant, TICKET, "refund2/")[0].recordId, "late");
  const twice = desk();
  fs.mkdirSync(path.join(twice.dataDir, "apps"), { recursive: true });
  fs.writeFileSync(path.join(twice.dataDir, "apps", "forms.json"), JSON.stringify({ records: [own, { id: "own-2", trigger: "refund2/", fields: { x: "1" } }, { id: "own-3", trigger: "refund/", fields: { x: "1" } }] }));
  const twiceInfo = twice.assistant.invoke("forms:info");
  assert.deepEqual(twiceInfo.warnings, ["own form record own-2 trigger refund2/ ignored: duplicate trigger", "own record own-3 trigger refund/ ignored: a policy record has this trigger"]);
  assert.deepEqual(twiceInfo.ownRecords.map((r) => [r.id, r.trigger]), [[own.id, "refund2/"], ["own-2", null], ["own-3", null]]);

  assert.deepEqual(assistant.invoke("forms:deleteOwnRecord", { id: "refund-case" }), { ok: false, error: "This record is not one of yours." });
  assert.deepEqual(assistant.invoke("forms:deleteOwnRecord", { id: own.id }), { ok: true, broadcast: { apps: true } });
  assert.deepEqual(stored(dataDir).records, []);
  assert.equal(assistant.audit().pop().event, "form-record-deleted");
  assert.deepEqual(open(assistant, TICKET, "refund2/"), [], "the deleted record's trigger is gone");
  const back = assistant.invoke("forms:info").proposals;
  assert.equal(back.length, 1, "without the record the proposal is back");
  assert.deepEqual(assistant.invoke("forms:dismissProposal", { digest: "nope" }), { ok: false, error: "No proposal given." });
  assert.deepEqual(assistant.invoke("forms:dismissProposal", { digest: back[0].digest }), { ok: true, broadcast: { apps: true } });
  assistant.invoke("forms:dismissProposal", { digest: back[0].digest });
  assert.deepEqual(stored(dataDir).dismissed, [back[0].digest], "remembered once, as a digest");
  assert.deepEqual(assistant.invoke("forms:info").proposals, []);
  assert.equal(JSON.stringify(stored(dataDir).dismissed).includes("Refund"), false);
  assert.deepEqual(assistant.invoke("forms:clearSessions"), { ok: true, removed: 4, broadcast: { apps: true } }, "three sample fills and the own record's");
  assert.deepEqual(stored(dataDir).sessions, []);
  assert.equal(assistant.audit().pop().event, "form-sessions-cleared");
});

test("the records module: data cleaning, the session cap, digests, secret names as whole words and trigger checks", () => {
  assert.deepEqual(records.normalizeData(null), { version: records.DATA_VERSION, records: [], sessions: [], dismissed: [] });
  assert.deepEqual(records.normalizeData({ records: "x", sessions: [{ form: "", values: {} }, { form: "t", values: { a: "1" } }, 7], dismissed: ["plain", "sha256:ab"] }), { version: 1, records: [], sessions: [{ form: "t", values: { a: "1" } }], dismissed: ["sha256:ab"] });
  const many = Array.from({ length: records.MAX_SESSIONS }, (_, i) => ({ form: "t", values: { n: String(i) }, at: i }));
  const capped = records.addSession(many, { form: "t", values: { n: "new" }, at: 1 });
  assert.equal(capped.length, records.MAX_SESSIONS);
  assert.equal(capped[0].values.n, "1", "the oldest fill goes");
  assert.equal(capped[capped.length - 1].values.n, "new");
  assert.deepEqual(records.sessionFrom(" ticket ", { a: " 1 ", b: "", "": "x", PIN: "1234", userPin: "9", "api-key": "k", newPassword: "p", c: "password: hunter2", d: "4111 1111 1111 1111", shippingAddress: "1 Main St", spinner: "on", secretary: "Jo" }, "7"), { form: "ticket", values: { a: "1", shippingAddress: "1 Main St", spinner: "on", secretary: "Jo" }, at: 7 });
  for (const name of ["PIN", "pin_code", "cardPIN", "otp", "Secret answer", "api key", "apiKey", "passwd", "token", "password2", "pin1", "OTP-code", "passphrase", "secret"]) assert.equal(records.isSecretField(name), true, name);
  for (const name of ["shipping", "spinner", "tokenizer", "secretary", "Secretariat", "notes", "pinned", "", null]) assert.equal(records.isSecretField(name), false, String(name));
  assert.equal(records.digest("ticket", { b: "2", a: 1 }), records.digest("ticket", { a: "1", b: "2" }), "field order does not matter");
  assert.notEqual(records.digest("ticket", { a: "1" }), records.digest("crm", { a: "1" }));
  assert.deepEqual(records.checkTrigger(" ok/ ", [{ trigger: "x", what: "y" }]), { ok: true, trigger: "ok/" });
  assert.equal(records.checkTrigger("x", [{ trigger: "x", what: "the record X" }]).error, "The trigger x is already used by the record X.");
  assert.equal(records.checkTrigger("x".repeat(records.MAX_TRIGGER), []).ok, true);
  assert.deepEqual(records.mergeRecords(null, null), { records: [], warnings: [] });
  const sessions = [{ form: "t", values: { a: "1", b: "2" } }, { form: "t", values: { a: "1", b: "2" } }, { form: "t", values: { a: "1", b: "2" } }];
  assert.equal(records.proposals({ sessions, dismissed: [] }, []).length, 1);
  assert.equal(records.proposals({ sessions, dismissed: [] }, [{ id: "k", fields: { b: "2", a: "1" } }]).length, 0, "a known record is not proposed");
  assert.equal(records.proposals({ sessions, dismissed: [records.digest("t", { a: "1", b: "2" })] }, []).length, 0, "a dismissed one neither");
});

test("the records module: bank, identity and credential names, Guard's value detectors, the policy's own values and retention", () => {
  for (const name of ["pass", "userPass", "credential", "credentials", "cvv", "cvv2", "cardCvc", "iban", "payeeIBAN", "bic", "ssn", "nino", "dni", "nir"]) assert.equal(records.isSecretField(name), true, name);
  for (const name of ["passenger", "compass", "bicycle", "nirvana", "notes", "customer"]) assert.equal(records.isSecretField(name), false, name);
  const values = { a: "Mary Jones", iban: "x", bank: "Pay to DE89 3704 0044 0532 0130 00 today", ssn2: "1", tax: "SSN 078-05-1120", ni: "AB 12 34 56 C", dni: "12345678Z", ref: "ok", card: "4111 1111 1111 1111", note: "token: abc" };
  assert.deepEqual(records.sessionFrom("f", values, 1).values, { a: "Mary Jones", ref: "ok" });
  for (const text of ["DE89 3704 0044 0532 0130 00", "078-05-1120", "AB 12 34 56 C", "4111 1111 1111 1111", "password is hunter2"]) assert.equal(records.isSensitiveValue(text), true, text);
  for (const text of ["Mary Jones", "mary.jones@example.com", "48", "A-12345", "P2"]) assert.equal(records.isSensitiveValue(text), false, text);

  const record = { fields: { category: "Refund", notes: "Hi [[customer]]. [[reason]]", greeting: "Dear [[customer]]", memo: "PIN [[pin]]" } };
  const steps = [
    { field: "category", value: "Refund", source: "record" },
    { field: "notes", value: "Hi Mary. Sorry", source: "record" },
    { field: "greeting", value: "Dear Mary", source: "record" },
    { field: "memo", value: "PIN 1234", source: "record" },
    { field: "customer", value: "Mary", source: "values" },
    { field: "reason", value: "Sorry", source: "values" },
  ];
  assert.deepEqual(records.policyValues(record, steps, { reason: "Sorry" }), { category: "Refund", greeting: "Dear Mary", customer: "Mary" }, "a step with the typed answer goes, so does one built on a secret blank");
  assert.deepEqual(records.policyValues(record, steps, { reason: "Sorry", customer: "Mary" }), { category: "Refund" });
  assert.deepEqual(records.policyValues(null, null, null), {});

  const day = 86400000;
  const list = [{ at: 1000 * day }, { at: 1090 * day }, { at: 1095 * day }, {}];
  assert.deepEqual(records.pruneSessions(list, 1100 * day, 10), [{ at: 1090 * day }, { at: 1095 * day }], "older than the days, and undated, go");
  assert.equal(records.pruneSessions(list, 1100 * day, 0), list, "no positive number of days keeps them all");
  assert.equal(records.pruneSessions(list, 1100 * day, undefined), list);
});

test("the records module leaves card numbers, labelled secrets and tokens to the scrubber: whatever Guard's card-number or secret detector flags, the scrubber masks", () => {
  const guard = require("../core/guard.js");
  const capture = require("../core/capture-policy.js");
  // Deterministic strings, each one candidate (a card-like digit run, a secret label with a separator and a value, a token-like run of 20 to 30
  // characters) between harmless words and the characters the patterns look behind and ahead at: one finding per string, so no other part masks it.
  let seed = 7;
  // The high bits: an LCG's low bits repeat with a period of 2 or 4, which would leave whole combinations out.
  const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
  const pick = (list) => list[next(list.length)];
  const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  const harmless = () => pick(["hunter2", "x", "Mary", "A-12345", "order", "the", " ", "/", "@", ".", "-", "\n", ",", "7"]);
  const candidates = [
    () => pick(["4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "378282246310005", "5500 0000 0000 0004", "4111 1111 1111 1112"]),
    () => Array.from({ length: 13 + next(7) }, () => String(next(10))).join(pick(["", " ", "-"])),
    () => pick(["password", "Passwd", "PIN", "pwd", "secret", "token", "api key", "API-KEY", "apikey", "otp", "passcode", "passphrase"]) + pick([": ", "=", " is ", " ", ":", " = ", "-", " - ", "", "\t"]) + pick(["hunter2", "x", "1234", "s3cr3t!", "[x]"]),
    () => Array.from({ length: 20 + next(11) }, () => ALNUM[next(ALNUM.length)]).join(""),
  ];
  let flagged = 0;
  for (let i = 0; i < 6000; i++) {
    const around = () => Array.from({ length: next(3) }, harmless).join("");
    const text = around() + candidates[next(candidates.length)]() + around();
    if (guard.DETECTORS["card-number"](text, {}).length + guard.DETECTORS.secret(text, {}).length === 0) continue;
    flagged += 1;
    assert.ok(capture.scrub(text).redactions > 0, "Guard flags it and the scrubber does not: " + JSON.stringify(text));
    assert.equal(records.isSensitiveValue(text), true, text);
  }
  assert.ok(flagged > 1500, "the strings exercise both detectors (" + flagged + " flagged)");
});

test("a stored fill keeps only what came from the policy: an answer typed into the popover (for an organisation record or an own one), a typed customer and a note carrying an answer never reach apps/forms.json", async () => {
  const { assistant, app, dataDir, submit } = desk();
  const DISCLOSED = "Customer disclosed a diagnosis on the call, marker 4711";
  const shell = asyncShell(CLIPBOARD);
  app.onStart(shell);
  const [refund] = open(assistant, TICKET, "refund/");
  assert.equal((await submit(state(refund), { reference: "A-12345", answers: { reason: DISCLOSED } }, shell)).ok, true);
  assert.equal(shell.calls.replaced.pop().text, "Hi Mary Jones, the refund for order A-12345 is on its way. " + DISCLOSED, "the answer is typed into the form");
  // A customer typed for a blank the lookup row would have filled goes into a form field straight from the answer.
  const picked = state(app.palette.choose({ kind: "app:forms", trigger: "form:address-change", query: "", spentKeystrokes: 0 }));
  assert.equal((await submit(picked, { reference: "", answers: { customer: "Lee Park", address: "12 Elm Street" } }, asyncShell(""))).ok, true);
  const [complaint] = open(assistant, TICKET, "cmp/");
  assert.equal((await submit(state(complaint), { reference: "A-54321", answers: { summary: "Box dented, she is pregnant" } }, asyncShell(""))).ok, true);
  const text = fs.readFileSync(path.join(dataDir, "apps", "forms.json"), "utf8");
  for (const typed of ["4711", "disclosed", "Lee Park", "Elm Street", "pregnant"]) assert.equal(text.includes(typed), false, typed + " was typed into the popover");
  assert.deepEqual(stored(dataDir).sessions.map((s) => s.values), [
    { category: "Refund", priority: "P2", customer: "Mary Jones", email: "mary.jones@example.com", sla: "48" },
    { category: "Account", priority: "P3" },
    { category: "Complaint", priority: "P1", customer: "John Smith", email: "john.smith@example.com", sla: "24" },
  ], "the record's constants and the lookup row's columns, which the policy already holds");
  const tried = assistant.invoke("forms:plan", { recordId: "refund-case", formId: "ticket", reference: "A-12345", answers: { reason: "x" } });
  assert.equal(Object.hasOwn(tried, "learnable"), false, "what a fill would store is not handed to a page");

  // An own record's blank answered in the popover: typed into the form, never stored.
  const mine = desk();
  fs.mkdirSync(path.join(mine.dataDir, "apps"), { recursive: true });
  fs.writeFileSync(path.join(mine.dataDir, "apps", "forms.json"), JSON.stringify({ records: [{ id: "own-1", label: "Mine", trigger: "mine/", fields: { category: "Refund", priority: "P2", notes: "Called about [[topic]]" } }] }));
  const ownShell = asyncShell("");
  mine.app.onStart(ownShell);
  const [ownAction] = open(mine.assistant, TICKET, "mine/");
  assert.deepEqual(ownAction.record, { id: "own-1", label: "Mine", own: true, blanks: ["topic"] });
  assert.equal((await mine.submit(state(ownAction), { reference: "", answers: { topic: "her HIV test result" } }, ownShell)).ok, true);
  assert.equal(ownShell.calls.replaced.pop().text, "Called about her HIV test result", "the answer is typed into the form");
  assert.deepEqual(stored(mine.dataDir).sessions.map((s) => s.values), [{ category: "Refund", priority: "P2" }], "the own record's constants only");
  assert.equal(fs.readFileSync(path.join(mine.dataDir, "apps", "forms.json"), "utf8").includes("HIV"), false);
});

test("expired fills also go at the first read, and a write that fails there is logged, never thrown out of the keystroke hook, the dashboard or the start", () => {
  const DAY = 86400000;
  const parsed = orgPolicy.parse({ forms: SAMPLE });
  assert.equal(parsed.retention.corpusDays, 90);
  const file = { sessions: [{ form: "ticket", values: { category: "Old" }, at: NOW - 400 * DAY }, { form: "ticket", values: { category: "Recent" }, at: NOW - DAY }] };
  const categories = (data) => data.sessions.map((s) => s.values.category);
  const make = (save) => {
    const logs = [];
    const host = { policy: () => parsed, engine: { library: [] }, now: () => NOW, log: (line) => logs.push(line), audit: () => {}, recordInsert: () => ({ keystrokesSaved: 0 }), appData: () => ({ load: () => JSON.parse(JSON.stringify(file)), save }) };
    return { app: formsApp.createApp(host), logs };
  };
  // A desk that can write: the first keystroke's read takes the expired fill out of the file.
  const written = [];
  const ok = make((value) => written.push(JSON.parse(JSON.stringify(value))));
  assert.equal(ok.app.extension.trigger("hello r"), null);
  assert.deepEqual(written.map(categories), [["Recent"]]);
  // A full disk: the key goes on, the read works on the pruned list, the log says why, and the next write carries the pruned list.
  let attempts = 0;
  const saved = [];
  const full = make((value) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    saved.push(JSON.parse(JSON.stringify(value)));
  });
  assert.equal(full.app.extension.trigger("hello r"), null, "no throw out of the keystroke hook");
  assert.equal(full.app.extension.trigger("hello re"), null);
  assert.equal(full.app.ipc["forms:info"]().sessions, 1, "the dashboard sees the pruned list");
  assert.equal(attempts, 1, "tried once, not on every key");
  assert.deepEqual(full.logs, ["forms: expired stored fills could not be removed from the file: ENOSPC: no space left on device"]);
  assert.equal(full.app.ipc["forms:dismissProposal"]({ digest: "sha256:0" }).ok, true);
  assert.deepEqual(saved.map(categories), [["Recent"]], "the next write leaves the expired fill out");
  // The same at start, and on the dashboard's first read.
  const readOnly = () => { throw new Error("EROFS: read-only file system"); };
  const started = make(readOnly);
  assert.doesNotThrow(() => started.app.onStart({}));
  assert.equal(started.logs.length, 1);
  const shown = make(readOnly);
  assert.equal(shown.app.ipc["forms:info"]().sessions, 1);
  assert.equal(shown.logs.length, 1);
});

test("stored fills older than retention.corpusDays go at start and at every fill, and \"Delete learned text\" deletes them", async () => {
  let clock = NOW;
  const DAY = 86400000;
  const { assistant, app, dataDir, submit } = desk({ retention: { corpusDays: 30 } }, { now: () => clock });
  fs.mkdirSync(path.join(dataDir, "apps"), { recursive: true });
  const own = { id: "own-1", label: "Mine", trigger: "mine/", fields: { category: "Refund", priority: "P2" } };
  fs.writeFileSync(path.join(dataDir, "apps", "forms.json"), JSON.stringify({ records: [own], sessions: [{ form: "ticket", values: { category: "Old" }, at: NOW - 100 * DAY }, { form: "ticket", values: { category: "Recent" }, at: NOW - 10 * DAY }, { form: "ticket", values: { category: "Undated" } }] }));
  app.onStart(asyncShell(""));
  assert.deepEqual(stored(dataDir).sessions.map((s) => s.values.category), ["Recent"], "the expired fills left the file when the shell started the app, before any keystroke or dashboard read");
  const info = assistant.invoke("forms:info");
  assert.equal(info.sessions, 1);
  assert.equal(info.retentionDays, 30);
  clock = NOW + 25 * DAY;
  const shell = asyncShell(CLIPBOARD);
  app.onStart(shell);
  const [action] = open(assistant, TICKET, "refund/");
  assert.equal((await submit(state(action), { reference: "A-12345", answers: { reason: REASON } }, shell)).ok, true);
  assert.deepEqual(stored(dataDir).sessions.map((s) => [s.values.category, s.at]), [["Refund", clock]], "35 days old by now: gone with the new fill");

  const result = assistant.clearLearning();
  assert.equal(result.sessions, 0);
  assert.deepEqual(stored(dataDir).sessions, [], "the Learning tab's \"Delete learned text\" reaches the Forms fills");
  assert.deepEqual(stored(dataDir).records.map((r) => r.id), ["own-1"], "own records are the person's, not learned text: they stay");
  assert.deepEqual(assistant.audit().filter((e) => e.event === "form-sessions-cleared").map((e) => e.sessions), [1]);
  app.onClearLearning();
  assert.deepEqual(assistant.audit().filter((e) => e.event === "form-sessions-cleared").length, 1, "nothing to delete: no write, no audit line");
  const fresh = desk();
  fresh.assistant.clearLearning();
  assert.equal(fs.existsSync(path.join(fresh.dataDir, "apps", "forms.json")), false, "a desk that never stored a fill gets no file");
});

test("bank details, identity numbers and credentials from the policy never reach the stored fills, by field name, by blank name or by what the value holds", async () => {
  const row = { ref: "S-1", name: "Ann Lee", iban: "DE89 3704 0044 0532 0130 00", account: "DE89 3704 0044 0532 0130 00", taxId: "078-05-1120", insurance: "AB 12 34 56 C", credentials: "Hunter2!", pass: "Hunter2!", cvv: "737", password: "Hunter2!" };
  const fields = ["name", "iban", "account", "taxId", "insurance", "credentials", "pass", "cvv", "note", "memo"];
  const section = {
    records: [{ id: "onboard", trigger: "onb/", fields: { note: "Salary to [[account]] for [[name]]", memo: "Temporary password for [[name]]: [[password]]" } }],
    lookups: [{ id: "staff", key: "ref", rows: [row] }],
    forms: [{ id: "hr", match: { process: "hr" }, fields: fields.map((name) => ({ name, selector: name })) }],
  };
  const { assistant, dataDir, submit } = desk({ forms: section });
  const [action] = open(assistant, { process: "hr.exe", title: "Onboarding" }, "onb/");
  const result = await submit(state(action), { reference: "S-1", answers: {} }, asyncShell(""));
  assert.equal(result.fields, 10, "every value is typed into the form");
  assert.deepEqual(stored(dataDir).sessions[0].values, { name: "Ann Lee" }, "iban, credentials, pass and cvv by name; the IBAN, the SSN and the NI number by Guard's detectors; the memo by its [[password]] blank");
  const text = fs.readFileSync(path.join(dataDir, "apps", "forms.json"), "utf8");
  for (const value of ["DE89", "078-05", "AB 12", "Hunter2", "737"]) assert.equal(text.includes(value), false, value);
});

test("a learned proposal is labelled by number and form, and an own record's fill notifies a count only, never a learned or typed label", async () => {
  const section = withRecords([{ id: "legal", label: "Legal matter", trigger: "legal/", fields: { category: "Legal", priority: "P1" } }]);
  const { assistant, app, submit } = desk({ forms: section });
  const notified = [];
  for (let i = 0; i < 3; i++) {
    const shell = asyncShell("order A-12345");
    app.onStart(shell);
    const [action] = open(assistant, TICKET, "legal/");
    assert.equal((await submit(state(action), { reference: "A-12345", answers: {} }, shell)).ok, true);
    notified.push(...shell.calls.notified);
  }
  assert.deepEqual(notified, Array.from({ length: 3 }, () => "Filled 4 fields of Legal matter."), "the organisation's record is named by its policy label");
  const [proposal] = assistant.invoke("forms:info").proposals;
  assert.deepEqual(proposal.constant, ["category", "customer", "email", "priority"], "the same customer three times");
  assert.equal(proposal.label, "Learned record 1 on Support ticket");
  assert.equal(/Mary|Legal|P1/.test(proposal.label), false, "no learned value in the label");
  const accepted = assistant.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: "mj/", label: "" });
  assert.equal(accepted.record.label, "Learned record 1 on Support ticket");
  const shell = asyncShell("");
  const [own] = open(assistant, TICKET, "mj/");
  assert.equal((await submit(state(own), { reference: "", answers: {} }, shell)).ok, true);
  assert.deepEqual(shell.calls.notified, ["Filled 4 fields."]);
  const renamed = desk({ forms: section });
  fs.mkdirSync(path.join(renamed.dataDir, "apps"), { recursive: true });
  fs.writeFileSync(path.join(renamed.dataDir, "apps", "forms.json"), JSON.stringify({ records: [{ id: "own-x", label: "my divorce lawyer note", trigger: "dl/", fields: { category: "Legal", notes: "x" } }] }));
  const other = asyncShell("");
  const [named] = open(renamed.assistant, TICKET, "dl/");
  assert.equal((await renamed.submit(state(named), {}, other)).ok, true);
  assert.deepEqual(other.calls.notified, ["Filled 2 fields."], "a label the person typed never reaches a system notification either");
});

test("proposals accepted under their default labels keep distinct names", async () => {
  const section = withRecords([{ id: "legal", label: "Legal matter", trigger: "legal/", fields: { category: "Legal", priority: "P1" } }, { id: "hr", label: "HR matter", trigger: "hr/", fields: { category: "HR", priority: "P4" } }]);
  const { assistant, app, submit } = desk({ forms: section });
  for (let i = 0; i < 3; i++) {
    for (const trigger of ["legal/", "hr/"]) {
      const shell = asyncShell("order A-12345");
      app.onStart(shell);
      const [action] = open(assistant, TICKET, trigger);
      assert.equal((await submit(state(action), { reference: "A-12345", answers: {} }, shell)).ok, true);
    }
  }
  const before = assistant.invoke("forms:info").proposals;
  assert.deepEqual(before.map((p) => p.label), ["Learned record 1 on Support ticket", "Learned record 2 on Support ticket"]);
  assert.equal(assistant.invoke("forms:acceptProposal", { digest: before[0].digest, trigger: "x1/", label: before[0].label }).ok, true);
  const [second] = assistant.invoke("forms:info").proposals;
  assert.equal(second.digest, before[1].digest);
  assert.equal(second.label, "Learned record 2 on Support ticket", "the number an own record holds is not offered again");
  assert.equal(assistant.invoke("forms:acceptProposal", { digest: second.digest, trigger: "x2/", label: second.label }).ok, true);
  assert.deepEqual(assistant.invoke("forms:info").ownRecords.map((r) => r.label), ["Learned record 1 on Support ticket", "Learned record 2 on Support ticket"]);
});

test("a plan popover opened before the organisation paused the desk fills nothing after the pause", async () => {
  const pair = signing.generateKeyPair();
  const URL = "https://intranet.example/org.signed.json";
  const layer = { layer: "org", serial: 1, organization: "Example Logistics", forms: SAMPLE };
  const served = { [URL]: JSON.stringify(signing.signPolicy(layer, pair.privateKey)) };
  const dataDir = temp();
  const assistant = createAssistant({ dataDir, now: () => NOW, appIds: ["forms"], deployment: { policySources: [{ layer: "org", label: "Organisation", url: URL }], publicKeys: [pair.publicKey] }, fetch: async (url) => ({ ok: true, status: 200, text: async () => served[url] }) });
  await assistant.refreshPolicy();
  const app = assistant.app("forms");
  const shell = asyncShell(CLIPBOARD);
  app.onStart(shell);
  const [action] = open(assistant, TICKET, "refund/");
  assert.equal(action.popover, "plan", "opened while the policy was live");
  served[URL] = JSON.stringify(signing.signPolicy(Object.assign({}, layer, { serial: 2, paused: { message: "Incident" } }), pair.privateKey));
  assert.equal((await assistant.refreshPolicy()).paused, true);
  const refused = await app.popovers.plan.submit(state(action), { reference: "A-12345", answers: { reason: REASON } }, shell);
  assert.deepEqual(refused, { ok: false, error: "Paused by your organisation." });
  assert.equal(formsApp.PAUSED, refused.error);
  assert.deepEqual(shell.calls.keys, [], "nothing typed, and the popover was not closed for a fill");
  assert.deepEqual(shell.calls.notified, []);
  assert.equal(assistant.ledger.entries().length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, "apps", "forms.json")), false, "nothing stored");
  assert.equal(assistant.audit().some((e) => e.event === "form-filled"), false);
});

test("a Fill whose pause arrives while the focus goes back to the form types nothing; a fill that has started typing finishes", async () => {
  const pair = signing.generateKeyPair();
  const URL = "https://intranet.example/org.signed.json";
  const layer = { layer: "org", serial: 1, organization: "Example Logistics", forms: SAMPLE };
  const served = { [URL]: JSON.stringify(signing.signPolicy(layer, pair.privateKey)) };
  const dataDir = temp();
  const assistant = createAssistant({ dataDir, now: () => NOW, appIds: ["forms"], deployment: { policySources: [{ layer: "org", label: "Organisation", url: URL }], publicKeys: [pair.publicKey] }, fetch: async (url) => ({ ok: true, status: 200, text: async () => served[url] }) });
  await assistant.refreshPolicy();
  let serial = 1;
  const setPaused = async (paused) => {
    serial += 1;
    served[URL] = JSON.stringify(signing.signPolicy(Object.assign({}, layer, { serial }, paused ? { paused: { message: "Incident" } } : {}), pair.privateKey));
    return (await assistant.refreshPolicy()).paused;
  };
  const app = assistant.app("forms");
  const shell = asyncShell(CLIPBOARD);
  app.onStart(shell);
  const [action] = open(assistant, TICKET, "refund/");
  // Electron's settle() waits for the focus to go back to the form; the pause lands meanwhile.
  shell.settle = () => setPaused(true);
  const result = await app.popovers.plan.submit(state(action), { reference: "A-12345", answers: { reason: REASON } }, shell);
  assert.deepEqual(result, { ok: false, error: "Paused by your organisation.", close: true });
  assert.deepEqual(shell.calls.keys, ["close popover"], "closed for the fill, then nothing typed");
  assert.deepEqual(shell.calls.notified, ["Paused by your organisation."], "the popover is gone, so a notification says why");
  assert.equal(assistant.ledger.entries().length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, "apps", "forms.json")), false, "nothing stored");
  assert.equal(assistant.audit().some((e) => e.event === "form-filled"), false);

  // Resumed: a pause that lands after the first key lets the fill finish, since half a form is worse.
  assert.equal(await setPaused(false), false);
  const typing = asyncShell(CLIPBOARD);
  app.onStart(typing);
  const [next] = open(assistant, TICKET, "refund/");
  const press = typing.sender.press;
  let pausing = null;
  typing.sender.press = (name, count) => {
    if (!pausing) pausing = setPaused(true);
    return pausing.then(() => press(name, count));
  };
  const finished = await app.popovers.plan.submit(state(next), { reference: "A-12345", answers: { reason: REASON } }, typing);
  assert.equal(await pausing, true, "paused during the fill");
  assert.equal(finished.ok, true);
  assert.equal(finished.fields, 6);
});

test("dashboard channels: info describes everything the tab shows, lookup and plan try without counting", () => {
  const { assistant, app } = desk();
  app.onFocus({ process: "C:\\Apps\\chrome.exe", title: "Zendesk: New Ticket #4" });
  const info = assistant.invoke("forms:info");
  assert.equal(info.configured, true);
  assert.equal(info.paused, false);
  assert.deepEqual(info.notes, { noForm: formsApp.NO_FORM_NOTE, selectors: formsApp.SELECTORS_NOTE });
  assert.deepEqual(info.records.map((r) => [r.id, r.label, r.trigger, r.blanks, r.own]), [
    ["refund-case", "Refund case", "refund/", ["customer", "orderRef", "reason"], false],
    ["complaint", "Complaint", "cmp/", ["customer", "orderRef", "summary"], false],
    ["address-change", "Address change", null, ["customer", "address"], false],
  ]);
  assert.deepEqual(info.records[0].fields, SAMPLE.records[0].fields);
  assert.deepEqual(info.ownRecords, []);
  assert.deepEqual(info.lookups.map((l) => [l.id, l.key, l.keyPattern, l.rowCount, l.rows.length]), [["orders", "orderRef", "A-\\d{5}", 3, 3]]);
  assert.deepEqual(info.forms.map((f) => [f.id, f.label, f.match, f.fields.length]), [["ticket", "Support ticket", { title: "new ticket", process: ["zendesk", "chrome"] }, 6]]);
  assert.deepEqual(info.forms[0].fields[0], { name: "category", label: "Category", selector: "combobox:Category" });
  assert.deepEqual(info.context, { process: "chrome", title: "Zendesk: New Ticket #4", form: { id: "ticket", label: "Support ticket" } });
  assert.deepEqual(info.proposals, []);
  assert.equal(info.sessions, 0);
  assert.equal(info.maxSessions, 500);
  assert.deepEqual(info.learning, { minCount: 3, minFields: 2 });
  assert.deepEqual(info.warnings, []);
  const big = desk({ forms: { lookups: [{ id: "big", key: "k", rows: Array.from({ length: 30 }, (_, i) => ({ k: "K" + i })) }] } });
  const bigInfo = big.assistant.invoke("forms:info");
  assert.equal(bigInfo.configured, true);
  assert.deepEqual([bigInfo.lookups[0].rowCount, bigInfo.lookups[0].rows.length], [30, 20], "the tab gets the first rows and the count");
  assert.deepEqual(bigInfo.context, { process: "", title: "", form: null });
  assert.equal(desk({ forms: null }).assistant.invoke("forms:info").configured, false);

  assert.deepEqual(assistant.invoke("forms:lookup", { text: "see A-54321 please" }), { ok: true, hit: { lookup: "orders", key: "A-54321", row: { orderRef: "A-54321", customer: "John Smith", email: "john.smith@example.com" }, via: "pattern" } });
  assert.deepEqual(assistant.invoke("forms:lookup", { text: "A-00000" }), { ok: true, hit: null });
  assert.deepEqual(assistant.invoke("forms:lookup", null), { ok: true, hit: null });
  const planned = assistant.invoke("forms:plan", { recordId: "refund-case", formId: "ticket", reference: "A-54321", answers: { reason: "Done." } });
  assert.equal(planned.ok, true);
  assert.equal(planned.plan.ready, true);
  assert.equal(planned.plan.steps[5].value, "Hi John Smith, the refund for order A-54321 is on its way. Done.");
  assert.deepEqual(planned.answers, { reason: "Done." });
  assert.deepEqual(planned.plan.skipped, []);
  const noForm = assistant.invoke("forms:plan", { recordId: "refund-case", formId: "nope", reference: "", answers: null });
  assert.equal(noForm.form, null);
  assert.deepEqual(noForm.plan.missing, ["customer", "orderRef", "reason"]);
  assert.deepEqual(assistant.invoke("forms:plan", { recordId: "zzz" }), { ok: false, error: "This record is no longer available." });
  assert.deepEqual(assistant.invoke("forms:plan", null), { ok: false, error: "This record is no longer available." });
  assert.equal(assistant.ledger.entries().length, 0, "trying counts nothing");
  assert.equal(assistant.invoke("forms:nope").ok, false);
});

test("the merged records and the proposals are computed once per policy and data change, not per keystroke or render", async () => {
  const counts = { merge: 0, proposals: 0 };
  const original = { merge: records.mergeRecords, proposals: records.proposals };
  records.mergeRecords = (...args) => { counts.merge += 1; return original.merge(...args); };
  records.proposals = (...args) => { counts.proposals += 1; return original.proposals(...args); };
  try {
    const { assistant, app, submit } = desk();
    const shell = asyncShell("");
    app.onStart(shell);
    const [action] = open(assistant, TICKET, "refund/");
    open(assistant, TICKET, "some more typing, then cmp/");
    app.palette.items();
    assistant.invoke("forms:info");
    assistant.invoke("forms:info");
    assert.deepEqual(counts, { merge: 1, proposals: 1 });
    await submit(state(action), { reference: "A-12345", answers: { reason: REASON } }, shell);
    assistant.invoke("forms:info");
    open(assistant, TICKET, "refund/");
    assert.deepEqual(counts, { merge: 2, proposals: 2 }, "a stored fill changes both");
    assistant.invoke("forms:dismissProposal", { digest: "sha256:ab" });
    assistant.invoke("forms:info");
    assert.deepEqual(counts, { merge: 3, proposals: 3 }, "any write to apps/forms.json does");
    assistant.saveSettings({});
    open(assistant, TICKET, "refund/");
    assistant.invoke("forms:info");
    assert.deepEqual(counts, { merge: 4, proposals: 4 }, "a rebuilt policy does");
    assistant.invoke("forms:info");
    assert.deepEqual(counts, { merge: 4, proposals: 4 });
  } finally {
    records.mergeRecords = original.merge;
    records.proposals = original.proposals;
  }
});

test("the simulation walks through the sample headlessly, with or without a forms section in the policy", () => {
  for (const extra of [{}, { forms: null }]) {
    const { assistant, app } = desk(extra);
    const lines = [];
    const focus = (context) => { assistant.focusChanged(context); lines.push("[focus] " + context.title); };
    app.simulate({ print: (line) => lines.push(line), assistant, focus, now: () => NOW, brief: (text) => JSON.stringify(text).slice(0, 70) });
    const text = lines.join("\n");
    assert.match(text, /typed "refund\/" -> plan popover for Refund case on Support ticket \(6 selectors, not used\); deletes 7; reference from the clipboard: A-12345/);
    assert.match(text, /Internal note = "Hi Mary Jones, the refund for order A-12345 is on its way\. \[\[reason\]\] \(needs reason\)/);
    assert.match(text, /Fill without an answer -> refused: Fill in: reason/);
    assert.match(text, /Fill with reason -> 6 fields typed, saves \d+ keystrokes:\n    close popover\n    backspace x7, paste "Refund"\n    tab\n    paste "P2"/);
    assert.match(text, /palette pick Address change with nothing copied -> still needed: customer, address/);
    assert.match(text, /Tab over E-mail, SLA hours before Internal note/);
    assert.match(text, /keys: close popover \| paste "Account" \| tab \| paste "P3" \| tab \| paste "Lee Park" \| tab x3 \| paste "New delivery address for Lee Park: 1 Main St"/);
    assert.match(text, /Fill again for Priya Nair \(A-10021\) -> 6 fields/);
    assert.match(text, /stored fills: 4; proposals: 1/);
    assert.match(text, /stored fills hold a typed answer: no/);
    assert.match(text, /learned "Learned record 1 on Support ticket" \(3 fills on ticket\): category = "Refund"; priority = "P2"; sla = "48"; email = "\[\[email\]\]"/);
    assert.match(text, /accepted as own record own-[0-9a-f]{8} with trigger refund2\//);
    assert.match(text, /typed "refund2\/" -> Refund with apology; still needed: nothing/);
    assert.match(text, /palette items: refund\/, cmp\/, form:address-change, refund2\//);
    assert.equal(text.includes("the policy has no forms section"), extra.forms === null);
    assert.equal(assistant.ledger.entries().filter((e) => e.kind === "form").length, 4);
  }
});

// ---- The two pages, run under Node with a few lines of DOM ----------------
// Enough for what renderer/apps/forms-plan.js and forms.js do: elements with
// text, attributes, children, listeners, focus and replaceWith;
// getElementById; FormData; one-part selectors ("li", "input"). Not a
// browser: layout, styles and real keyboard behaviour stay unverified here.
function createDom() {
  const byId = new Map();
  const dom = { active: null, title: "" };
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, text: "", value: "", checked: false, disabled: false }); }
    get id() { return this.attrs.id || ""; }
    set id(value) { this.setAttribute("id", value); }
    get className() { return this.attrs.class || ""; }
    set className(value) { this.attrs.class = value; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.text = String(value); this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === "id") byId.set(String(value), this); }
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceWith(node) { const list = this.parent.children; list.splice(list.indexOf(this), 1, node); node.parent = this.parent; }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    dispatch(name, extra) { const event = Object.assign({ target: this, preventDefault() {} }, extra || {}); return Promise.all((this.listeners[name] || []).map((fn) => fn(event))); }
    focus() { dom.active = this; }
    all() { return this.children.flatMap((child) => [child, ...child.all()]); }
    querySelectorAll(selector) { return this.all().filter((node) => node.tagName === selector.toUpperCase()); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  class FormData {
    constructor(form) { this.items = form.all().filter((node) => node.tagName === "INPUT" && node.name).map((node) => [node.name, node.value]); }
    entries() { return this.items.values(); }
  }
  const body = new Node("body");
  dom.document = { body, createElement: (tag) => new Node(tag), getElementById: (id) => byId.get(id) || null, addEventListener: (name, fn) => body.addEventListener(name, fn), dispatch: (name, extra) => body.dispatch(name, extra), set title(value) { dom.title = value; }, get title() { return dom.title; } };
  dom.FormData = FormData;
  // The popover page's static elements, as in forms-plan.html.
  dom.page = () => {
    for (const [tag, id] of [["h1", "title"], ["p", "matched"], ["p", "selectors"], ["form", "plan-form"], ["p", "error"], ["button", "cancel"], ["button", "fill"]]) { const node = new Node(tag); node.id = id; body.append(node); }
    for (const [tag, id] of [["input", "reference"], ["p", "lookup"], ["ul", "steps"], ["p", "skipped"], ["div", "blanks"]]) { const node = new Node(tag); node.id = id; byId.get("plan-form").append(node); }
  };
  dom.el = (tag, attrs, children) => {
    const node = new Node(tag);
    for (const [key, value] of Object.entries(attrs || {})) { if (key === "class") node.className = value; else if (key === "text") node.textContent = value; else node.setAttribute(key, value); }
    for (const child of children || []) node.append(child);
    return node;
  };
  return dom;
}

function runPage(file, dom, actle) {
  const vm = require("node:vm");
  const sandbox = { window: { actle }, document: dom.document, FormData: dom.FormData };
  return { done: vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "apps", file), "utf8"), sandbox), window: sandbox.window };
}

test("the plan popover page shows the form, the steps with the fields Tab passes over and the open blank, plans again for a typed reference, shows refusals and errors, and fills", async () => {
  const { assistant, app, submit } = desk();
  const shell = asyncShell("nothing copied");
  app.onStart(shell);
  const [action] = open(assistant, TICKET, "refund/");
  const popover = state(action);
  const dom = createDom();
  dom.page();
  let closed = 0;
  let typing = shell;
  // The slow reference answers only when released, so a later keystroke can overtake it.
  const held = [];
  const actle = {
    getPopover: async () => popover,
    invoke: (channel, payload) => {
      if (payload && payload.reference === "slow") return new Promise((resolve) => held.push(() => resolve(assistant.invoke(channel, Object.assign({}, payload, { reference: "A-10021" })))));
      if (payload && payload.reference === "gone") return Promise.resolve({ ok: false, error: "This record is no longer available." });
      if (payload && payload.reference === "down") return Promise.reject(new Error("ipc down"));
      return Promise.resolve(assistant.invoke(channel, payload));
    },
    submitPopover: (payload) => (typing === "down" ? Promise.reject(new Error("ipc down")) : submit(popover, payload, typing)),
    closePopover: () => { closed += 1; },
  };
  await runPage("forms-plan.js", dom, actle).done;
  const $ = (id) => dom.document.getElementById(id);
  assert.equal($("title").textContent, "Fill Refund case");
  assert.equal(dom.title, "Fill Refund case");
  assert.equal($("matched").textContent, "Form: Support ticket");
  assert.equal($("selectors").textContent, formsApp.SELECTORS_NOTE);
  assert.equal($("reference").value, "");
  assert.equal($("lookup").textContent, "");
  let items = $("steps").querySelectorAll("li");
  assert.equal(items.length, 4, "customer and email have no value yet");
  assert.equal(items[0].textContent, "Category: Refund");
  assert.equal(items[2].textContent, "Tab over Requester, E-mailSLA hours: 48", "the fields Tab passes over are shown before the value");
  assert.equal(items[3].textContent, "Internal note: Hi [[customer]], the refund for order [[orderRef]] is on its way. [[reason]]needs customer, orderRef, reason");
  assert.deepEqual($("blanks").querySelectorAll("input").map((input) => input.name), ["answer:customer", "answer:orderRef", "answer:reason"]);
  assert.equal($("fill").textContent, "Fill in and fill the form");
  assert.equal(dom.active.name, "answer:customer", "the first open blank gets the focus");

  $("blanks").querySelectorAll("input")[2].value = REASON;
  await $("blanks").querySelectorAll("input")[2].dispatch("input");
  $("reference").value = "A-54321";
  await $("reference").dispatch("input");
  assert.equal($("lookup").textContent, "Reference A-54321 (orders): orderRef = A-54321; customer = John Smith; email = john.smith@example.com");
  items = $("steps").querySelectorAll("li");
  assert.equal(items.length, 6);
  assert.equal(items[2].textContent, "Requester: John Smith");
  assert.deepEqual($("blanks").querySelectorAll("input").map((input) => [input.name, input.value]), [["answer:reason", REASON]], "the typed answer survives the re-plan");
  $("reference").value = "A-00000";
  await $("reference").dispatch("input");
  assert.equal($("lookup").textContent, "No lookup row matches A-00000.");

  // A refused or failed re-plan is shown over the last plan, which stays.
  $("reference").value = "gone";
  await $("reference").dispatch("input");
  assert.equal($("error").textContent, "This record is no longer available.");
  assert.equal($("lookup").textContent, "No lookup row matches A-00000.", "the last plan stays");
  $("reference").value = "down";
  await $("reference").dispatch("input");
  assert.equal($("error").textContent, "Could not plan: ipc down");
  // A slow answer overtaken by a later keystroke is dropped.
  $("reference").value = "slow";
  const slow = $("reference").dispatch("input");
  $("reference").value = "A-54321";
  await $("reference").dispatch("input");
  assert.equal($("error").textContent, "");
  held.forEach((release) => release());
  await slow;
  assert.equal($("lookup").textContent, "Reference A-54321 (orders): orderRef = A-54321; customer = John Smith; email = john.smith@example.com", "not the row for the stale reference");

  $("reference").value = "A-00000";
  await $("reference").dispatch("input");
  $("blanks").querySelectorAll("input").forEach((input) => { input.value = ""; });
  await $("plan-form").dispatch("submit");
  assert.equal($("error").textContent, "Fill in: customer, orderRef, reason (no lookup row matches A-00000)");
  assert.equal($("fill").disabled, false, "the popover stays open and usable");
  assert.deepEqual(shell.calls.replaced, []);
  $("reference").value = "A-12345";
  await $("reference").dispatch("input");
  assert.equal($("error").textContent, "");
  $("blanks").querySelector("input").value = "All sorted.";
  typing = "down";
  await $("plan-form").dispatch("submit");
  assert.equal($("error").textContent, "Could not fill the form: ipc down");
  assert.equal($("fill").disabled, false, "a failed call leaves the popover usable");
  const failing = asyncShell("");
  failing.sender.press = () => Promise.resolve({ ok: false, error: "xdotool died" });
  typing = failing;
  await $("plan-form").dispatch("submit");
  assert.equal($("fill").disabled, true, "a fill that failed half-way is over: the app closed the popover and said so");
  assert.equal($("error").textContent, "");
  assert.equal(failing.calls.closed, 1);
  assert.match(failing.calls.notified[0], /^Could not move to Priority \(2 of 6\): xdotool died\./);
  typing = shell;
  await $("plan-form").dispatch("submit");
  assert.equal(shell.calls.replaced.length, 6);
  assert.equal(shell.calls.closed, 1);
  assert.equal(shell.calls.replaced[5].text, "Hi Mary Jones, the refund for order A-12345 is on its way. All sorted.");
  await dom.document.dispatch("keydown", { key: "Escape" });
  await $("cancel").dispatch("click");
  assert.equal(closed, 2);

  const empty = createDom();
  empty.page();
  const lonely = desk({ forms: { records: [{ id: "r", trigger: "r/", fields: { a: "1", b: "2" } }], forms: [{ id: "f", match: { process: "p" }, fields: [{ name: "z", selector: "s" }] }] } });
  const [none] = open(lonely.assistant, { process: "p" }, "r/");
  await runPage("forms-plan.js", empty, { getPopover: async () => state(none), closePopover: () => {} }).done;
  assert.equal(empty.document.getElementById("steps").querySelectorAll("li")[0].textContent, "Nothing to fill: this form has none of the record's fields.");
  assert.equal(empty.document.getElementById("skipped").textContent, "Not on this form: a, b");
  assert.equal(empty.document.getElementById("fill").disabled, true);
  assert.equal(empty.document.getElementById("fill").textContent, "Fill");
  assert.equal(empty.active.id, "reference", "without blanks the reference gets the focus");
  const other = createDom();
  let refused = 0;
  await runPage("forms-plan.js", other, { getPopover: async () => ({ kind: "template" }), closePopover: () => { refused += 1; } }).done;
  assert.equal(refused, 1, "a state that is not Forms' closes the popover");
});

test("with Electron 44's promise clipboard the plan popover asks for the reference key once open, and a typed reference wins", async () => {
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  for (const typedFirst of [false, true]) {
    const { assistant, app, submit } = desk();
    const shell = asyncShell("");
    shell.clipboard.readText = () => Promise.resolve("Re: order A-54321 arrived damaged");
    app.onStart(shell);
    const [action] = open(assistant, TICKET, "refund/");
    assert.equal(action.clipboardPending, true);
    assert.equal(action.reference, "");
    const popover = state(action);
    const dom = createDom();
    dom.page();
    const held = [];
    const asked = [];
    const actle = {
      getPopover: async () => popover,
      invoke: (channel, payload) => {
        asked.push(channel);
        const answer = Promise.resolve(assistant.invoke(channel, payload));
        return channel === "forms:clipboardReference" ? new Promise((resolve) => held.push(() => resolve(answer))) : answer;
      },
      submitPopover: (payload) => submit(popover, payload, shell),
      closePopover: () => {},
    };
    await runPage("forms-plan.js", dom, actle).done;
    const $ = (id) => dom.document.getElementById(id);
    assert.deepEqual(asked.filter((c) => c === "forms:clipboardReference").length, 1);
    if (typedFirst) {
      $("reference").value = "A-10021";
      await $("reference").dispatch("input");
    }
    held.forEach((release) => release());
    await settle();
    if (typedFirst) {
      assert.equal($("reference").value, "A-10021", "the clipboard answer does not overwrite what the person typed");
      assert.match($("lookup").textContent, /^Reference A-10021 \(orders\)/);
    } else {
      assert.equal($("reference").value, "A-54321");
      assert.equal($("lookup").textContent, "Reference A-54321 (orders): orderRef = A-54321; customer = John Smith; email = john.smith@example.com");
    }
  }
});

test("the dashboard page shows records, lookups, forms, proposals and own records, tries a lookup, accepts, dismisses, deletes, clears and skips idle re-renders", async () => {
  const bigRows = Array.from({ length: 25 }, (_, i) => ({ k: "K" + i, v: String(i) }));
  const { assistant, app, submit } = desk({ forms: Object.assign({}, SAMPLE, { lookups: SAMPLE.lookups.concat([{ id: "big", key: "k", rows: bigRows }]) }) });
  for (const reference of ["A-12345", "A-54321", "A-10021"]) {
    const shell = asyncShell(reference);
    app.onStart(shell);
    const [action] = open(assistant, TICKET, "refund/");
    await submit(state(action), { reference, answers: { reason: REASON } }, shell);
  }
  const dom = createDom();
  const messages = [];
  let fetched = 0;
  const helpers = { api: { invoke: async (channel, payload) => { if (channel === "forms:info") fetched += 1; return assistant.invoke(channel, payload); } }, el: dom.el, text: (node, value) => { node.textContent = value == null ? "" : String(value); }, announce: (m) => messages.push(m), seconds: (n) => n + " s", preview: (value) => String(value || "").replace(/\s+/g, " ").slice(0, 140) };
  const { window } = runPage("forms.js", dom, {});
  const render = async (change) => { const section = dom.document.createElement("section"); await window.actleApps.forms.render(section, helpers, change || {}); return section; };
  let section = await render();
  const text = section.textContent;
  assert.match(text, /Last focused window: zendesk \u201cNew ticket - Zendesk\u201d\. Form matched: Support ticket\./);
  assert.match(text, new RegExp(formsApp.SELECTORS_NOTE.replace(/[.:]/g, "\\$&")));
  let rows = section.querySelectorAll("tr").map((row) => row.querySelectorAll("td").map((cell) => cell.textContent));
  assert.deepEqual(rows[1], ["Refund caserefund-case", "refund/", helpers.preview("category = Refund; priority = P2; sla = 48; notes = " + SAMPLE.records[0].fields.notes), "customer, orderRef, reason"]);
  assert.deepEqual(rows[3].slice(1), ["(palette only)", "category = Account; priority = P3; notes = New delivery address for [[customer]]: [[address]]", "customer, address"]);
  const lookupLines = section.querySelectorAll("tr").filter((row) => row.querySelectorAll("td").length === 5).map((row) => [row.querySelectorAll("td")[0].textContent, row.querySelectorAll("td")[3].textContent, row.querySelectorAll("td")[4].querySelectorAll("div").map((line) => line.textContent)]);
  assert.deepEqual(lookupLines[0], ["orders", "3", ["A-12345: customer = Mary Jones, email = mary.jones@example.com", "A-54321: customer = John Smith, email = john.smith@example.com", "A-10021: customer = Priya Nair, email = priya.nair@example.com"]]);
  assert.equal(lookupLines[1][0], "big");
  assert.equal(lookupLines[1][1], "25");
  assert.equal(lookupLines[1][2].length, 21, "the 20 rows the channel carries and a line for the rest");
  assert.equal(lookupLines[1][2][19], "K19: v = 19");
  assert.equal(lookupLines[1][2][20], "… 5 more");
  assert.deepEqual(rows.find((row) => row[0] === "Support ticketticket"), ["Support ticketticket", "process zendesk, chrome; title matches /new ticket/", "Category (combobox:Category), Priority (combobox:Priority), Requester (edit:Requester), E-mail (edit:Email), SLA hours (edit:SLA), Internal note (document:Internal note)"]);
  assert.match(text, /None yet\. Accept a learned proposal/);
  assert.match(text, /Learned record 1 on Support ticket: 3 fills on form ticket; constant: category, priority, sla; as a template: email/);
  assert.match(text, /3 of at most 500 fills stored for learning, each for 90 days\. "Clear stored fills" deletes them; "Delete learned text" on the Learning tab does too, but that button is enabled only while the Learning tab has learned text of its own\. A stored fill keeps only the values that came from your organisation's records and lookup lists: nothing you type into the fill popover/);
  const nameInput = section.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Name for this record");
  assert.equal(nameInput.value, "Learned record 1 on Support ticket", "the name field starts with the neutral label");

  // A change that touches nothing on this tab leaves the section alone; one that does, or a new section, renders.
  assert.equal(fetched, 1);
  await window.actleApps.forms.render(section, helpers, { metrics: true });
  await window.actleApps.forms.render(section, helpers, { library: true, learning: true });
  assert.equal(fetched, 1, "no fetch for a metrics or library change");
  assert.equal(section.textContent, text, "and nothing rebuilt");
  await window.actleApps.forms.render(section, helpers, { context: true });
  assert.equal(fetched, 2, "the focused window line follows the context");
  await window.actleApps.forms.render(section, helpers, { metrics: true, apps: true });
  assert.equal(fetched, 3);
  await render({ metrics: true });
  assert.equal(fetched, 4, "a section not rendered yet is always rendered");
  section = await render();

  const buttons = (node) => node.querySelectorAll("button");
  const lookupBox = (node) => node.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Reference or text to look up");
  const box = lookupBox(section);
  box.value = "ref A-54321";
  await box.dispatch("input");
  await buttons(section).find((b) => b.textContent === "Look up").dispatch("click");
  assert.deepEqual(messages, ["Row A-54321 found"]);
  assert.match(section.textContent, /Row A-54321 in orders \(found by its key pattern\): orderRef = A-54321; customer = John Smith; email = john.smith@example.com/);
  section = await render();
  assert.equal(lookupBox(section).value, "ref A-54321", "the draft survives a re-render");
  assert.match(section.textContent, /Row A-54321 in orders/, "so does the result");

  await buttons(section).find((b) => b.textContent === "Accept as my record").dispatch("click");
  assert.equal(messages.pop(), "Enter a trigger to type for this record.");
  const triggerInput = section.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Trigger for this record");
  triggerInput.value = "refund2/";
  await triggerInput.dispatch("input");
  const named = section.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Name for this record");
  named.value = "Refund, no note";
  await named.dispatch("input");
  section = await render();
  assert.equal(section.querySelectorAll("input").find((input) => input.getAttribute("aria-label") === "Name for this record").value, "Refund, no note", "the typed name survives a re-render");
  await buttons(section).find((b) => b.textContent === "Accept as my record").dispatch("click");
  assert.equal(messages.pop(), "Saved Refund, no note with trigger refund2/");
  section = await render();
  rows = section.querySelectorAll("tr").map((row) => row.querySelectorAll("td").map((cell) => cell.textContent));
  const ownRow = rows.find((row) => row[1] === "refund2/");
  assert.match(ownRow[0], /^Refund, no noteown-[0-9a-f]{8}$/);
  assert.equal(ownRow[4], "Delete");
  assert.match(section.textContent, /No proposals yet\./);
  await buttons(section).find((b) => b.textContent === "Delete").dispatch("click");
  assert.match(messages.pop(), /^Deleted Refund, no note$/);
  section = await render();
  assert.match(section.textContent, /None yet\. Accept a learned proposal/);
  await buttons(section).find((b) => b.textContent === "Dismiss").dispatch("click");
  assert.equal(messages.pop(), "Dismissed");
  section = await render();
  assert.match(section.textContent, /No proposals yet\./);
  await buttons(section).find((b) => b.textContent === "Clear stored fills").dispatch("click");
  assert.equal(messages.pop(), "Stored fills cleared (3)");
  section = await render();
  assert.match(section.textContent, /0 of at most 500 fills stored/);

  const bare = desk({ forms: null, paused: { message: "Audit" } });
  const { window: w2 } = runPage("forms.js", createDom(), {});
  const empty = dom.document.createElement("section");
  await w2.actleApps.forms.render(empty, Object.assign({}, helpers, { api: { invoke: async (channel, payload) => bare.assistant.invoke(channel, payload) } }), {});
  assert.match(empty.textContent, /Paused by your organisation: no record is offered\./);
  assert.match(empty.textContent, /The organisation policy has no form records/);
  assert.match(empty.textContent, /No lookup lists in the policy\./);
  assert.match(empty.textContent, /No forms in the policy: fields are filled in record order\./);
  assert.match(empty.textContent, /Last focused window: none yet\. No form matched\./);
  const failed = dom.document.createElement("section");
  await w2.actleApps.forms.render(failed, Object.assign({}, helpers, { api: { invoke: async () => ({ ok: false, error: "unknown channel forms:info" }) } }), {});
  assert.match(failed.textContent, /cactle is not available: unknown channel forms:info/);
});
