// dactle through the desktop assistant (plain Node): a document trigger
// typed in a notes window opens the fill popover, its Insert renders and
// pastes the note through a fake shell, the tray entry rebuilds the action
// block of a copied note on the clipboard, and what reaches the metrics, the
// audit file, the settings, the app data and the dashboard channels. The two
// pages run under a few lines of DOM at the end.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const orgPolicy = require("../core/org-policy.js");
const metrics = require("../core/metrics.js");
const report = require("../core/report.js");
const { loadApps } = require("../desktop/apps/index.js");
const notesApp = require("../desktop/apps/notes/app.js");
const { fakeShell, WINDOW, VALUES, NOTE } = require("../desktop/apps/notes/simulate.js");
const { createAssistant } = require("../desktop/assistant.js");

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desktop", "apps", "notes", "sample-policy.json"), "utf8"));
// Wednesday 21 October 2026, 09:30 local.
const NOW = new Date(2026, 9, 21, 9, 30).getTime();
const MINUTES = "# Minutes – Ops\n\n## Details\nWednesday 2026-10-21\nMinute taker: Dana Reyes\n\n## Attendees\n- Ann\n- Bob\n\n## Discussion\n\n\n## Decisions\n\n\n## Action items\n- None\n";

const folders = [];
test.after(() => { for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true }); });

function temp() {
  const dir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-notes-"));
  folders.push(dir);
  return dir;
}

function desk(extraPolicy, extra) {
  const dataDir = temp();
  const policy = Object.assign({
    organization: "Example Logistics",
    library: [{ trigger: "/handover", expansion: "A SHORTCUT WINS" }],
    notes: SAMPLE,
  }, extraPolicy);
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(policy));
  const assistant = createAssistant(Object.assign({ dataDir, now: () => NOW, appIds: ["notes"] }, extra));
  return { assistant, dataDir, app: assistant.app("notes") };
}

/** The simulator's stand-in, with a sender that answers through a promise like Electron's. */
function asyncShell(clipboardText) {
  const shell = fakeShell(clipboardText);
  const sync = shell.sender.replace;
  shell.sender.replace = (action) => Promise.resolve(sync(action));
  return shell;
}

function open(assistant, text) {
  assistant.focusChanged(WINDOW);
  let actions = [];
  for (const ch of text) actions = actions.concat(assistant.keyTyped({ text: ch }));
  return actions;
}

function stored(dataDir, file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
}

test("the sample section parses with no warnings and the app loads through the registry with the contract's shape", () => {
  const parsed = orgPolicy.parse({ notes: SAMPLE });
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.notes.documents.map((d) => [d.id, d.trigger]), [["minutes", "/mins"], ["handover", "/handover"], ["shift-log", "/shift"]]);
  assert.deepEqual(report.organizationShortcuts(parsed).filter((s) => s.kind === "notes"), [{ trigger: "minutes", kind: "notes" }, { trigger: "handover", kind: "notes" }, { trigger: "shift-log", kind: "notes" }], "usage reports can name every document");
  const [app] = loadApps({ policy: () => parsed, engine: { library: [] }, appData: () => ({ load: () => ({}), save: () => {} }), now: () => NOW, log: () => {} }, { ids: ["notes"] });
  assert.equal(app.id, "notes");
  assert.equal(app.title, "dactle");
  assert.deepEqual(Object.keys(app.ipc), ["notes:info", "notes:render", "notes:actions", "notes:update", "notes:setAuthor"]);
  assert.equal(app.extension.id, "notes");
  assert.equal(app.popovers.fill.file, "apps/notes-fill");
  assert.equal(typeof app.popovers.fill.submit, "function");
  assert.deepEqual(app.popovers.fill.size({ blanks: [1, 2, 3] }), { width: 480, height: 150 + 62 * 3 });
  assert.equal(app.popovers.fill.size({ blanks: Array.from({ length: 20 }) }).height, 700, "capped");
  assert.equal(app.popovers.fill.size(null).height, 150);
  assert.ok(fs.existsSync(path.join(__dirname, "..", "desktop", "renderer", "apps", "notes-fill.html")));
  assert.equal(app.trayItems()[0].label, notesApp.TRAY_LABEL);
  assert.deepEqual(notesApp.normalizeData({ inserted: { minutes: "2", x: 0, y: -1 }, actionUpdates: "3.7", junk: 1 }), { version: 1, inserted: { minutes: 2 }, actionUpdates: 3 });
  assert.deepEqual(notesApp.listValues(" Ann , ,Bob "), ["Ann", "Bob"]);
  assert.deepEqual(notesApp.listValues(["Ann", " "]), ["Ann"]);
});

