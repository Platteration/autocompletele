// actle Guard through the desktop assistant (plain Node): typing in a mail
// window raises masked warnings through the engine, the warning popover's
// submit fixes or dismisses them through a fake shell, and what reaches the
// metrics, the audit file and the dashboard channels. Then the two pages
// under a few lines of DOM.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const orgPolicy = require("../core/org-policy.js");
const { loadApps } = require("../desktop/apps/index.js");
const guardApp = require("../desktop/apps/guard/app.js");
const { fakeShell, MESSAGE, CHAT, CARD } = require("../desktop/apps/guard/simulate.js");
const { DEFAULTS } = require("../core/engine.js");
const { createAssistant } = require("../desktop/assistant.js");

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desktop", "apps", "guard", "sample-policy.json"), "utf8"));
const DISCLAIMER = "This message is confidential and intended for the addressee only.";
const NOW = new Date(2026, 9, 21, 10).getTime();
const OUTLOOK = { process: "C:\\Program Files\\Microsoft Office\\OUTLOOK.EXE", title: "Payment - Message" };

const folders = [];
test.after(() => { for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true }); });

function temp() {
  const dir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-guard-"));
  folders.push(dir);
  return dir;
}

function desk(extraPolicy, extra) {
  const dataDir = temp();
  const policy = Object.assign({
    organization: "Example Logistics",
    library: [{ trigger: "disc/", expansion: DISCLAIMER + "\n{cursor}" }, { trigger: "ack/", expansion: "Hi [[name]]" }],
    guard: SAMPLE,
  }, extraPolicy);
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(policy));
  const assistant = createAssistant(Object.assign({ dataDir, now: () => NOW, appIds: ["guard"] }, extra));
  return { assistant, dataDir, app: assistant.app("guard") };
}

/** Type through the assistant and return the Guard actions the shell would get. */
function type(assistant, text) {
  let actions = [];
  for (const ch of text) actions = actions.concat(assistant.keyTyped(ch === "\n" ? { text: "\n", resetsBuffer: true } : { text: ch }));
  return actions.filter((action) => action.type === "app" && action.app === "guard");
}

/**
 * The popover state main.js would hold. The shell shows one popover per
 * engine action; several actions merged here stand for rules that fired on
 * the same word end, so they must come from the same field.
 */
function popoverState(actions) {
  const focus = actions.length ? actions[0].focus : undefined;
  if (actions.some((action) => action.focus !== focus)) throw new Error("actions from different fields");
  return { kind: "app", app: "guard", popover: "warning", focus, hits: actions.flatMap((action) => action.hits) };
}

/** A shell whose sender waits until `release()` is called, like a paste still running in Electron. */
function pendingShell() {
  const shell = fakeShell();
  let release;
  shell.sender.replace = (action) => new Promise((resolve) => { release = (result) => resolve(result === undefined ? (shell.calls.replaced.push(action), { ok: true }) : result); });
  shell.release = (result) => release(result);
  return shell;
}

/** The simulator's stand-in, with a sender that answers through a promise like Electron's. */
function asyncShell() {
  const shell = fakeShell();
  const sync = shell.sender.replace;
  shell.sender.replace = (action) => Promise.resolve(sync(action));
  return shell;
}

const guardAudit = (assistant) => assistant.audit().filter((e) => e.event === "guard").map((e) => [e.rule, e.outcome]);

test("the sample section parses with no warnings and the app loads through the registry with the contract's shape", () => {
  const parsed = orgPolicy.parse({ guard: SAMPLE });
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.guard.packs.map((p) => p.id), ["pci", "gdpr", "legal"]);
  const [app] = loadApps({ policy: () => parsed, engine: { library: [], fieldText: "" }, now: () => NOW, log: () => {} }, { ids: ["guard"] });
  assert.equal(app.id, "guard");
  assert.equal(app.title, "Guard");
  assert.deepEqual(Object.keys(app.ipc), ["guard:info", "guard:summary", "guard:check"]);
  assert.equal(app.extension.id, "guard");
  assert.equal(typeof app.extension.check, "function");
  assert.equal(typeof app.extension.reset, "function");
  assert.equal(app.popovers.warning.file, "apps/guard-warning");
  assert.equal(app.popovers.warning.focusable, false, "the field keeps the focus, as with keyword offers");
  assert.deepEqual(guardApp.SIZE, { width: 460, base: 110, hit: 120, max: 640 });
  assert.deepEqual(app.popovers.warning.size({ hits: [{}, {}] }), { width: 460, height: 110 + 120 * 2 });
  assert.equal(app.popovers.warning.size(null).height, 110);
  assert.equal(app.popovers.warning.size({ hits: Array.from({ length: 5 }, () => ({})) }).height, 640, "capped: the page scrolls from five warnings on");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "desktop", "renderer", "apps", "guard-warning.html")));
  assert.deepEqual(app.ipc["guard:summary"](), { ok: true, entries: 0, summary: { total: { raised: 0, accepted: 0, dismissed: 0, unanswered: 0 }, byPack: [], byRule: [], skipped: 0 } }, "a host without a store has no audit trail");
  assert.deepEqual(guardApp.splitRecipients(" a@x.test, b@y.test;\nTeam chat,, "), ["a@x.test", "b@y.test", "Team chat"]);
  assert.deepEqual(guardApp.splitRecipients(["x", " ", null]), ["x"]);
});

