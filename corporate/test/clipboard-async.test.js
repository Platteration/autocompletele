// Electron 44, the version the desktop app pins, answers clipboard reads and
// writes with promises (readText(): Promise<string>, writeText(): Promise<void>).
// The apps' own tests use stand-ins that answer at once; these drive the apps
// that touch the clipboard with a promise-returning one, through the
// assistant and the example policy, as the shell would.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAssistant } = require("../desktop/assistant.js");

const POLICY = path.join(__dirname, "..", "shared", "org-policy.example.json");
const NOW = new Date(2026, 9, 21, 10).getTime();
const folders = [];
test.after(() => { for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true }); });

function desk(appIds, log) {
  const dataDir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-clip-"));
  folders.push(dataDir);
  fs.copyFileSync(POLICY, path.join(dataDir, "policy.json"));
  return createAssistant({ dataDir, now: () => NOW, appIds, log });
}

/** A shell whose clipboard behaves like Electron 44's. */
function asyncShell(copied, options) {
  const calls = { notified: [], handled: [], written: [], replaced: [] };
  const shell = {
    clipboard: {
      readText: () => (options && options.readFails ? Promise.reject(new Error("no access")) : Promise.resolve(copied)),
      writeText: (text) => (options && options.writeFails ? Promise.reject(new Error("locked")) : Promise.resolve(calls.written.push(text)).then(() => undefined)),
    },
    notify: (body) => calls.notified.push(body),
    handleAction: (action) => calls.handled.push(action),
    sender: { replace: (action) => Promise.resolve(calls.replaced.push(action)).then(() => ({ ok: true })), press: () => Promise.resolve({ ok: true }), isAvailable: () => true },
    closePopover: () => {},
    settle: () => Promise.resolve(),
    broadcast: () => {},
  };
  return { shell, calls };
}

const LATE = "Hello,\n\nMy order A-55120 has still not arrived and is delayed.\n\nKind regards,\nJane Smith";

test("Reply's tray entry and palette item wait for the clipboard and rank the copied message", async () => {
  const assistant = desk(["reply"]);
  const app = assistant.app("reply");
  const { shell, calls } = asyncShell(LATE);
  app.onStart(shell);
  const offered = app.trayItems(shell)[0].click(shell);
  assert.equal(typeof offered.then, "function", "with a promise clipboard the entry answers with a promise");
  const action = await offered;
  assert.ok(action, calls.notified.join("; "));
  assert.equal(action.popover, "pick");
  assert.equal(action.candidates[0].id, "late-delivery");
  assert.deepEqual(calls.handled, [action], "the pick popover was opened");
  const chosen = await assistant.paletteChoose({ kind: "app:reply", trigger: assistant.paletteSearch("reply").find((i) => i.kind === "app:reply").trigger, query: "reply" });
  assert.equal(chosen.candidates[0].id, "late-delivery", "the palette path is awaited by main.js");
  const empty = asyncShell("");
  assert.equal(await app.trayItems(empty.shell)[0].click(empty.shell), null);
  assert.match(empty.calls.notified[0], /Copy the message you are answering first/);
  const broken = asyncShell("", { readFails: true });
  assert.equal(await app.trayItems(broken.shell)[0].click(broken.shell), null, "a failed read is an empty clipboard, not a rejection");
});

test("Notes' action-item update waits for the clipboard both ways and reports only after the write", async () => {
  const assistant = desk(["notes"]);
  const app = assistant.app("notes");
  const note = "# Ops sync\n\n## Discussion\nAnn will send the carrier report by Friday.\nTODO: book the van\n";
  const { shell, calls } = asyncShell(note);
  const result = await app.trayItems(shell)[0].click(shell);
  assert.equal(result.ok, true);
  assert.ok(result.items >= 2, JSON.stringify(result));
  assert.equal(calls.written.length, 1);
  assert.match(calls.written[0], /## Action items\n- /);
  assert.match(calls.notified[0], /updated/i);
  const locked = asyncShell(note, { writeFails: true });
  const refused = await app.trayItems(locked.shell)[0].click(locked.shell);
  assert.deepEqual([refused.ok, refused.error], [false, "clipboard: locked"]);
  assert.match(locked.calls.notified[0], /could not be written: locked/);
});

test("Forms' trigger cannot wait for the clipboard: the popover asks for the reference key once it is open", async () => {
  const assistant = desk(["forms"]);
  const app = assistant.app("forms");
  const { shell } = asyncShell("Re: order A-12345 arrived damaged");
  app.onStart(shell);
  assistant.focusChanged({ process: "zendesk.exe", title: "New ticket - Zendesk" });
  let actions = [];
  for (const ch of "refund/") actions = actions.concat(assistant.keyTyped({ text: ch }));
  const plan = actions.find((a) => a.type === "app" && a.app === "forms");
  assert.ok(plan, JSON.stringify(actions));
  assert.equal(plan.clipboardPending, true);
  assert.equal(plan.reference, "", "nothing guessed while the clipboard was unread");
  assert.deepEqual(await assistant.invoke("forms:clipboardReference"), { ok: true, reference: "A-12345" }, "only the lookup key reaches the page, not the copied text");
  const other = asyncShell("nothing that names an order");
  app.onStart(other.shell);
  assert.deepEqual(await assistant.invoke("forms:clipboardReference"), { ok: true, reference: "" });
});

test("Guard reports a clipboard fix only once the write landed, and a failed write leaves the warning open", async () => {
  const logged = [];
  const assistant = desk(["guard"], (line) => logged.push(line));
  const app = assistant.app("guard");
  assistant.focusChanged({ process: "OUTLOOK.EXE", title: "Payment - Message" });
  let actions = [];
  for (const ch of "card 4111 1111 1111 1111 please ") actions = actions.concat(assistant.keyTyped({ text: ch }));
  const raised = actions.filter((a) => a.type === "app" && a.app === "guard");
  assert.equal(raised.length, 1, JSON.stringify(actions));
  const state = Object.assign({ kind: "app", app: "guard", popover: "warning" }, raised[0]);
  const index = state.hits.findIndex((h) => h.fix && h.fix.kind === "remove");
  assert.ok(index >= 0, JSON.stringify(state.hits));
  const fixedCount = () => assistant.audit().filter((e) => e.event === "guard" && e.outcome === "fixed").length;

  const locked = asyncShell("", { writeFails: true });
  const refused = await app.popovers.warning.submit(state, { action: "fix", index }, locked.shell);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /could not be copied \(locked\)/);
  assert.deepEqual(locked.calls.notified, [], "no 'copied' note for text that is not on the clipboard");
  assert.ok(logged.some((line) => /guard: the clipboard could not be written: locked/.test(line)), logged.join("\n"));
  assert.equal(fixedCount(), 0, "a failed write is not audited as fixed");

  const { shell, calls } = asyncShell("");
  const pending = app.popovers.warning.submit(state, { action: "fix", index }, shell);
  assert.match((await app.popovers.warning.submit(state, { action: "fix", index }, shell)).error, /still being applied/);
  const result = await pending;
  assert.deepEqual([result.ok, result.via], [true, "clipboard"], "the warning could be fixed again after the failed write");
  assert.equal(calls.written.length, 1);
  assert.doesNotMatch(calls.written[0], /4111/);
  assert.equal(calls.notified.length, 1);
  assert.equal(fixedCount(), 1);
});