test("typing a document's trigger opens the fill popover with its blanks and the author prefilled; a shortcut with the same trigger wins; paused offers nothing", () => {
  const { assistant, app } = desk();
  const actions = open(assistant, "Weekly sync /mins");
  assert.deepEqual(actions, [{
    type: "app", app: "notes", trigger: "/mins", backspaces: 5, popover: "fill", documentId: "minutes", label: "Meeting minutes", via: "trigger",
    blanks: [{ name: "meeting", list: false, value: "" }, { name: "author", list: false, value: "" }, { name: "attendees", list: true, value: "" }],
  }]);
  assistant.saveSettings({ notesAuthor: "Dana Reyes" });
  assert.deepEqual(open(assistant, "/shift")[0].blanks, [{ name: "author", list: false, value: "Dana Reyes" }], "the author comes from the person's setting");
  assert.equal(open(assistant, "/handover")[0].type, "expand", "the library shortcut wins over the document");
  assert.deepEqual(open(assistant, "x/mins"), [], "a letter before the trigger is not a boundary");
  assert.equal(app.extension.trigger("see /mins").action.documentId, "minutes");
  assert.equal(app.extension.trigger("/mins "), null);
  // The engine and the assistant's palette answer nothing while paused; the app has no gate of its own there.
  const paused = desk({ paused: { message: "Audit" } });
  assert.deepEqual(open(paused.assistant, "/mins"), []);
  assert.deepEqual(paused.assistant.paletteSearch("minutes"), []);
  assert.equal(paused.assistant.paletteChoose({ kind: "app:notes", trigger: "/mins", query: "min" }), null);
  const none = desk({ notes: null });
  assert.deepEqual(open(none.assistant, "/mins"), []);
  assert.equal(none.app.ipc["notes:info"]().configured, false);
});

test("Insert refuses an open blank, splits lists, pastes in place of the trigger, counts and audits without any text, and remembers the author", async () => {
  const { assistant, app, dataDir } = desk();
  const [action] = open(assistant, "/mins");
  const shell = asyncShell("");
  assert.deepEqual(await app.popovers.fill.submit(action, { values: {} }, shell), { ok: false, error: "Fill in: meeting, author, attendees", missing: ["meeting", "author", "attendees"] });
  assert.deepEqual(await app.popovers.fill.submit(action, { values: { meeting: "Ops", author: "  ", attendees: " , " } }, shell), { ok: false, error: "Fill in: author, attendees", missing: ["author", "attendees"] });
  assert.deepEqual(await app.popovers.fill.submit(action, null, shell), { ok: false, error: "Fill in: meeting, author, attendees", missing: ["meeting", "author", "attendees"] });
  assert.deepEqual(shell.calls.replaced, [], "nothing was pasted");
  assert.equal(assistant.ledger.entries().length, 0);

  const result = await app.popovers.fill.submit(action, { values: { meeting: "Ops", author: "Dana Reyes", attendees: " Ann , ,Bob ", extra: "ignored" } }, shell);
  const [pasted] = shell.calls.replaced;
  assert.equal(pasted.backspaces, 5, "the typed trigger is deleted");
  assert.equal(pasted.text, MINUTES);
  assert.equal(pasted.cursorOffset, MINUTES.indexOf("## Discussion\n") + "## Discussion\n".length, "{cursor} places the caret");
  assert.deepEqual(shell.calls.order, ["closePopover", "replace"], "the popover closes before the paste, so the keys reach the editor");
  const [entry] = assistant.ledger.entries();
  assert.equal(entry.kind, "notes");
  assert.equal(entry.trigger, "minutes");
  assert.equal(entry.source, "organization");
  const typed = metrics.graphemes("Ops") + metrics.graphemes("Dana Reyes") + metrics.graphemes(" Ann , ,Bob ");
  assert.equal(entry.keystrokesSaved, metrics.graphemes(MINUTES) - 5 - typed, "the trigger and the typed answers are not savings");
  assert.deepEqual(result, { ok: true, document: "minutes", inserted: MINUTES.length, caret: pasted.cursorOffset, keystrokesSaved: entry.keystrokesSaved });
  const audit = assistant.audit().filter((e) => e.event === "notes-inserted");
  assert.deepEqual(audit, [{ at: NOW, event: "notes-inserted", document: "minutes", via: "trigger", blanks: 3, keystrokesSaved: entry.keystrokesSaved }]);
  const auditText = fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8");
  assert.equal(/Dana|Ops|Ann|Bob/.test(auditText), false, "no answer or note text in the audit file");
  assert.equal(stored(dataDir, "settings.json").notesAuthor, "Dana Reyes", "the author is kept for next time");
  assert.equal(assistant.settings().notesAuthor, "Dana Reyes");
  assert.deepEqual(stored(dataDir, path.join("apps", "notes.json")), { version: 1, inserted: { minutes: 1 }, actionUpdates: 0 });
  assert.deepEqual(assistant.usageReport().byShortcut.map((s) => [s.kind, s.trigger, s.inserts]), [["notes", "minutes", 1]]);

  // The prefilled author was not typed, so it is not subtracted the second time.
  const [again] = open(assistant, "/mins");
  assert.equal(again.blanks[1].value, "Dana Reyes");
  await app.popovers.fill.submit(again, { values: { meeting: "Ops", author: "Dana Reyes", attendees: ["Ann", "Bob"] } }, shell);
  assert.equal(assistant.ledger.entries()[1].keystrokesSaved, metrics.graphemes(MINUTES) - 5 - metrics.graphemes("Ops") - metrics.graphemes("Ann, Bob"));
  assert.equal(shell.calls.replaced[1].text, MINUTES, "a list given as an array is taken as it is");
  assert.equal(stored(dataDir, path.join("apps", "notes.json")).inserted.minutes, 2);

  assert.deepEqual(await app.popovers.fill.submit({ documentId: "gone", backspaces: 2 }, { values: {} }, shell), { ok: false, error: "This document is no longer in your organisation's policy." });
  const failing = asyncShell("");
  failing.sender.replace = () => Promise.resolve({ ok: false, error: "xdotool is not installed" });
  assert.deepEqual(await app.popovers.fill.submit(action, { values: { meeting: "Ops", author: "Dana", attendees: "Ann" } }, failing), { ok: false, error: "Could not insert the note: xdotool is not installed", close: true }, "the popover is already closed; the sender's own notification carries the reason");
  assert.equal(assistant.ledger.entries().length, 2, "a failed paste is not counted");
  assert.equal(assistant.settings().notesAuthor, "Dana Reyes", "nor does it change the author");
  const thrown = asyncShell("");
  thrown.sender.replace = () => Promise.reject(new Error("boom"));
  await assert.rejects(app.popovers.fill.submit(action, { values: { meeting: "Ops", author: "Dana", attendees: "Ann" } }, thrown), /boom/, "main.js turns a throw into a refusal");
  const paused = desk({ paused: true });
  assert.deepEqual(paused.app.submit({ documentId: "minutes" }, { values: {} }, shell), { ok: false, error: "Paused by your organisation." });
});