test("typing in a mail window raises masked warnings once per field, audited as raised, and nothing of the text leaves the engine", () => {
  const { assistant, dataDir } = desk();
  assistant.focusChanged(OUTLOOK);
  const actions = type(assistant, "Please sign the contract. Card " + CARD + " now ");
  assert.deepEqual(actions.map((a) => a.hits.map((h) => h.rule)), [["contract-disclaimer"], ["card-number"]], "one action per word end that fired");
  assert.deepEqual(actions.map((a) => [a.type, a.app, a.popover, a.focus]), [["app", "guard", "warning", 1], ["app", "guard", "warning", 1]], "both stamped with the field that has the focus");
  const [contract, card] = actions.flatMap((a) => a.hits);
  assert.deepEqual(contract, { rule: "contract-disclaimer", pack: "legal", label: "Contract without the confidentiality notice", severity: "warn",
    message: "You are writing about a contract without the confidentiality notice.", findings: [{ kind: "keyword", value: "contract" }], fix: { kind: "text", text: DISCLAIMER, position: "end" } });
  assert.deepEqual(card.findings, [{ kind: "card-number", value: "**** **** **** 1111" }]);
  assert.deepEqual(card.fix, { kind: "remove", with: "[card number removed]" });
  assert.equal(card.severity, "block");
  assert.equal(JSON.stringify(actions).includes("4111"), false, "findings are masked");
  assert.deepEqual(guardAudit(assistant), [["contract-disclaimer", "raised"], ["card-number", "raised"]]);
  assert.equal(fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8").includes("1111"), false);
  assert.deepEqual(type(assistant, "another contract and " + CARD + " "), [], "each rule fires once per field");
  assistant.focusChanged({ process: "teams", title: "Chat" });
  const next = type(assistant, "the contract ");
  assert.equal(next.length, 1, "a new field fires again");
  assert.equal(next[0].focus, 2, "stamped with the next field");
  assert.equal(type(assistant, "password: hunter2 ")[0].hits[0].findings[0].value, "password: ****");
  assert.equal(JSON.stringify(assistant.audit()).includes("hunter2"), false);
});

test("rules for outside recipients stay silent from typing unless the policy sets assumeExternal", () => {
  const silent = desk();
  silent.assistant.focusChanged(OUTLOOK);
  assert.deepEqual(type(silent.assistant, "Her NIE is X1234567L, see PRJ-ORCA. "), [], "recipients are unknown to the shell");
  assert.deepEqual(silent.app.ipc["guard:check"]({ text: "Her NIE is X1234567L, see PRJ-ORCA.", recipients: "Buyer <buyer@customer.test>" }).hits.map((h) => [h.rule, h.findings.map((f) => f.value)]),
    [["national-id", ["*******7L"]], ["project-codes", ["PRJ-****"]]], "the dashboard's Try it takes recipients");
  const assumed = desk({ guard: Object.assign({}, SAMPLE, { assumeExternal: true }) });
  assumed.assistant.focusChanged(OUTLOOK);
  const typed = popoverState(type(assumed.assistant, "Her NIE is X1234567L, see PRJ-ORCA. "));
  assert.deepEqual(typed.hits.map((h) => [h.rule, h.findings.map((f) => f.value)]), [["national-id", ["*******7L"]], ["project-codes", ["PRJ-****"]]], "each rule fires at the word end that completes its finding");
  assert.equal(assumed.app.ipc["guard:info"]().assumeExternal, true);
  assert.deepEqual(assumed.app.ipc["guard:check"]({ text: "Her NIE is X1234567L", recipients: "a@example.com" }).hits, [], "known internal recipients still win");
});

test("the text fix is typed at the caret, counted as a guard insert, audited as fixed, and satisfies the rule from then on", async () => {
  const { assistant, app, dataDir } = desk();
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "Please sign the contract. "));
  const shell = asyncShell();
  const result = await app.popovers.warning.submit(state, { action: "fix", index: 0 }, shell);
  assert.deepEqual(result, { ok: true, rule: "contract-disclaimer", via: "typed", inserted: DISCLAIMER.length, keystrokesSaved: DISCLAIMER.length });
  assert.deepEqual(shell.calls.replaced, [{ backspaces: 0, text: DISCLAIMER, cursorOffset: DISCLAIMER.length }], "after a space no paragraph gap is needed");
  assert.deepEqual(shell.calls.copied, []);
  assert.equal(assistant.engine.fieldText, "Please sign the contract. " + DISCLAIMER, "the engine's field text keeps the insertion");
  const [entry] = assistant.ledger.entries();
  assert.equal(entry.kind, "guard");
  assert.equal(entry.trigger, "contract-disclaimer");
  assert.equal(entry.source, "organization");
  assert.equal(entry.app, "outlook");
  assert.deepEqual(guardAudit(assistant), [["contract-disclaimer", "raised"], ["contract-disclaimer", "fixed"]]);
  assert.equal(fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8").includes("Please sign"), false);
  assert.deepEqual(assistant.usageReport().byShortcut.map((s) => [s.kind, s.trigger, s.inserts]), [["guard", "contract-disclaimer", 1]]);
  assert.deepEqual(await app.popovers.warning.submit(state, { action: "fix", index: 0 }, shell), { ok: false, error: "This warning was already fixed." });
  assistant.focusChanged(OUTLOOK);
  assert.deepEqual(type(assistant, DISCLAIMER + " Another contract. "), [], "the disclaimer typed before the keyword satisfies `unless` in a new field");
  const again = desk({ guard: { packs: [{ id: "p", rules: [{ id: "terms", keywords: ["contract"], message: "m", fix: { kind: "text", text: "See the attached terms." } }] }] } });
  again.assistant.focusChanged(OUTLOOK);
  const typed = popoverState(type(again.assistant, "The contract. See the attached terms. "));
  assert.deepEqual(typed.hits.map((h) => h.rule), ["terms"], "raised when the word ended, before the terms were typed");
  assert.deepEqual(await again.app.submit(typed, { action: "fix", index: 0 }, asyncShell()), { ok: false, error: "The fix text is already in the message." });
  const gap = desk({ guard: { packs: [{ id: "p", rules: [{ id: "terms", keywords: ["contract"], message: "m", fix: { kind: "text", text: "See the attached terms." } }] }] } });
  gap.assistant.focusChanged(OUTLOOK);
  const close = asyncShell();
  assert.equal((await gap.app.submit(popoverState(type(gap.assistant, "The contract.")), { action: "fix", index: 0 }, close)).inserted, 2 + "See the attached terms.".length);
  assert.deepEqual(close.calls.replaced[0], { backspaces: 0, text: "\n\nSee the attached terms.", cursorOffset: 2 + "See the attached terms.".length }, "a paragraph gap after punctuation");
});