test("a trigger insert takes the trigger out of the engine's field text once, and a short list of a repeat section is refused with its counts", async () => {
  const { assistant, app } = desk({ keywordRules: [{ id: "k", keywords: ["refund"], insert: "Returns text" }] });
  const [action] = open(assistant, "Weekly sync /mins");
  assert.equal(assistant.engine.fieldText, "Weekly sync ", "the engine removed the trigger at the hit");
  await app.popovers.fill.submit(action, { values: { meeting: "Ops", author: "Dana Reyes", attendees: "Ann, Bob" } }, asyncShell(""));
  assert.equal(assistant.engine.fieldText, "Weekly sync " + MINUTES, "the insert is appended; the trigger is not removed a second time");
  assert.equal(assistant.ledger.entries()[0].keystrokesSaved, metrics.graphemes(MINUTES) - 5 - metrics.graphemes("Ops") - metrics.graphemes("Dana Reyes") - metrics.graphemes("Ann, Bob"), "the trigger is still spent");

  const repeat = desk({ notes: { documents: [{ id: "review", trigger: "/review", sections: [{ heading: "Item: [[topic]]", body: "Owner: [[owner]]", repeat: true }, { heading: "All", body: "- [[topic]]" }] }] } });
  const [review] = open(repeat.assistant, "/review");
  assert.deepEqual(review.blanks, [{ name: "topic", list: true, value: "" }, { name: "owner", list: true, value: "" }]);
  const shell = asyncShell("");
  assert.deepEqual(await repeat.app.popovers.fill.submit(review, { values: { topic: "A, B, C", owner: "Ann, Bob" } }, shell), { ok: false, error: "Fill in: owner (2 of 3 values)", missing: ["owner"] });
  assert.deepEqual(shell.calls.order, [], "nothing was closed or pasted");
  assert.equal((await repeat.app.popovers.fill.submit(review, { values: { topic: "A, B, C", owner: "Ann, Bob, Cy" } }, shell)).ok, true);
  assert.match(shell.calls.replaced[0].text, /## Item: C\nOwner: Cy\n/);
});

test("once the note reached the editor, a fault in the bookkeeping is logged and notified and never keeps the popover open", async () => {
  const logged = [];
  const faulty = (fail) => notesApp.createApp({
    policy: () => orgPolicy.parse({ notes: SAMPLE }), settings: () => ({}), saveSettings: () => {}, now: () => NOW, log: (line) => logged.push(line),
    recordInsert: () => ({ keystrokesSaved: 10 }),
    audit: fail === "audit" ? () => { throw new Error("disk full"); } : () => {},
    appData: () => ({ load: () => ({}), save: fail === "data" ? () => { throw new Error("read-only"); } : () => {} }),
  });
  for (const [fail, message] of [["audit", "disk full"], ["data", "read-only"]]) {
    const app = faulty(fail);
    const shell = asyncShell("");
    const state = Object.assign({ backspaces: 5, trigger: "/mins" }, app.extension.trigger("/mins").action);
    const result = await app.popovers.fill.submit(state, { values: { meeting: "Ops", author: "Dana", attendees: "Ann" } }, shell);
    assert.equal(shell.calls.replaced.length, 1, "pasted once");
    assert.deepEqual(result, { ok: true, document: "minutes", inserted: shell.calls.replaced[0].text.length, caret: shell.calls.replaced[0].cursorOffset, keystrokesSaved: 0, recorded: false }, "ok, so main.js closes the popover and a second Insert cannot paste the note again");
    assert.deepEqual(shell.calls.notified, ["The note was inserted, but it could not be counted: " + message]);
    assert.equal(logged.pop(), "notes: the insert could not be counted: " + message);
  }
  const sound = faulty("none");
  const shell = asyncShell("");
  const state = Object.assign({ backspaces: 5, trigger: "/mins" }, sound.extension.trigger("/mins").action);
  assert.equal((await sound.popovers.fill.submit(state, { values: { meeting: "Ops", author: "Dana", attendees: "Ann" } }, shell)).keystrokesSaved, 10);
  assert.deepEqual(shell.calls.notified, []);
});

test("the palette lists the documents and the action-items entry; a document opens the fill popover without backspaces; the entry needs the started shell and opens nothing", async () => {
  const { assistant, app } = desk();
  assert.deepEqual(assistant.paletteSearch("minutes").map((i) => [i.kind, i.trigger, i.source]), [["app:notes", "/mins", "organization"]]);
  assert.deepEqual(assistant.paletteSearch("/shift").map((i) => i.trigger), ["/shift"]);
  assert.ok(assistant.paletteSearch("action items").some((i) => i.kind === "app:notes" && i.trigger === notesApp.PALETTE_LABEL));
  const action = assistant.paletteChoose({ kind: "app:notes", trigger: "/mins", query: "min" });
  assert.deepEqual(action, {
    type: "app", app: "notes", trigger: "/mins", backspaces: 0, spentKeystrokes: 4, popover: "fill", documentId: "minutes", label: "Meeting minutes", via: "palette",
    blanks: [{ name: "meeting", list: false, value: "" }, { name: "author", list: false, value: "" }, { name: "attendees", list: true, value: "" }],
  });
  const shell = asyncShell("");
  const result = await app.popovers.fill.submit(action, { values: { meeting: "Ops", author: "Dana Reyes", attendees: "Ann, Bob" } }, shell);
  assert.equal(shell.calls.replaced[0].backspaces, 0, "nothing was typed into the field");
  assert.equal(result.keystrokesSaved, metrics.graphemes(MINUTES) - 4 - metrics.graphemes("Ops") - metrics.graphemes("Dana Reyes") - metrics.graphemes("Ann, Bob"), "the query, Enter and the answers are spent");
  assert.equal(assistant.audit().pop().via, "palette");

  assert.equal(assistant.paletteChoose({ kind: "app:notes", trigger: notesApp.PALETTE_LABEL, query: "act" }), null, "before onStart there is no clipboard to read");
  const copied = asyncShell(NOTE);
  app.onStart(copied);
  assert.equal(assistant.paletteChoose({ kind: "app:notes", trigger: notesApp.PALETTE_LABEL, query: "act" }), null, "done on the spot: nothing to open");
  assert.equal(copied.calls.copied.length, 1);
  assert.deepEqual(copied.calls.notified, [notesApp.UPDATED]);
  assert.equal(assistant.audit().pop().via, "palette");
  app.onStop();
  assert.equal(app.palette.choose({ trigger: "nope", spentKeystrokes: 1 }), null);
  assert.equal(app.palette.choose(null), null);
  const off = desk({ notes: Object.assign({}, SAMPLE, { actions: false, documents: [SAMPLE.documents[0]] }) });
  assert.deepEqual(off.app.palette.items().map((i) => i.trigger), ["/mins"], "no action-items entry when the policy switches the block off");
});

test("the tray entry rebuilds the action block on the clipboard, counts nothing in the metrics, and says when there is nothing to do", () => {
  const { assistant, app, dataDir } = desk();
  const shell = fakeShell(NOTE);
  const [item] = app.trayItems(shell);
  assert.equal(item.label, notesApp.TRAY_LABEL);
  assert.deepEqual(item.click(shell), { ok: true, items: 3, changed: true });
  const updated = shell.clipboard.readText();
  assert.equal(updated, NOTE.replace("## Action items\n- None\n", "## Action items\n- Sam will restock ward 3 by Friday (due 2026-10-23)\n- TODO: Omar to book the room for the review\n- @priya.k to call the vendor tomorrow (due 2026-10-22)\n"));
  assert.deepEqual(shell.calls.notified, [notesApp.UPDATED]);
  assert.deepEqual(shell.calls.actions, [], "no popover");
  assert.equal(assistant.ledger.entries().length, 0, "actle typed nothing, so nothing is counted");
  assert.deepEqual(assistant.audit().filter((e) => e.event === "notes-actions-updated"), [{ at: NOW, event: "notes-actions-updated", via: "tray", items: 3 }]);
  assert.equal(stored(dataDir, path.join("apps", "notes.json")).actionUpdates, 1);
  assert.deepEqual(item.click(shell), { ok: true, items: 3, changed: false }, "a second run changes nothing");
  assert.equal(shell.clipboard.readText(), updated);

  const quiet = fakeShell("Quiet night.\n");
  assert.deepEqual(item.click(quiet), { ok: true, items: 0, changed: false });
  assert.deepEqual(quiet.calls.notified, [notesApp.NONE_FOUND]);
  assert.deepEqual(quiet.calls.copied, [], "the clipboard is left alone");
  const handover = fakeShell("# Handover\n\nSam will call the ward by Friday.\n\n## Follow-ups\n- None\n");
  assert.deepEqual(item.click(handover), { ok: true, items: 1, changed: true });
  assert.equal(handover.clipboard.readText(), "# Handover\n\nSam will call the ward by Friday.\n\n## Follow-ups\n- Sam will call the ward by Friday (due 2026-10-23)\n", "a document's own heading is recognised");
  const empty = fakeShell("  \n");
  assert.deepEqual(item.click(empty), { ok: false, error: "clipboard empty" });
  assert.deepEqual(empty.calls.notified, ["Copy your note first, then choose \"" + notesApp.TRAY_LABEL + "\" again."]);
  const unreadable = fakeShell("x");
  unreadable.clipboard.readText = () => { throw new Error("no clipboard"); };
  assert.equal(item.click(unreadable).error, "clipboard empty", "a clipboard that cannot be read counts as empty");
  const unwritable = fakeShell(NOTE);
  unwritable.clipboard.writeText = () => { throw new Error("locked"); };
  assert.deepEqual(item.click(unwritable), { ok: false, error: "clipboard: locked" });
  assert.deepEqual(unwritable.calls.notified, ["The clipboard could not be written: locked"]);
  assert.equal(stored(dataDir, path.join("apps", "notes.json")).actionUpdates, 3, "every run that wrote the clipboard is counted; the failed write is not");

  const paused = desk({ paused: true });
  const other = fakeShell(NOTE);
  assert.deepEqual(paused.app.trayItems(other)[0].click(other), { ok: false, error: "paused" });
  assert.deepEqual(other.calls.notified, ["Paused by your organisation."]);
  const off = desk({ notes: Object.assign({}, SAMPLE, { actions: false, documents: [SAMPLE.documents[0]] }) });
  const third = fakeShell(NOTE);
  assert.deepEqual(off.app.updateClipboard(third, "tray"), { ok: false, error: "actions off" });
  assert.deepEqual(third.calls.notified, ["Action items are switched off in your organisation's policy."]);
  assert.deepEqual(third.calls.copied, []);
});

test("dashboard channels: info lists the documents, render tries a document, actions and update try a note without counting, setAuthor keeps the setting", () => {
  const { assistant, app, dataDir } = desk();
  const info = assistant.invoke("notes:info");
  assert.equal(info.configured, true);
  assert.equal(info.paused, false);
  assert.deepEqual(info.author, { blank: "author", value: "" });
  assert.equal(info.dateOrder, "dmy");
  assert.deepEqual(info.actions, { heading: "Action items", patterns: ["TODO", "ACTION"], empty: "None" });
  assert.equal(info.trayLabel, notesApp.TRAY_LABEL);
  assert.equal(info.paletteLabel, notesApp.PALETTE_LABEL);
  assert.equal(info.actionUpdates, 0);
  assert.deepEqual(info.documents.map((d) => [d.id, d.trigger, d.label, d.blanks, d.actions && d.actions.heading, d.inserted]), [
    ["minutes", "/mins", "Meeting minutes", [{ name: "meeting", list: false }, { name: "author", list: false }, { name: "attendees", list: true }], "Action items", 0],
    ["handover", "/handover", "Shift handover", [{ name: "author", list: false }, { name: "incoming", list: false }], "Follow-ups", 0],
    ["shift-log", "/shift", "Shift log", [{ name: "author", list: false }], null, 0],
  ]);
  assert.deepEqual(info.documents[0].sections, [{ heading: "Details", repeat: false, empty: false }, { heading: "Attendees", repeat: false, empty: false }, { heading: "Discussion", repeat: false, empty: false }, { heading: "Decisions", repeat: false, empty: true }]);
  assert.equal(info.documents[0].title, "Minutes – [[meeting]]");

  const rendered = assistant.invoke("notes:render", { documentId: "minutes", values: { meeting: "Ops", author: "Dana Reyes", attendees: "Ann, Bob" } });
  assert.deepEqual(rendered, { ok: true, text: MINUTES, fields: [], caret: MINUTES.indexOf("## Discussion\n") + "## Discussion\n".length, ready: true });
  assert.deepEqual(assistant.invoke("notes:render", { documentId: "minutes" }).fields, ["meeting", "author", "attendees"]);
  assert.deepEqual(assistant.invoke("notes:render", { documentId: "nope" }), { ok: false, error: "No document with id \"nope\"." });
  assert.equal(assistant.invoke("notes:render", null).ok, false);

  const found = assistant.invoke("notes:actions", { text: NOTE });
  assert.equal(found.ok, true);
  assert.equal(found.enabled, true);
  assert.deepEqual(found.items.map((i) => [i.owner, i.due, i.line]), [["Sam", "2026-10-23", 4], ["Omar", "", 5], ["priya.k", "2026-10-22", 6]]);
  assert.match(found.block, /^## Action items\n- Sam will restock/);
  assert.deepEqual(assistant.invoke("notes:actions", { text: "" }), { ok: true, enabled: true, items: [], block: "## Action items\n- None" });
  assert.deepEqual(assistant.invoke("notes:actions", null).items, []);
  const updated = assistant.invoke("notes:update", { text: NOTE });
  assert.equal(updated.items, 3);
  assert.equal(updated.changed, true);
  assert.equal(updated.text, NOTE.replace("- None\n", "- Sam will restock ward 3 by Friday (due 2026-10-23)\n- TODO: Omar to book the room for the review\n- @priya.k to call the vendor tomorrow (due 2026-10-22)\n"));
  assert.deepEqual(assistant.invoke("notes:update", { text: "Quiet." }), { ok: true, enabled: true, text: "Quiet.", items: 0, changed: false });
  assert.equal(assistant.ledger.entries().length, 0, "trying counts nothing");
  assert.equal(fs.existsSync(path.join(dataDir, "apps", "notes.json")), false, "and writes nothing");

  assert.deepEqual(assistant.invoke("notes:setAuthor", { author: "  Dana Reyes " }), { ok: true, author: "Dana Reyes", broadcast: { apps: true } });
  assert.equal(stored(dataDir, "settings.json").notesAuthor, "Dana Reyes");
  assert.equal(assistant.invoke("notes:info").author.value, "Dana Reyes");
  assert.equal(stored(dataDir, "settings.json").enabled, true, "other settings are kept");
  assert.deepEqual(assistant.invoke("notes:setAuthor", {}), { ok: true, author: "", broadcast: { apps: true } });
  assert.equal(assistant.invoke("notes:info").author.value, "");
  assert.equal(assistant.invoke("notes:nope").ok, false);
  const off = desk({ notes: Object.assign({}, SAMPLE, { actions: false, documents: [SAMPLE.documents[0]] }) });
  assert.equal(off.app.ipc["notes:info"]().actions, null);
  assert.deepEqual(off.app.ipc["notes:update"]({ text: NOTE }), { ok: true, enabled: false, text: NOTE, items: 0, changed: false });
  assert.deepEqual(off.app.ipc["notes:actions"]({ text: NOTE }), { ok: true, enabled: false, items: [], block: "" });
});

test("the simulation walks through the sample headlessly, with or without a notes section in the policy", () => {
  for (const extra of [{}, { notes: null }]) {
    const { assistant, app } = desk(extra);
    const lines = [];
    const focus = (context) => { assistant.focusChanged(context); lines.push("[focus] " + context.process); };
    app.simulate({ print: (line) => lines.push(line), assistant, focus, now: () => NOW, brief: (text) => JSON.stringify(text).slice(0, 70) });
    const text = lines.join("\n");
    assert.match(text, /\[focus\] notepad\.exe/);
    assert.match(text, /typed "\/mins" -> fill popover for Meeting minutes; deletes 5; blanks: meeting, author, attendees \(list\)/);
    assert.match(text, /Insert with nothing filled in -> refused: Fill in: meeting, author, attendees/);
    assert.match(text, /Insert with meeting, author, attendees -> popover closed, then deleted 5, pasted \d+ characters, caret at \d+, saves \d+ keystrokes:/);
    assert.match(text, /\| Wednesday 2026-10-21\n {4}\| Minute taker: Dana Reyes/);
    assert.match(text, /\| - Ann Lee\n {4}\| - Bob Osei\n {4}\| - Cy Park/);
    assert.match(text, /author remembered for next time: Dana Reyes/);
    assert.match(text, /tray "dactle: Update action items in the copied note" -> 3 action items; Action items updated on your clipboard/);
    assert.match(text, /\| - Sam will restock ward 3 by Friday \(due 2026-10-23\)\n {4}\| - TODO: Omar to book the room for the review\n {4}\| - @priya\.k to call the vendor tomorrow \(due 2026-10-22\)/);
    assert.match(text, /again -> 3 action items, note unchanged/);
    assert.match(text, /metrics entries for the clipboard updates: none/);
    assert.match(text, /empty clipboard -> Copy your note first/);
    assert.equal(text.includes("the policy has no notes section"), extra.notes === null);
    assert.equal(assistant.ledger.entries().filter((e) => e.kind === "notes").length, 1);
    assert.equal(assistant.settings().notesAuthor, VALUES.author);
  }
});

// ---- The two pages, run under Node with a few lines of DOM ----------------
// Enough for what renderer/apps/notes-fill.js and notes.js do: elements with
// text, attributes, children, listeners, values and focus; getElementById;
// FormData; one-part selectors ("input", "tr"). Not a browser: layout, styles
// and real keyboard behaviour stay unverified here.
function createDom() {
  const byId = new Map();
  const dom = { active: null };
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, text: "", value: "", disabled: false }); }
    get id() { return this.attrs.id || ""; }
    set id(value) { this.setAttribute("id", value); }
    get className() { return this.attrs.class || ""; }
    set className(value) { this.attrs.class = value; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.text = String(value); this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === "id") byId.set(String(value), this); }
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    dispatch(name, extra) { const event = Object.assign({ target: this, preventDefault() {} }, extra || {}); return Promise.all((this.listeners[name] || []).map((fn) => fn(event))); }
    focus() { dom.active = this; }
    all() { return this.children.flatMap((child) => [child, ...child.all()]); }
    querySelectorAll(selector) {
      const [, tag, attr, value] = /^(\w+)(?:\[(\w+)=(\w+)\])?$/.exec(selector);
      return this.all().filter((node) => node.tagName === tag.toUpperCase() && (!attr || node[attr] === value || node.attrs[attr] === value));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  class FormData {
    constructor(form) { this.items = form.all().filter((node) => node.tagName === "INPUT" && node.name).map((node) => [node.name, node.value]); }
    entries() { return this.items.values(); }
  }
  const body = new Node("body");
  dom.document = { body, title: "", createElement: (tag) => new Node(tag), getElementById: (id) => byId.get(id) || null, addEventListener: (name, fn) => body.addEventListener(name, fn), dispatch: (name, extra) => body.dispatch(name, extra) };
  dom.FormData = FormData;
  // The popover page's static elements, as in notes-fill.html.
  dom.page = (ids) => { for (const [tag, id] of ids) { const node = new Node(tag); node.id = id; body.append(node); } };
  return dom;
}

function runPage(file, dom, actle) {
  const sandbox = { window: { actle }, document: dom.document, FormData: dom.FormData, Array };
  return { done: vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "apps", file), "utf8"), sandbox), window: sandbox.window };
}

function el(dom) {
  return (tag, attrs, children) => {
    const node = dom.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) { if (key === "class") node.className = value; else if (key === "text") node.textContent = value; else node.setAttribute(key, value); }
    for (const child of children || []) node.append(child);
    return node;
  };
}

test("the fill popover page asks for the blanks, prefills and skips the author, shows a refusal and inserts", async () => {
  const { assistant, app } = desk();
  assistant.saveSettings({ notesAuthor: "Dana Reyes" });
  const [state] = open(assistant, "/mins");
  Object.assign(state, { kind: "app" });
  const shell = asyncShell("");
  const dom = createDom();
  dom.page([["h1", "title"], ["p", "hint"], ["form", "form"], ["p", "error"], ["button", "cancel"], ["button", "insert"]]);
  const blanks = dom.document.createElement("div");
  blanks.id = "blanks";
  dom.document.getElementById("form").append(blanks);
  let closed = 0;
  const actle = { getPopover: async () => state, submitPopover: (payload) => app.popovers.fill.submit(state, payload, shell), closePopover: () => { closed += 1; } };
  await runPage("notes-fill.js", dom, actle).done;
  const $ = (id) => dom.document.getElementById(id);
  assert.equal($("title").textContent, "Insert Meeting minutes");
  assert.equal(dom.document.title, "Insert Meeting minutes");
  assert.match($("hint").textContent, /A list takes several values separated by commas\./);
  const inputs = blanks.querySelectorAll("input");
  assert.deepEqual(inputs.map((input) => [input.name, input.value]), [["value:meeting", ""], ["value:author", "Dana Reyes"], ["value:attendees", ""]]);
  assert.deepEqual(blanks.querySelectorAll("span").map((span) => span.textContent), ["meeting", "author", "attendees (several, separated by commas)"]);
  assert.equal(dom.active.name, "value:meeting", "the first open blank gets the focus");
  await $("form").dispatch("submit");
  assert.equal($("error").textContent, "Fill in: meeting, attendees");
  assert.equal($("insert").disabled, false, "the popover stays open and usable");
  assert.deepEqual(shell.calls.replaced, []);
  inputs[0].value = "Ops";
  inputs[2].value = "Ann, Bob";
  await $("form").dispatch("submit");
  assert.equal(shell.calls.replaced.length, 1);
  assert.equal(shell.calls.replaced[0].text, MINUTES);
  assert.equal(assistant.ledger.entries().length, 1);
  await dom.document.dispatch("keydown", { key: "Escape" });
  await $("cancel").dispatch("click");
  assert.equal(closed, 2);

  const prefilled = createDom();
  prefilled.page([["h1", "title"], ["p", "hint"], ["form", "form"], ["p", "error"], ["button", "cancel"], ["button", "insert"]]);
  const holder = prefilled.document.createElement("div");
  holder.id = "blanks";
  prefilled.document.getElementById("form").append(holder);
  const [log] = open(assistant, "/shift");
  await runPage("notes-fill.js", prefilled, { getPopover: async () => Object.assign({ kind: "app" }, log), closePopover: () => {} }).done;
  assert.equal(prefilled.active.name, "value:author", "with every blank prefilled the first input keeps the focus");
  const other = createDom();
  let refused = 0;
  await runPage("notes-fill.js", other, { getPopover: async () => ({ kind: "template" }), closePopover: () => { refused += 1; } }).done;
  assert.equal(refused, 1, "a state that is not Notes' closes the popover");
});