test("a remove fix cannot edit the field: the corrected text goes to the clipboard with a notification, and nothing is counted", async () => {
  const { assistant, app } = desk();
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "Pay with " + CARD + " or 5555 5555 5555 4444 today "));
  const shell = asyncShell();
  assert.deepEqual(await app.submit(state, { action: "fix", index: 0 }, shell), { ok: true, rule: "card-number", via: "clipboard", inserted: 0 });
  assert.deepEqual(shell.calls.copied, ["Pay with [card number removed] or [card number removed] today "]);
  assert.deepEqual(shell.calls.notified, [guardApp.CLIPBOARD_NOTE]);
  assert.deepEqual(shell.calls.replaced, []);
  assert.deepEqual(assistant.ledger.entries(), [], "nothing was inserted, so nothing is counted");
  assert.deepEqual(guardAudit(assistant), [["card-number", "raised"], ["card-number", "fixed"]]);
  const stale = desk();
  stale.assistant.focusChanged(OUTLOOK);
  const typed = popoverState(type(stale.assistant, "Pay with " + CARD + " "));
  stale.assistant.focusChanged({ process: "teams" });
  assert.deepEqual(await stale.app.submit(typed, { action: "fix", index: 0 }, asyncShell()), { ok: false, error: guardApp.FOCUS_MOVED }, "the focus moved: refused before the field is looked at");
  const erased = desk();
  erased.assistant.focusChanged(OUTLOOK);
  const gone = popoverState(type(erased.assistant, "Pay with " + CARD + " "));
  for (let i = 0; i < ("Pay with " + CARD + " ").length; i++) erased.assistant.keyTyped({ isBackspace: true });
  assert.equal(erased.assistant.engine.fieldText, "");
  assert.deepEqual(await erased.app.submit(gone, { action: "fix", index: 0 }, asyncShell()), { ok: false, error: "actle saw no text in this field; correct it by hand." }, "same field, everything backspaced");
  const moved = desk({ guard: { packs: [{ id: "p", rules: [{ id: "asap", keywords: ["asap"], message: "m", fix: { kind: "remove" } }, { id: "start", keywords: ["hello"], message: "m", fix: { kind: "text", text: "Dear customer,", position: "start" } }] }] } });
  moved.assistant.focusChanged(OUTLOOK);
  const both = popoverState(type(moved.assistant, "Reply asap hello "));
  for (const ch of "\b\b\b\b\b\b\b\b\b\b\b") moved.assistant.keyTyped({ isBackspace: true });
  assert.deepEqual(await moved.app.submit(both, { action: "fix", index: 0 }, asyncShell()), { ok: false, error: "Nothing to correct in the text actle saw in this field." });
  const first = asyncShell();
  assert.deepEqual(await moved.app.submit(both, { action: "fix", index: 1 }, first), { ok: true, rule: "start", via: "clipboard", inserted: 0 });
  assert.deepEqual(first.calls.copied, ["Dear customer,\n\nReply "], "a text fix at the start also goes through the clipboard");
});

test("a message longer than the engine holds gets no clipboard fix: the copy would start mid-word", async () => {
  const { assistant, app } = desk();
  assistant.focusChanged(OUTLOOK);
  const sentence = "Dear customer, thank you for your order. ";
  const state = popoverState(type(assistant, sentence.repeat(110) + "card " + CARD + " "));
  assert.equal(assistant.engine.fieldText.length, DEFAULTS.maxFieldText, "the engine kept the last 4,000 characters only");
  assert.equal(assistant.engine.fieldText.startsWith("Dear"), false);
  const shell = asyncShell();
  assert.deepEqual(await app.submit(state, { action: "fix", index: 0 }, shell), { ok: false, error: guardApp.TOO_LONG });
  assert.match(guardApp.TOO_LONG, /4000 characters/);
  assert.deepEqual(shell.calls.copied, []);
  assert.deepEqual(shell.calls.notified, []);
  assert.deepEqual(guardAudit(assistant), [["card-number", "raised"]], "not a fix");
  assert.deepEqual(await app.submit(state, { action: "dismiss" }, shell), { ok: true, dismissed: 1 }, "Dismiss still answers it");
  assert.match(guardApp.CLIPBOARD_NOTE, /covers only what you typed in this field/, "the note never asks for the whole field to be replaced");
  const short = desk();
  short.assistant.focusChanged(OUTLOOK);
  const fits = popoverState(type(short.assistant, sentence.repeat(90) + "card " + CARD + " "));
  assert.ok(short.assistant.engine.fieldText.length < DEFAULTS.maxFieldText);
  const ok = asyncShell();
  assert.equal((await short.app.submit(fits, { action: "fix", index: 0 }, ok)).via, "clipboard", "under the cap the whole typed text is corrected");
  assert.equal(ok.calls.copied[0], sentence.repeat(90) + "card [card number removed] ");
});

test("a fix clicked after the focus moved is refused for every kind: nothing is typed into the other application", async () => {
  const rules = [
    { id: "disc", keywords: ["contract"], message: "m", fix: { kind: "shorthand", trigger: "disc/" } },
    { id: "terms", keywords: ["terms"], message: "m", fix: { kind: "text", text: "See the attached terms." } },
  ];
  const { assistant, app } = desk({ guard: { packs: [{ id: "p", rules }] } });
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "contract terms "));
  assert.deepEqual(state.hits.map((h) => h.rule), ["disc", "terms"]);
  assistant.focusChanged({ process: "Teams.exe", title: "Chat" });
  type(assistant, "hi there ");
  const shell = asyncShell();
  assert.deepEqual(await app.submit(state, { action: "fix", index: 0 }, shell), { ok: false, error: guardApp.FOCUS_MOVED }, "shorthand");
  assert.deepEqual(await app.submit(state, { action: "fix", index: 1 }, shell), { ok: false, error: guardApp.FOCUS_MOVED }, "text");
  assert.deepEqual(shell.calls.replaced, []);
  assert.deepEqual(shell.calls.copied, []);
  assert.deepEqual(assistant.ledger.entries(), [], "nothing counted under the chat application");
  assert.deepEqual(guardAudit(assistant), [["disc", "raised"], ["terms", "raised"]]);
  assert.deepEqual(await app.submit(state, { action: "dismiss" }, shell), { ok: true, dismissed: 2 }, "Dismiss answers a stale popover");
  assert.deepEqual(await app.submit({ kind: "app", app: "guard", hits: state.hits }, { action: "fix", index: 0 }, shell), { ok: false, error: "This warning was already dismissed." });
  const unstamped = desk({ guard: { packs: [{ id: "p", rules }] } });
  unstamped.assistant.focusChanged(OUTLOOK);
  const hits = type(unstamped.assistant, "contract ").flatMap((a) => a.hits);
  assert.deepEqual(await unstamped.app.submit({ kind: "app", app: "guard", hits }, { action: "fix", index: 0 }, shell), { ok: false, error: guardApp.FOCUS_MOVED }, "a state without the stamp is not a live popover");
  unstamped.assistant.setEnabled(false);
  unstamped.assistant.setEnabled(true);
  const toggled = popoverState(type(unstamped.assistant, "terms "));
  assert.equal(toggled.focus, 3, "pausing and resuming actle resets the field too");
});

test("Dismiss while a fix is still pasting skips that warning, so it is never both fixed and dismissed", async () => {
  const { assistant, app } = desk();
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "the contract is guaranteed "));
  assert.deepEqual(state.hits.map((h) => h.rule), ["contract-disclaimer", "no-guarantees"]);
  const shell = pendingShell();
  const fixing = app.submit(state, { action: "fix", index: 0 }, shell);
  assert.equal(state.hits[0].outcome, "fixing");
  assert.deepEqual(await app.submit(state, { action: "fix", index: 0 }, shell), { ok: false, error: "This fix is still being applied." });
  assert.deepEqual(await app.submit(state, { action: "dismiss" }, shell), { ok: true, dismissed: 1 }, "only the other warning");
  shell.release();
  assert.equal((await fixing).ok, true);
  assert.deepEqual(guardAudit(assistant), [["contract-disclaimer", "raised"], ["no-guarantees", "raised"], ["no-guarantees", "dismissed"], ["contract-disclaimer", "fixed"]]);
  assert.deepEqual(assistant.invoke("guard:summary").summary.byRule.map((r) => [r.rule, r.accepted, r.dismissed]), [["contract-disclaimer", 1, 0], ["no-guarantees", 0, 1]]);
  const retry = desk();
  retry.assistant.focusChanged(OUTLOOK);
  const again = popoverState(type(retry.assistant, "the contract "));
  const failing = pendingShell();
  const refused = retry.app.submit(again, { action: "fix", index: 0 }, failing);
  failing.release({ ok: false, error: "no paste" });
  assert.deepEqual(await refused, { ok: false, error: "Could not insert the text: no paste" });
  assert.equal(again.hits[0].outcome, undefined, "a failed paste clears the mark");
  const thrown = pendingShell();
  thrown.sender.replace = () => Promise.reject(new Error("xdotool is not installed"));
  assert.deepEqual(await retry.app.submit(again, { action: "fix", index: 0 }, thrown), { ok: false, error: "Could not insert the text: xdotool is not installed" }, "a rejected paste is a refusal, not a throw");
  assert.equal(again.hits[0].outcome, undefined);
  const sync = fakeShell();
  sync.sender.replace = () => { throw new Error("no sender"); };
  assert.deepEqual(retry.app.submit(again, { action: "fix", index: 0 }, sync), { ok: false, error: "Could not insert the text: no sender" });
  assert.equal((await retry.app.submit(again, { action: "fix", index: 0 }, asyncShell())).ok, true, "and the fix can be tried again");
  assert.deepEqual(guardAudit(retry.assistant), [["contract-disclaimer", "raised"], ["contract-disclaimer", "fixed"]]);
});