test("the dashboard page lists the documents, saves the author, and tries a note", async () => {
  const { assistant } = desk();
  const dom = createDom();
  const messages = [];
  const helpers = { api: { invoke: async (channel, payload) => assistant.invoke(channel, payload) }, el: el(dom), text: (node, value) => { node.textContent = value == null ? "" : String(value); }, announce: (m) => messages.push(m), seconds: (n) => n + " s", preview: (value) => String(value || "").replace(/\s+/g, " ").slice(0, 140) };
  const { window } = runPage("notes.js", dom, {});
  const section = dom.document.createElement("section");
  await window.actleApps.notes.render(section, helpers, {});
  const text = section.textContent;
  assert.match(text, /Update action items in the copied note/);
  assert.match(text, /Action patterns: TODO, ACTION; an empty block reads "None"\. Dates in due phrases are read dmy\. Clipboard updates so far: 0\./);
  const rows = section.querySelectorAll("tr").map((row) => row.querySelectorAll("td").map((cell) => cell.textContent));
  assert.deepEqual(rows[1], ["/mins", "Meeting minutesminutes", "Details, Attendees, Discussion, Decisions", "meeting, author, attendees (list)", "\"Action items\"", "0"]);
  assert.deepEqual(rows[2].slice(4), ["\"Follow-ups\" (TODO, ACTION)", "0"]);
  assert.deepEqual(rows[3].slice(4), ["off", "0"]);
  const buttons = section.querySelectorAll("button");
  const author = section.querySelector("input");
  author.value = "Dana Reyes";
  await buttons.find((b) => b.textContent === "Save").dispatch("click");
  assert.deepEqual(messages, ["Author saved: Dana Reyes"]);
  assert.equal(assistant.settings().notesAuthor, "Dana Reyes");
  const box = section.querySelector("textarea");
  box.value = NOTE;
  await box.dispatch("input");
  await buttons.find((b) => b.textContent === "Find action items").dispatch("click");
  assert.equal(messages.pop(), "3 action items found");
  const items = section.querySelectorAll("tr").slice(5).map((row) => row.querySelectorAll("td").map((cell) => cell.textContent));
  assert.deepEqual(items, [["Sam", "2026-10-23 (by Friday)", "Sam will restock ward 3 by Friday", "4"], ["Omar", "", "TODO: Omar to book the room for the review", "5"], ["priya.k", "2026-10-22 (tomorrow)", "@priya.k to call the vendor tomorrow", "6"]]);
  assert.match(section.textContent, /The note with its action block rebuilt:/);
  assert.match(section.querySelector("div[class=overlay]").textContent, /- Sam will restock ward 3 by Friday \(due 2026-10-23\)/);
  const again = dom.document.createElement("section");
  await window.actleApps.notes.render(again, helpers, {});
  assert.equal(again.querySelector("textarea").value, NOTE, "the draft survives a re-render");
  assert.match(again.textContent, /The note with its action block rebuilt:/, "so does the last result");
  assert.equal(again.querySelector("input").value, "Dana Reyes", "the saved author is shown");
  box.value = "Quiet.";
  await box.dispatch("input");
  await buttons.find((b) => b.textContent === "Find action items").dispatch("click");
  assert.equal(messages.pop(), "No action items found");
  assert.match(section.textContent, /No action items found\.The note is already up to date:/);
  assert.equal(assistant.ledger.entries().length, 0, "trying counts nothing");
  await window.actleApps.notes.render(again, { ...helpers, api: { invoke: async () => ({ ok: false, error: "unknown channel notes:info" }) } }, {});
  assert.match(again.textContent, /dactle is not available: unknown channel notes:info/);
  const none = desk({ notes: null });
  const empty = dom.document.createElement("section");
  await window.actleApps.notes.render(empty, { ...helpers, api: { invoke: async (channel, payload) => none.assistant.invoke(channel, payload) } }, {});
  assert.match(empty.textContent, /The organisation policy has no note documents/);
  assert.match(empty.textContent, /Action patterns: TODO, ACTION/, "the default action settings still apply");
  const paused = desk({ paused: true });
  const banner = dom.document.createElement("section");
  await window.actleApps.notes.render(banner, { ...helpers, api: { invoke: async (channel, payload) => paused.assistant.invoke(channel, payload) } }, {});
  assert.match(banner.textContent, /Paused by your organisation: no documents are offered\./);
  const bodyOnly = desk({ notes: { documents: [{ id: "log", trigger: "/log", label: "Log", sections: [{ body: "{time} [[author]]" }, "Next"] }] } });
  const plain = dom.document.createElement("section");
  await window.actleApps.notes.render(plain, { ...helpers, api: { invoke: async (channel, payload) => bodyOnly.assistant.invoke(channel, payload) } }, {});
  const [row] = plain.querySelectorAll("tr").slice(1);
  assert.deepEqual(row.querySelectorAll("td").slice(0, 3).map((cell) => cell.textContent), ["/log", "Loglog", "(no heading), Next"], "a section without a heading is named as such");
  assert.deepEqual(row.querySelectorAll("p").map((p) => [p.className, p.textContent]), [["hint mono", "log"]], "the id is a p: the stylesheet mutes p.hint only");
});