test("a shorthand fix inserts the policy's shortcut rendered; blanks and unknown triggers are refused", async () => {
  const rules = [
    { id: "disc", keywords: ["contract"], message: "m", fix: { kind: "shorthand", trigger: "disc/" } },
    { id: "blank", keywords: ["ack"], message: "m", fix: { kind: "shorthand", trigger: "ack/" } },
    { id: "ghost", keywords: ["ghost"], message: "m", fix: { kind: "shorthand", trigger: "nope/" } },
    { id: "nofix", detect: ["secret"], message: "m" },
  ];
  const { assistant, app } = desk({ guard: { packs: [{ id: "p", rules }] } });
  assistant.importLibrary(JSON.stringify({ version: 1, shorthands: [{ trigger: "disc/", expansion: "MY OWN" }] }));
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "contract ack ghost token: abcd1234efgh5678ijkl9012mnop "));
  assert.deepEqual(state.hits.map((h) => h.rule), ["disc", "blank", "ghost", "nofix"]);
  const shell = asyncShell();
  const result = await app.submit(state, { action: "fix", index: 0 }, shell);
  assert.equal(result.ok, true);
  assert.equal(result.via, "typed");
  assert.deepEqual(shell.calls.replaced, [{ backspaces: 0, text: DISCLAIMER + "\n", cursorOffset: DISCLAIMER.length + 1 }], "the organisation's shortcut, not the person's copy; {cursor} places the caret");
  assert.deepEqual(assistant.ledger.entries().map((e) => [e.kind, e.trigger]), [["guard", "disc"]]);
  assert.deepEqual(await app.submit(state, { action: "fix", index: 1 }, shell), { ok: false, error: "Shortcut ack/ asks for blanks; type ack/ in the field to fill them in." });
  assert.deepEqual(await app.submit(state, { action: "fix", index: 2 }, shell), { ok: false, error: "Shortcut nope/ is not in the library." });
  assert.deepEqual(await app.submit(state, { action: "fix", index: 3 }, shell), { ok: false, error: "This warning has no fix to apply." });
  assert.deepEqual(await app.submit(state, { action: "fix", index: 9 }, shell), { ok: false, error: "Choose a warning first." });
  assert.deepEqual(await app.submit(state, { action: "fix" }, shell), { ok: false, error: "Choose a warning first." });
  assert.deepEqual(await app.submit(state, { action: "nope", index: 0 }, shell), { ok: false, error: "Unknown action nope." });
  assert.deepEqual(await app.submit(null, null, shell), { ok: false, error: "Unknown action undefined." });
  assert.equal(shell.calls.replaced.length, 1, "refusals type nothing");
  const own = desk({ guard: { packs: [{ id: "p", rules: rules.slice(0, 1) }] }, library: [] });
  own.assistant.importLibrary(JSON.stringify({ version: 1, shorthands: [{ trigger: "disc/", expansion: "My own notice" }] }));
  own.assistant.focusChanged(OUTLOOK);
  const mine = asyncShell();
  assert.equal((await own.app.submit(popoverState(type(own.assistant, "contract ")), { action: "fix", index: 0 }, mine)).ok, true);
  assert.equal(mine.calls.replaced[0].text, "My own notice", "a personal shortcut is used only when the policy has none");
  const failing = desk({ guard: { packs: [{ id: "p", rules: rules.slice(0, 1) }] } });
  failing.assistant.focusChanged(OUTLOOK);
  const broken = asyncShell();
  broken.sender.replace = () => Promise.resolve({ ok: false, error: "xdotool is not installed" });
  assert.deepEqual(await failing.app.submit(popoverState(type(failing.assistant, "contract ")), { action: "fix", index: 0 }, broken), { ok: false, error: "Could not insert the text: xdotool is not installed" });
  assert.deepEqual(failing.assistant.ledger.entries(), []);
  assert.deepEqual(guardAudit(failing.assistant), [["disc", "raised"]], "a failed paste is not a fix");
});

test("Dismiss answers every warning in the popover that was not fixed; the summary counts raised, fixed, dismissed and unanswered", async () => {
  const { assistant, app } = desk();
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "Sign the contract, it is guaranteed, card " + CARD + " "));
  assert.deepEqual(state.hits.map((h) => h.rule), ["contract-disclaimer", "no-guarantees", "card-number"]);
  const shell = asyncShell();
  assert.equal((await app.submit(state, { action: "fix", index: 0 }, shell)).ok, true);
  assert.deepEqual(await app.submit(state, { action: "dismiss" }, shell), { ok: true, dismissed: 2 });
  assert.deepEqual(await app.submit(state, { action: "dismiss" }, shell), { ok: true, dismissed: 0 });
  assert.deepEqual(await app.submit(state, { action: "fix", index: 2 }, shell), { ok: false, error: "This warning was already dismissed." });
  assistant.focusChanged(OUTLOOK);
  const second = popoverState(type(assistant, "guaranteed and " + CARD + " "));
  assert.deepEqual(await app.submit(second, { action: "dismiss", index: 1 }, shell), { ok: true, dismissed: 1 }, "a dismiss with an index answers that warning only");
  const { summary, entries } = assistant.invoke("guard:summary");
  assert.equal(entries, 9);
  assert.deepEqual(summary.total, { raised: 5, accepted: 1, dismissed: 3, unanswered: 1 });
  assert.deepEqual(summary.byPack, [
    { pack: "legal", raised: 3, accepted: 1, dismissed: 1, unanswered: 1 },
    { pack: "pci", raised: 2, accepted: 0, dismissed: 2, unanswered: 0 },
  ]);
  assert.deepEqual(summary.byRule.map((r) => [r.rule, r.raised, r.accepted, r.dismissed, r.unanswered]), [["card-number", 2, 0, 2, 0], ["no-guarantees", 2, 0, 1, 1], ["contract-disclaimer", 1, 1, 0, 0]]);
  fs.appendFileSync(path.join(assistant.store.root, "audit.jsonl"), JSON.stringify({ event: "guard", rule: "x", outcome: "maybe" }) + "\n");
  assert.equal(assistant.invoke("guard:summary").summary.skipped, 1, "odd audit lines are skipped, not fatal");
});

test("dashboard channels: info describes packs, rules, fixes and domains; check masks and audits nothing; a bare policy says so", () => {
  const { assistant } = desk({ guard: Object.assign({}, SAMPLE, { internalDomains: ["example.com", "not a domain"] }) });
  const info = assistant.invoke("guard:info");
  assert.equal(info.configured, true);
  assert.equal(info.paused, false);
  assert.equal(info.assumeExternal, false);
  assert.deepEqual(info.internalDomains, ["example.com"]);
  assert.deepEqual(info.internalCodes, ["\\bPRJ-[A-Z]{3,8}\\b"]);
  assert.deepEqual(info.detectors, ["card-number", "iban", "email", "phone", "national-id", "forbidden-phrase", "internal-code", "secret"]);
  assert.deepEqual(info.countries, ["US", "GB", "ES", "FR"]);
  assert.deepEqual(info.warnings, ["guard internal domain not a domain ignored: not a domain name"]);
  assert.deepEqual(info.packs.map((p) => [p.id, p.label, p.rules.map((r) => r.id)]), [["pci", "Card data (PCI DSS)", ["card-number"]], ["gdpr", "Personal data (GDPR)", ["national-id", "secrets"]], ["legal", "Legal", ["contract-disclaimer", "no-guarantees", "project-codes"]]]);
  const ids = info.packs[1].rules[0];
  assert.deepEqual(ids, { id: "national-id", label: "National ID number to an outside recipient", pack: "gdpr", severity: "warn", recipients: "external", message: "A national identification number is going to someone outside the organisation.",
    detect: ["national-id"], keywords: [], match: "any", caseSensitive: false, phrases: [], countries: ["GB", "ES", "FR"], unless: [], apps: [], fix: { kind: "remove", with: "" } });
  assert.deepEqual(info.packs[2].rules[1].phrases, ["guaranteed", "100% safe", "risk-free"]);
  assert.deepEqual(info.packs[2].rules[0].fix, { kind: "text", text: DISCLAIMER, position: "end" });
  const tried = assistant.invoke("guard:check", { text: "pay " + CARD + " to IBAN DE89 3704 0044 0532 0130 00, password: hunter2", recipients: ["Buyer <b@customer.test>", "a@example.com"] });
  assert.deepEqual(tried.hits.map((h) => [h.rule, h.findings.map((f) => f.value)]), [["card-number", ["**** **** **** 1111"]], ["secrets", ["password: ****"]]]);
  assert.equal(tried.recipients, 2);
  assert.equal(tried.external, true);
  assert.equal(JSON.stringify(tried).includes("hunter2") || JSON.stringify(tried).includes("4111"), false);
  assert.deepEqual(assistant.invoke("guard:check", { text: "nothing here", recipients: "" }), { ok: true, recipients: 0, external: false, app: "", hits: [] });
  assert.deepEqual(assistant.invoke("guard:check", null).hits, []);
  const limited = desk({ guard: { packs: [{ id: "p", rules: [{ id: "only-outlook", keywords: ["contract"], apps: ["OUTLOOK.EXE"], message: "m" }] }] } });
  assert.deepEqual(limited.assistant.invoke("guard:check", { text: "the contract", recipients: "" }).hits, [], "a rule limited to applications needs the application");
  const tried2 = limited.assistant.invoke("guard:check", { text: "the contract", recipients: "", app: "C:\\Program Files\\OUTLOOK.EXE" });
  assert.equal(tried2.app, "outlook");
  assert.deepEqual(tried2.hits.map((h) => h.rule), ["only-outlook"]);
  assert.deepEqual(guardAudit(assistant), [], "Try it audits nothing");
  assert.deepEqual(assistant.ledger.entries(), []);
  const bare = desk({ guard: undefined, paused: { message: "Audit" } });
  const none = bare.assistant.invoke("guard:info");
  assert.equal(none.configured, false);
  assert.equal(none.paused, true);
  assert.deepEqual(none.packs, []);
  bare.assistant.focusChanged(OUTLOOK);
  assert.deepEqual(type(bare.assistant, "card " + CARD + " "), [], "no packs, no warnings");
  assert.equal(bare.assistant.engine.fieldText, "", "without rule packs the engine does not keep the field's text");
  assert.equal(bare.app.extension.check, undefined);
});

test("the simulation walks through the sample headlessly, with or without a guard section in the policy", () => {
  for (const extra of [{}, { guard: undefined }]) {
    const { assistant, app } = desk(extra);
    const lines = [];
    const focus = (context) => { assistant.focusChanged(context); lines.push("[focus] " + context.process); };
    let clock = NOW;
    app.simulate({ print: (line) => lines.push(line), assistant, focus, tick: (ms) => { clock += ms; }, now: () => clock, brief: (text) => JSON.stringify(text).slice(0, 70) });
    const text = lines.join("\n");
    assert.equal(text.includes("the policy has no guard section"), "guard" in extra);
    assert.match(text, /\[focus\] OUTLOOK\.EXE[\s\S]*\[focus\] Teams\.exe[\s\S]*\[focus\] chrome\.exe/);
    assert.equal(text.match(/popover \(1 warning, masked\):/g).length, 4, "one popover per word end that fired");
    assert.match(text, /block pci\/card-number: A payment card number[^\n]*\n\s+found card-number "\*\*\*\* \*\*\*\* \*\*\*\* 1111"; fix: remove\n\s+Dismiss -> 1 warning\(s\) dismissed/);
    assert.match(text, /warn legal\/contract-disclaimer: You are writing about a contract[^\n]*\n\s+found keyword "contract"; fix: text\n\s+Fix "Contract without the confidentiality notice" -> typed 65 characters at the caret/);
    assert.match(text, /info legal\/no-guarantees[\s\S]*a new warning replaces the window: no-guarantees left unanswered/);
    assert.match(text, /Fix clicked after the focus moved -> refused: The focus moved since this warning was raised; type the fix by hand\./);
    assert.equal(text.match(/Dismiss -> 1 warning\(s\) dismissed/g).length, 2);
    assert.match(text, /Try it with an outside recipient -> national-id \[\*\*\*\*\*\*\*7L\]; project-codes \[PRJ-\*\*\*\*\]/);
    assert.match(text, /counts: 4 raised, 1 fixed, 2 dismissed, 1 unanswered/);
    assert.match(text, /legal\/no-guarantees: raised 1, fixed 0, dismissed 0, unanswered 1/);
    assert.match(text, /audit log holds card digits: no; typed text: no/);
    assert.equal(text.includes(CARD), false);
    assert.equal(text.includes("4111"), false);
    assert.deepEqual(assistant.ledger.entries().map((e) => [e.kind, e.app]), [["guard", "outlook"]], "the one typed fix, counted under the mail window");
    assert.equal(MESSAGE.includes(CARD), true);
    assert.deepEqual(guardAudit(assistant).filter(([, outcome]) => outcome !== "raised"), [["card-number", "dismissed"], ["contract-disclaimer", "fixed"], ["contract-disclaimer", "dismissed"]]);
    assert.ok(CHAT.includes("guaranteed"));
  }
});

// ---- The two pages, run under Node with a few lines of DOM ----------------
// Enough for what renderer/apps/guard-warning.js and guard.js do: elements
// with text, class, attributes, children, listeners; getElementById; one-tag
// selectors. Not a browser: layout, styles and real keyboard behaviour stay
// unverified here.
function createDom() {
  const byId = new Map();
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, text: "", value: "", disabled: false }); }
    get id() { return this.attrs.id || ""; }
    set id(value) { this.setAttribute("id", value); }
    get className() { return this.attrs.class || ""; }
    set className(value) { this.attrs.class = value; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.text = String(value); this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === "id") byId.set(String(value), this); }
    append(...nodes) { for (const node of nodes) this.children.push(node); }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    dispatch(name, extra) { return Promise.all((this.listeners[name] || []).map((fn) => fn(Object.assign({ target: this, preventDefault() {} }, extra || {})))); }
    all() { return this.children.flatMap((child) => [child, ...child.all()]); }
    querySelectorAll(tag) { return this.all().filter((node) => node.tagName === tag.toUpperCase()); }
    querySelector(tag) { return this.querySelectorAll(tag)[0] || null; }
  }
  const body = new Node("body");
  const document = { body, createElement: (tag) => new Node(tag), getElementById: (id) => byId.get(id) || null, addEventListener: (name, fn) => body.addEventListener(name, fn), dispatch: (name, extra) => body.dispatch(name, extra) };
  const page = (ids) => { for (const [tag, id] of ids) { const node = new Node(tag); node.id = id; body.append(node); } };
  return { document, page };
}

function runPage(file, document, actle) {
  const sandbox = { window: { actle }, document };
  return { done: vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "apps", file), "utf8"), sandbox), window: sandbox.window };
}

test("the warning popover page shows severity, message, masked findings and a fix button per warning, keeps a refusal readable, and dismisses", async () => {
  const { assistant, app } = desk();
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "the contract, password: hunter2 and " + CARD + " "));
  const shell = asyncShell();
  const dom = createDom();
  dom.page([["h1", "heading"], ["ul", "list"], ["p", "error"], ["button", "dismiss"]]);
  let closed = 0;
  await runPage("guard-warning.js", dom.document, { getPopover: async () => state, submitPopover: (payload) => app.submit(state, payload, shell), closePopover: () => { closed += 1; } }).done;
  const $ = (id) => dom.document.getElementById(id);
  const items = $("list").querySelectorAll("li");
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.className), ["warning", "warning", "warning"]);
  assert.equal(items[0].textContent, "Contract without the confidentiality noticewarningYou are writing about a contract without the confidentiality notice.Found keyword: contractAdd the text");
  assert.equal(items[1].textContent, "Password or token in a messagemust not be sentNever send passwords or tokens in a message. Use the password manager's sharing feature.Found secret: password: ****");
  assert.match(items[2].textContent, /must not be sent.*Found card-number: \*\*\*\* \*\*\*\* \*\*\*\* 1111Copy corrected text$/);
  assert.equal(items[1].querySelectorAll("button").length, 0, "no fix, no button");
  assert.equal($("list").textContent.includes("hunter2") || $("list").textContent.includes("4111"), false);
  await items[0].querySelector("button").dispatch("click");
  assert.equal(shell.calls.replaced.length, 1);
  assert.equal($("error").textContent, "");
  await items[0].querySelector("button").dispatch("click");
  assert.equal($("error").textContent, "This warning was already fixed.", "a refusal stays readable");
  assert.equal(items[0].querySelector("button").disabled, false);
  await items[2].querySelector("button").dispatch("click");
  assert.equal(shell.calls.copied.length, 1);
  await $("dismiss").dispatch("click");
  assert.deepEqual(guardAudit(assistant).slice(3), [["contract-disclaimer", "fixed"], ["card-number", "fixed"], ["secrets", "dismissed"]]);
  await dom.document.dispatch("keydown", { key: "Escape" });
  assert.equal(closed, 1, "the handler exists; a non-focusable window never gets the key, see the page comment");
  const other = createDom();
  let refused = 0;
  await runPage("guard-warning.js", other.document, { getPopover: async () => ({ kind: "keyword" }), closePopover: () => { refused += 1; } }).done;
  assert.equal(refused, 1, "a state that is not Guard's closes the popover");

  // A text fix at the start goes to the clipboard, and the button says so; while a fix is pasting every button is disabled.
  const start = desk({ guard: { packs: [{ id: "p", rules: [{ id: "dear", keywords: ["hello"], message: "m", fix: { kind: "text", text: "Dear customer,", position: "start" } }, { id: "disc", keywords: ["contract"], message: "m", fix: { kind: "shorthand", trigger: "disc/" } }] }] } });
  start.assistant.focusChanged(OUTLOOK);
  const two = popoverState(type(start.assistant, "hello contract "));
  const pending = pendingShell();
  const page = createDom();
  page.page([["h1", "heading"], ["ul", "list"], ["p", "error"], ["button", "dismiss"]]);
  await runPage("guard-warning.js", page.document, { getPopover: async () => two, submitPopover: (payload) => start.app.submit(two, payload, pending), closePopover: () => {} }).done;
  const buttons = page.document.getElementById("list").querySelectorAll("button");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Copy corrected text", "Insert disc/"]);
  const clicked = buttons[1].dispatch("click");
  await Promise.resolve();
  assert.deepEqual([...buttons, page.document.getElementById("dismiss")].map((b) => b.disabled), [true, true, true], "one answer at a time");
  await page.document.getElementById("dismiss").dispatch("click");
  assert.equal(two.hits[1].outcome, "fixing", "the second click did nothing");
  assert.equal(two.hits[0].outcome, undefined);
  pending.release();
  await clicked;
  assert.equal(two.hits[1].outcome, "fixed");
  assert.deepEqual(pending.calls.replaced.map((r) => r.text), [DISCLAIMER + "\n"]);
  assert.deepEqual(guardAudit(start.assistant), [["dear", "raised"], ["disc", "raised"], ["disc", "fixed"]], "Dismiss did not count anything while the fix was pasting");
});

test("the dashboard page lists packs and rules, the counts, and tries a text with recipients", async () => {
  const { assistant, app } = desk();
  assistant.focusChanged(OUTLOOK);
  const state = popoverState(type(assistant, "the contract and " + CARD + " "));
  await app.submit(state, { action: "fix", index: 0 }, asyncShell());
  const dom = createDom();
  const messages = [];
  const el = (tag, attrs, children) => {
    const node = dom.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) { if (key === "class") node.className = value; else if (key === "text") node.textContent = value; else node.setAttribute(key, value); }
    for (const child of children || []) node.append(child);
    return node;
  };
  const helpers = { api: { invoke: async (channel, payload) => assistant.invoke(channel, payload) }, el, text: (node, value) => { node.textContent = value == null ? "" : String(value); }, announce: (m) => messages.push(m), seconds: (n) => n + " s", preview: (value) => String(value || "").replace(/\s+/g, " ").slice(0, 140) };
  const { window } = runPage("guard.js", dom.document, {});
  const section = dom.document.createElement("section");
  await window.actleApps.guard.render(section, helpers, {});
  const rows = section.querySelectorAll("tr").map((row) => row.querySelectorAll("td").map((cell) => cell.textContent));
  assert.deepEqual(rows[1], ["Card data (PCI DSS)pci", "Card number in a messagecard-number", "block", "detects card-number", "any", "replace with [card number removed] (to the clipboard)"]);
  assert.deepEqual(rows[2].slice(2), ["warn", "detects national-id (GB, ES, FR)", "outside only", "remove (to the clipboard)"]);
  assert.deepEqual(rows[4].slice(3), ["contract, agreement; unless: This message is confidential", "any", "add text: " + DISCLAIMER]);
  assert.deepEqual(rows[5][3], "detects forbidden-phrase: guaranteed, 100% safe, risk-free");
  assert.deepEqual(rows[7], [], "the counts table's header row");
  assert.deepEqual(rows[8], ["All rules", "2", "1", "0", "1"]);
  assert.deepEqual(rows[9], ["Pack legal", "1", "1", "0", "0"]);
  assert.deepEqual(rows[10], ["Pack pci", "1", "0", "0", "1"]);
  assert.deepEqual(rows[11], ["pci / card-number", "1", "0", "0", "1"]);
  assert.deepEqual(rows[12], ["legal / contract-disclaimer", "1", "1", "0", "0"]);
  assert.match(section.textContent, /Internal domains: example\.com\. Internal code patterns: \\bPRJ-\[A-Z\]\{3,8\}\\b\./);
  assert.match(section.textContent, /stay silent unless the policy sets assumeExternal/);
  const box = section.querySelector("textarea");
  box.value = "Her NIE is X1234567L";
  await box.dispatch("input");
  const [recipients, application] = section.querySelectorAll("input");
  assert.deepEqual([recipients.attrs["aria-label"], application.attrs["aria-label"]], ["Recipients", "Application"]);
  recipients.value = "buyer@customer.test";
  await recipients.dispatch("input");
  await section.querySelectorAll("button").find((b) => b.textContent === "Check").dispatch("click");
  assert.deepEqual(messages, ["1 rule fires"]);
  assert.match(section.textContent, /gdpr \/ national-id \(warn\); fix: remove/);
  assert.match(section.textContent, /Found national-id ES: \*\*\*\*\*\*\*7L/);
  assert.equal(section.textContent.includes("X1234567L"), false);
  assert.match(section.textContent, /Rules limited to applications fire only when the application is given/);
  const again = dom.document.createElement("section");
  await window.actleApps.guard.render(again, helpers, {});
  assert.equal(again.querySelector("textarea").value, "Her NIE is X1234567L", "the draft survives a re-render");
  assert.equal(again.querySelector("input").value, "buyer@customer.test");
  assert.match(again.textContent, /gdpr \/ national-id/, "so does the last result");
  assert.equal(assistant.invoke("guard:summary").entries, 3, "Try it counted nothing: two raised and one fixed");
  const limited = desk({ guard: { packs: [{ id: "p", rules: [{ id: "only-outlook", keywords: ["contract"], apps: ["outlook"], message: "m" }] }] } });
  const apps = dom.document.createElement("section");
  const limitedHelpers = { ...helpers, api: { invoke: async (channel, payload) => limited.assistant.invoke(channel, payload) } };
  await window.actleApps.guard.render(apps, limitedHelpers, {});
  assert.match(apps.textContent, /in outlook/, "the rule row names its application");
  apps.querySelector("textarea").value = "the contract";
  await apps.querySelector("textarea").dispatch("input");
  assert.equal(apps.querySelectorAll("input")[0].value, "buyer@customer.test", "the drafts are the page's, whatever desk answers");
  apps.querySelectorAll("input")[0].value = "";
  await apps.querySelectorAll("input")[0].dispatch("input");
  await apps.querySelectorAll("button").find((b) => b.textContent === "Check").dispatch("click");
  assert.match(apps.textContent, /No rule fires on this text\./, "no application typed in");
  const appBox = apps.querySelectorAll("input")[1];
  appBox.value = "OUTLOOK.EXE";
  await appBox.dispatch("input");
  await apps.querySelectorAll("button").find((b) => b.textContent === "Check").dispatch("click");
  assert.match(apps.textContent, /p \/ only-outlook \(warn\)/, "typed in, the rule limited to it fires");
  const refreshed = dom.document.createElement("section");
  await window.actleApps.guard.render(refreshed, limitedHelpers, {});
  assert.equal(refreshed.querySelectorAll("input")[1].value, "OUTLOOK.EXE", "the application survives a re-render");
  const empty = desk({ guard: undefined });
  const bare = dom.document.createElement("section");
  await window.actleApps.guard.render(bare, { ...helpers, api: { invoke: async (channel, payload) => empty.assistant.invoke(channel, payload) } }, {});
  assert.match(bare.textContent, /has no rule packs/);
  assert.match(bare.textContent, /No warnings recorded yet/);
  await window.actleApps.guard.render(bare, { ...helpers, api: { invoke: async () => ({ ok: false, error: "unknown channel guard:info" }) } }, {});
  assert.match(bare.textContent, /Guard is not available: unknown channel guard:info/);
});
