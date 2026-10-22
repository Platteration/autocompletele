// actle Reply through the desktop assistant (plain Node): the tray entry and
// the palette item read the clipboard, the pick popover's submit fills and
// pastes a reply through a fake shell, and what reaches the metrics, the
// audit file, the app data and the dashboard channels.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const orgPolicy = require("../core/org-policy.js");
const signing = require("../core/policy-signing.js");
const metrics = require("../core/metrics.js");
const { loadApps } = require("../desktop/apps/index.js");
const replyApp = require("../desktop/apps/reply/app.js");
const { fakeShell, MESSAGE } = require("../desktop/apps/reply/simulate.js");
const { createAssistant } = require("../desktop/assistant.js");

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desktop", "apps", "reply", "sample-policy.json"), "utf8"));
const NOW = new Date(2026, 9, 21, 10).getTime();

// Every desk gets its own data folder; all of them go at the end (hygiene).
const folders = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-reply-"));
  folders.push(dir);
  return dir;
}
test.after(() => { for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true }); });

function desk(extraPolicy, extra) {
  const dataDir = temp();
  const policy = Object.assign({
    organization: "Example Logistics",
    library: [{ trigger: "ret/", expansion: "Returns are accepted within 30 days." }, { trigger: "sig/", expansion: "Kind regards" }],
    reply: SAMPLE,
  }, extraPolicy);
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify(policy));
  const assistant = createAssistant(Object.assign({ dataDir, now: () => NOW, appIds: ["reply"] }, extra));
  return { assistant, dataDir, app: assistant.app("reply") };
}

/** The simulator's stand-in, with a sender that answers through a promise like Electron's. */
function asyncShell(clipboardText) {
  const shell = fakeShell(clipboardText);
  const sync = shell.sender.replace;
  shell.sender.replace = (action) => Promise.resolve(sync(action));
  return shell;
}

test("the sample section parses with no warnings and the app loads through the registry with the contract's shape", () => {
  const parsed = orgPolicy.parse({ reply: SAMPLE, library: [{ trigger: "ret/", expansion: "x" }] });
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.reply.replies.length, 4);
  const [app] = loadApps({ policy: () => parsed, engine: { library: [] }, appData: () => ({ load: () => ({}), save: () => {} }), now: () => NOW, log: () => {} }, { ids: ["reply"] });
  assert.equal(app.id, "reply");
  assert.equal(app.title, "Reply");
  assert.deepEqual(Object.keys(app.ipc), ["reply:info", "reply:rank", "reply:stats", "reply:resetStats"]);
  assert.equal(app.popovers.pick.file, "apps/reply-pick");
  assert.equal(typeof app.popovers.pick.submit, "function");
  assert.deepEqual(app.popovers.pick.size({ candidates: [{ missing: ["a", "b"] }, { missing: [] }] }), { width: 560, height: 150 + 88 * 2 + 62 * 2 });
  assert.equal(app.popovers.pick.size({ candidates: Array.from({ length: 10 }, () => ({ missing: [] })) }).height, 720, "capped");
  assert.equal(app.popovers.pick.size(null).height, 150);
  const html = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "apps", "reply-pick.html"), "utf8");
  assert.match(html, /<fieldset id="group">\s*<legend class="path">Replies that fit<\/legend>\s*<ul id="list"><\/ul>/, "the radios are the one selection model, named by a fieldset");
  assert.equal(/role="(listbox|option)"|aria-selected/.test(html), false);
  assert.equal(app.trayItems()[0].label, replyApp.TRAY_LABEL);
});

test("the tray entry ranks the copied message, counts the offers and opens the pick popover; nothing opens without a fit", () => {
  const { assistant, app, dataDir } = desk();
  const shell = asyncShell(MESSAGE);
  const [item] = app.trayItems(shell);
  const action = item.click(shell);
  assert.equal(action.type, "app");
  assert.equal(action.app, "reply");
  assert.equal(action.popover, "pick");
  assert.equal(action.via, "tray");
  assert.deepEqual(shell.calls.actions, [action], "the shell is asked to open the popover");
  assert.deepEqual(action.candidates.map((c) => [c.id, c.matched]), [["late-delivery", ["not arrived", "delayed"]], ["invoice-copy", ["invoice"]]]);
  assert.deepEqual(Object.keys(action.candidates[0]), ["index", "id", "label", "matched", "body", "text", "values", "missing"], "only what the popover reads travels");
  assert.deepEqual(action.candidates[0].values, { firstName: "Jane", order: "A-55120" });
  assert.deepEqual(action.candidates[0].missing, ["promise"]);
  assert.match(action.candidates[0].text, /^Dear Jane,\n\nThank you for your message. I am sorry that order A-55120/);
  assert.deepEqual(action.candidates[1].missing, ["reference"], "the quoted thread's invoice reference is not used");
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "apps", "reply.json"), "utf8"));
  assert.deepEqual(saved, { version: 1, stats: { "late-delivery": { offered: 1, inserted: 0, editedBeforeSend: 0 }, "invoice-copy": { offered: 1, inserted: 0, editedBeforeSend: 0 } } });

  const empty = asyncShell("   ");
  assert.equal(app.trayItems(empty)[0].click(empty), null);
  assert.deepEqual(empty.calls.notified, ["Copy the message you are answering first, then choose Reply again."]);
  assert.deepEqual(empty.calls.actions, []);
  const nofit = asyncShell("Hello, what are your opening hours?\nBest, Al");
  assert.equal(app.trayItems(nofit)[0].click(nofit), null);
  assert.deepEqual(nofit.calls.notified, ["No prewritten reply fits the copied message."]);
  const broken = asyncShell("x");
  broken.clipboard.readText = () => { throw new Error("no clipboard"); };
  assert.equal(app.offer(broken, {}), null, "a clipboard that cannot be read counts as empty");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "apps", "reply.json"), "utf8")).stats["late-delivery"].offered, 1, "nothing offered, nothing counted");
  assert.equal(assistant.audit().some((e) => e.event === "reply-inserted"), false);
});

test("without replies in the policy the tray entry says so, and a paused policy offers nothing", () => {
  const none = desk({ reply: null });
  const shell = asyncShell(MESSAGE);
  assert.equal(none.app.trayItems(shell)[0].click(shell), null);
  assert.deepEqual(shell.calls.notified, ["Your organisation has not set up any replies."]);
  assert.deepEqual(none.app.palette.items(), [], "no palette item without replies");
  const paused = desk({ paused: { message: "Audit" } });
  const other = asyncShell(MESSAGE);
  assert.equal(paused.app.offer(other, { via: "tray" }), null);
  assert.deepEqual(other.calls.notified, ["Paused by your organisation."]);
});

test("the palette item needs the started shell, reads the clipboard and carries the keystrokes spent", () => {
  const { assistant, app } = desk();
  const found = assistant.paletteSearch("reply");
  assert.deepEqual(found.map((i) => [i.kind, i.trigger, i.source]), [["app:reply", replyApp.PALETTE_LABEL, "organization"]]);
  assert.deepEqual(assistant.paletteSearch("late delivery").map((i) => i.kind), ["app:reply"], "reply labels are searchable");
  assert.equal(assistant.paletteChoose({ kind: "app:reply", trigger: replyApp.PALETTE_LABEL, query: "reply" }), null, "before onStart there is no clipboard to read");
  const shell = asyncShell(MESSAGE);
  app.onStart(shell);
  const action = assistant.paletteChoose({ kind: "app:reply", trigger: replyApp.PALETTE_LABEL, query: "reply" });
  assert.equal(action.popover, "pick");
  assert.equal(action.via, "palette");
  assert.equal(action.spentKeystrokes, 6, "the query and Enter");
  assert.equal(app.palette.choose({ trigger: "something else", spentKeystrokes: 1 }), null);
  app.onStop();
  assert.equal(assistant.paletteChoose({ kind: "app:reply", trigger: replyApp.PALETTE_LABEL, query: "" }), null);
});

test("Insert refuses an open blank, then fills, pastes, counts and audits without any text", async () => {
  const { assistant, app, dataDir } = desk();
  const shell = asyncShell(MESSAGE);
  const action = app.offer(shell, { via: "palette", spentKeystrokes: 6 });
  const refused = await app.popovers.pick.submit(action, { index: 0, answers: {} }, shell);
  assert.deepEqual(refused, { ok: false, error: "Fill in: promise", missing: ["promise"] });
  assert.deepEqual(shell.calls.replaced, [], "nothing was pasted");
  assert.deepEqual(await app.popovers.pick.submit(action, { index: 0, answers: { promise: "  " } }, shell), { ok: false, error: "Fill in: promise", missing: ["promise"] });
  assert.deepEqual(await app.popovers.pick.submit(action, { index: 7, answers: {} }, shell), { ok: false, error: "Choose a reply first." });
  assert.deepEqual(await app.popovers.pick.submit(action, null, shell), { ok: false, error: "Choose a reply first." });
  assert.equal(assistant.ledger.entries().length, 0);
  assert.equal(shell.calls.closed, 0, "a refusal keeps the popover open");

  const result = await app.popovers.pick.submit(action, { index: 0, answers: { promise: "Friday 23 October", other: "ignored" } }, shell);
  assert.equal(result.ok, true);
  assert.equal(result.reply, "late-delivery");
  assert.deepEqual(shell.calls.order, ["closePopover", "replace"], "the popover (which holds the focus) is closed before the paste keystroke goes out");
  const [pasted] = shell.calls.replaced;
  assert.equal(pasted.backspaces, 0);
  assert.equal(pasted.text, "Dear Jane,\n\nThank you for your message. I am sorry that order A-55120 has not reached you yet. I have asked the carrier for an update and will come back to you by Friday 23 October.\n\n\n\nKind regards,\nExample Logistics Ltd");
  assert.equal(pasted.cursorOffset, pasted.text.indexOf("\n\nKind regards"), "{cursor} places the caret");
  assert.equal(pasted.text.includes("[["), false);
  const [entry] = assistant.ledger.entries();
  assert.equal(entry.kind, "reply");
  assert.equal(entry.trigger, "late-delivery");
  assert.equal(entry.source, "organization");
  assert.equal(entry.keystrokesSaved, metrics.graphemes(pasted.text) - 6 - "Friday 23 October".length, "the palette query and the typed answer are not savings");
  assert.equal(result.keystrokesSaved, entry.keystrokesSaved);
  const audit = assistant.audit().filter((e) => e.event === "reply-inserted");
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], { at: NOW, event: "reply-inserted", reply: "late-delivery", via: "palette", candidates: 2, blanksAnswered: 1, keystrokesSaved: entry.keystrokesSaved });
  const auditText = fs.readFileSync(path.join(dataDir, "audit.jsonl"), "utf8");
  assert.equal(auditText.includes("Jane") || auditText.includes("Friday") || auditText.includes("A-55120"), false, "no message or answer text in the audit file");
  assert.deepEqual(app.ipc["reply:stats"]().stats["late-delivery"], { offered: 1, inserted: 1, editedBeforeSend: 0 });
  const usage = assistant.usageReport();
  assert.deepEqual(usage.byShortcut.map((s) => [s.kind, s.trigger, s.inserts]), [["reply", "late-delivery", 1]]);
});

test("values from the message and typed answers stay literal, and a failed paste records nothing", async () => {
  const { assistant, app } = desk({ reply: { replies: [{ id: "echo", keywords: ["note"], text: "Re: [[note]] / [[extra]] {date}" }], extract: { note: { after: "Note" } } } });
  const shell = asyncShell("Note: {clipboard} [[extra]] {cursor}\nThanks, Bo");
  const action = app.offer(shell, {});
  assert.deepEqual(action.candidates[0].missing, ["extra"]);
  const result = await app.popovers.pick.submit(action, { index: 0, answers: { extra: "{time} [[note]]" } }, shell);
  assert.equal(result.ok, true);
  assert.equal(shell.calls.replaced[0].text, "Re: {clipboard} [[extra]] {cursor} / {time} [[note]] 2026-10-21");
  const failing = asyncShell("Note: x\nThanks, Bo");
  failing.sender.replace = () => Promise.resolve({ ok: false, error: "xdotool is not installed" });
  const second = app.offer(failing, {});
  const refused = await app.popovers.pick.submit(second, { index: 0, answers: { extra: "y" } }, failing);
  assert.deepEqual(refused, { ok: false, error: "Could not insert the reply: xdotool is not installed" });
  assert.equal(failing.calls.closed, 1, "the popover was already closed for the paste; the sender's own notification reports the failure");
  assert.equal(assistant.ledger.entries().length, 1, "only the successful paste is counted");
  assert.equal(app.ipc["reply:stats"]().stats.echo.inserted, 1);
  assert.equal(assistant.audit().filter((e) => e.event === "reply-inserted").length, 1);
  const thrown = asyncShell("Note: x\nThanks, Bo");
  thrown.sender.replace = () => Promise.reject(new Error("boom"));
  await assert.rejects(app.popovers.pick.submit(app.offer(thrown, {}), { index: 0, answers: { extra: "y" } }, thrown), /boom/, "main.js turns a throw into a refusal");
});

test("dashboard channels: info lists replies, blanks, counts and library warnings; rank tries a message without counting; counts reset", () => {
  const { assistant, app, dataDir } = desk({ reply: Object.assign({}, SAMPLE, { replies: SAMPLE.replies.concat([{ id: "ghost", keywords: ["ghost"], shorthand: "nope/" }]) }) });
  const info = assistant.invoke("reply:info");
  assert.equal(info.configured, true);
  assert.equal(info.paused, false);
  assert.equal(info.max, 3);
  assert.equal(info.dateOrder, "dmy");
  assert.deepEqual(info.builtin, ["name", "firstName", "greeted", "order", "reference", "date", "amount"]);
  assert.deepEqual(info.extractors, [{ name: "customer", kind: "after", after: "Customer ID" }]);
  assert.deepEqual(info.warnings, ["reply ghost skipped: shorthand nope/ is not in the library"]);
  assert.deepEqual(info.replies.map((r) => [r.id, r.available, r.blanks, r.offered, r.inserted]), [
    ["late-delivery", true, ["firstName", "order", "promise"], 0, 0],
    ["invoice-copy", true, ["firstName", "reference", "order"], 0, 0],
    ["returns", true, [], 0, 0],
    ["tracking", true, ["firstName", "tracking", "customer"], 0, 0],
    ["ghost", false, [], 0, 0],
  ]);
  assert.equal(info.replies[2].text, "Returns are accepted within 30 days.", "a shorthand reply shows the library text");
  assert.equal(info.replies[2].shorthand, "ret/");
  assert.deepEqual(info.replies[3].extractors, [{ name: "tracking", kind: "pattern", pattern: "\\b1Z[A-Z0-9]{16}\\b", group: 0 }]);
  assert.equal(info.trayLabel, replyApp.TRAY_LABEL);
  assert.equal(info.paletteLabel, replyApp.PALETTE_LABEL);

  const tried = assistant.invoke("reply:rank", { text: "Where is my parcel? Tracking 1Z999AA10123456784.\nCustomer ID: C-1\nThanks, Ann Lee" });
  assert.deepEqual(tried.candidates.map((c) => [c.id, c.missing]), [["tracking", []]]);
  assert.equal(tried.candidates[0].text, "Dear Ann,\n\nYou can follow parcel 1Z999AA10123456784 at https://track.example.com/1Z999AA10123456784 (customer C-1).\n\nKind regards,\nExample Logistics Ltd");
  assert.deepEqual(assistant.invoke("reply:rank", { text: "" }).candidates, []);
  assert.deepEqual(assistant.invoke("reply:rank", null).candidates, []);
  assert.deepEqual(assistant.invoke("reply:stats"), { ok: true, stats: {} }, "trying a message counts nothing");

  app.offer(asyncShell(MESSAGE), {});
  assert.equal(assistant.invoke("reply:info").replies[0].offered, 1);
  assert.deepEqual(assistant.invoke("reply:resetStats"), { ok: true, reset: 2, broadcast: { apps: true } });
  assert.deepEqual(assistant.invoke("reply:stats").stats, {});
  assert.equal(assistant.audit().pop().event, "reply-stats-reset");
  fs.writeFileSync(path.join(dataDir, "apps", "reply.json"), JSON.stringify({ stats: { "late-delivery": { offered: "9", inserted: -1 } }, junk: 1 }));
  assert.deepEqual(assistant.invoke("reply:stats").stats, { "late-delivery": { offered: 9, inserted: 0, editedBeforeSend: 0 } }, "stored counts are cleaned on read");
  const unknown = assistant.invoke("reply:nope");
  assert.equal(unknown.ok, false);
});

test("a pick popover opened before the organisation paused the desk pastes nothing after the pause", async () => {
  const pair = signing.generateKeyPair();
  const URL = "https://intranet.example/org.signed.json";
  const layer = { layer: "org", serial: 1, organization: "Example Logistics", reply: SAMPLE };
  const served = { [URL]: JSON.stringify(signing.signPolicy(layer, pair.privateKey)) };
  const dataDir = temp();
  const assistant = createAssistant({ dataDir, now: () => NOW, appIds: ["reply"], deployment: { policySources: [{ layer: "org", label: "Organisation", url: URL }], publicKeys: [pair.publicKey] }, fetch: async (url) => ({ ok: true, status: 200, text: async () => served[url] }) });
  await assistant.refreshPolicy();
  const app = assistant.app("reply");
  const shell = asyncShell(MESSAGE);
  const action = app.trayItems(shell)[0].click(shell);
  assert.equal(action.popover, "pick", "opened while the policy was live");
  served[URL] = JSON.stringify(signing.signPolicy(Object.assign({}, layer, { serial: 2, paused: { message: "Incident" } }), pair.privateKey));
  assert.equal((await assistant.refreshPolicy()).paused, true);
  const refused = await app.popovers.pick.submit(action, { index: 0, answers: { promise: "Friday" } }, shell);
  assert.deepEqual(refused, { ok: false, error: "Paused by your organisation." });
  assert.equal(replyApp.PAUSED, refused.error);
  assert.deepEqual(shell.calls.order, [], "neither closed for a paste nor pasted");
  assert.equal(assistant.ledger.entries().length, 0);
  assert.equal(assistant.audit().some((e) => e.event === "reply-inserted"), false);
  assert.equal(assistant.invoke("reply:stats").stats["late-delivery"].inserted, 0);
});

test("an Insert whose pause arrives while the focus goes back to the compose window pastes nothing", async () => {
  const pair = signing.generateKeyPair();
  const URL = "https://intranet.example/org.signed.json";
  const layer = { layer: "org", serial: 1, organization: "Example Logistics", reply: SAMPLE };
  const served = { [URL]: JSON.stringify(signing.signPolicy(layer, pair.privateKey)) };
  const assistant = createAssistant({ dataDir: temp(), now: () => NOW, appIds: ["reply"], deployment: { policySources: [{ layer: "org", label: "Organisation", url: URL }], publicKeys: [pair.publicKey] }, fetch: async (url) => ({ ok: true, status: 200, text: async () => served[url] }) });
  await assistant.refreshPolicy();
  const app = assistant.app("reply");
  const shell = asyncShell(MESSAGE);
  const action = app.trayItems(shell)[0].click(shell);
  assert.equal(action.popover, "pick");
  // Electron's settle() waits for the focus to go back to the compose window; the pause lands meanwhile.
  shell.settle = async () => {
    served[URL] = JSON.stringify(signing.signPolicy(Object.assign({}, layer, { serial: 2, paused: { message: "Incident" } }), pair.privateKey));
    assert.equal((await assistant.refreshPolicy()).paused, true);
  };
  const refused = await app.popovers.pick.submit(action, { index: 0, answers: { promise: "Friday" } }, shell);
  assert.deepEqual(refused, { ok: false, error: "Paused by your organisation.", close: true });
  assert.deepEqual(shell.calls.order, ["closePopover"], "closed for the paste, then nothing pasted");
  assert.deepEqual(shell.calls.notified, ["Paused by your organisation."], "the popover is gone, so a notification says why");
  assert.equal(assistant.ledger.entries().length, 0);
  assert.equal(assistant.audit().some((e) => e.event === "reply-inserted"), false);
  assert.equal(assistant.invoke("reply:stats").stats["late-delivery"].inserted, 0);
});

test("the simulation walks through the sample headlessly, with or without replies in the policy", () => {
  for (const extra of [{}, { reply: null }]) {
    const { assistant, app } = desk(extra);
    const lines = [];
    app.simulate({ print: (line) => lines.push(line), assistant, now: () => NOW, brief: (text) => JSON.stringify(text).slice(0, 70) });
    const text = lines.join("\n");
    assert.match(text, /1\. Late delivery \[not arrived, delayed\]/);
    assert.match(text, /asks for promise/);
    assert.match(text, /Insert without answers -> refused: Fill in: promise/);
    assert.match(text, /Insert Late delivery with promise -> \d+ characters pasted/);
    assert.match(text, /\| Dear Jane,/);
    assert.match(text, /counts: late-delivery offered 1, inserted 1; invoice-copy offered 1, inserted 0/);
    assert.match(text, /empty clipboard -> Copy the message/);
    assert.equal(text.includes("the policy has no replies"), extra.reply === null);
    assert.equal(assistant.ledger.entries().filter((e) => e.kind === "reply").length, 1);
  }
});

// ---- The two pages, run under Node with a few lines of DOM ----------------
// Enough for what renderer/apps/reply-pick.js and reply.js do: elements with
// text, attributes, children, listeners and focus; getElementById; FormData;
// one-part selectors ("li", "input[type=radio]"). Not a browser: layout,
// styles and real keyboard behaviour stay unverified here.
function createDom() {
  const byId = new Map();
  const dom = { active: null };
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
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    dispatch(name, extra) { const event = Object.assign({ target: this, preventDefault() {} }, extra || {}); return Promise.all((this.listeners[name] || []).map((fn) => fn(event))); }
    focus() { dom.active = this; }
    all() { return this.children.flatMap((child) => [child, ...child.all()]); }
    querySelectorAll(selector) {
      const [, tag, attr, value] = /^(\w+)(?:\[(\w+)=(\w+)\])?$/.exec(selector);
      return this.all().filter((node) => node.tagName === tag.toUpperCase() && (!attr || node[attr] === value));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  class FormData {
    constructor(form) { this.items = form.all().filter((node) => node.tagName === "INPUT" && node.name && (node.type !== "radio" || node.checked)).map((node) => [node.name, node.value]); }
    entries() { return this.items.values(); }
  }
  const body = new Node("body");
  dom.document = { body, createElement: (tag) => new Node(tag), getElementById: (id) => byId.get(id) || null, addEventListener: (name, fn) => body.addEventListener(name, fn), dispatch: (name, extra) => body.dispatch(name, extra) };
  dom.FormData = FormData;
  // The popover page's static elements, as in reply-pick.html.
  dom.page = (ids) => { for (const [tag, id] of ids) { const node = new Node(tag); node.id = id; body.append(node); } };
  return dom;
}

function runPage(file, dom, actle) {
  const vm = require("node:vm");
  const sandbox = { window: { actle }, document: dom.document, FormData: dom.FormData };
  return { done: vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "apps", file), "utf8"), sandbox), window: sandbox.window };
}

/** The dashboard page loaded over a DOM stand-in, with dashboard.js's helpers reduced to what reply.js calls. */
function dashboard(assistant) {
  const dom = createDom();
  const messages = [];
  const el = (tag, attrs, children) => {
    const node = dom.document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) { if (key === "class") node.className = value; else if (key === "text") node.textContent = value; else node.setAttribute(key, value); }
    for (const child of children || []) node.append(child);
    return node;
  };
  const helpers = { api: { invoke: async (channel, payload) => assistant.invoke(channel, payload) }, el, text: (node, value) => { node.textContent = value == null ? "" : String(value); }, announce: (m) => messages.push(m), seconds: (n) => n + " s", preview: (value) => String(value || "").replace(/\s+/g, " ").slice(0, 140) };
  return { dom, helpers, messages, window: runPage("reply.js", dom, {}).window };
}

test("the pick popover page lists the candidates, moves the selection, asks for the open blanks and shows a refusal", async () => {
  const { app } = desk();
  const shell = asyncShell(MESSAGE);
  const state = Object.assign({ kind: "app" }, app.offer(shell, { via: "tray" }));
  const dom = createDom();
  dom.page([["form", "form"], ["p", "error"], ["button", "cancel"], ["button", "insert"]]);
  const group = dom.document.createElement("fieldset");
  dom.document.getElementById("form").append(group);
  for (const [tag, id, parent] of [["ul", "list", group], ["div", "blanks", dom.document.getElementById("form")]]) { const node = dom.document.createElement(tag); node.id = id; parent.append(node); }
  let closed = 0;
  const actle = { getPopover: async () => state, submitPopover: (payload) => app.popovers.pick.submit(state, payload, shell), closePopover: () => { closed += 1; } };
  await runPage("reply-pick.js", dom, actle).done;
  const $ = (id) => dom.document.getElementById(id);
  const items = $("list").querySelectorAll("li");
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /^Late delivery \(not arrived, delayed\)Dear Jane,/);
  assert.match(items[0].textContent, /From the message: firstName = Jane; order = A-55120Still needed: promise$/);
  const radios = () => $("list").querySelectorAll("input[type=radio]");
  assert.deepEqual(radios().map((radio) => radio.checked), [true, false]);
  assert.equal(items.some((item) => item.getAttribute("role") || item.getAttribute("aria-selected")), false, "the radios are the only selection model");
  assert.deepEqual($("blanks").querySelectorAll("input").map((input) => input.name), ["answer:promise"]);
  assert.equal($("insert").textContent, "Fill in and insert");
  assert.equal(dom.active.name, "answer:promise", "the open blank gets the focus");
  dom.active.value = "Fri";
  await dom.active.dispatch("input");
  await dom.document.dispatch("keydown", { key: "ArrowDown", target: dom.active });
  assert.deepEqual(radios().map((radio) => radio.checked), [false, true]);
  assert.deepEqual($("blanks").querySelectorAll("input").map((input) => input.name), ["answer:reference"]);
  assert.equal(dom.active.name, "answer:reference", "the new blank gets the focus");
  await dom.document.dispatch("keydown", { key: "ArrowUp", target: dom.active });
  assert.equal(radios()[0].checked, true);
  assert.equal($("blanks").querySelector("input").value, "Fri", "what was typed into a candidate's blank comes back with it");
  await dom.document.dispatch("keydown", { key: "ArrowDown", target: radios()[0] });
  assert.equal(radios()[0].checked, true, "a focused radio moves the selection itself");
  radios()[0].focus();
  radios()[1].checked = true;
  await radios()[1].dispatch("change");
  assert.equal(dom.active.name, "answer:reference", "a click on another candidate moves the focus to its first blank");
  radios()[0].checked = true;
  await radios()[0].dispatch("change");
  assert.equal($("blanks").querySelector("input").value, "Fri");
  $("blanks").querySelector("input").value = "";
  await $("blanks").querySelector("input").dispatch("input");
  await $("form").dispatch("submit");
  assert.equal($("error").textContent, "Fill in: promise");
  assert.equal($("insert").disabled, false, "the popover stays open and usable");
  assert.deepEqual(shell.calls.replaced, []);
  $("blanks").querySelector("input").value = "Friday";
  await $("form").dispatch("submit");
  assert.equal(shell.calls.replaced.length, 1);
  assert.match(shell.calls.replaced[0].text, /by Friday\./);
  await dom.document.dispatch("keydown", { key: "Escape" });
  await $("cancel").dispatch("click");
  assert.equal(closed, 2);
  const other = createDom();
  let refused = 0;
  await runPage("reply-pick.js", other, { getPopover: async () => ({ kind: "template" }), closePopover: () => { refused += 1; } }).done;
  assert.equal(refused, 1, "a state that is not Reply's closes the popover");
});

test("the dashboard page shows replies, counts, extractors and warnings, tries a message and resets the counts", async () => {
  const { assistant, app } = desk({ reply: Object.assign({}, SAMPLE, { replies: SAMPLE.replies.concat([{ id: "ghost", keywords: ["ghost"], shorthand: "nope/" }]) }) });
  app.offer(asyncShell(MESSAGE), {});
  const { dom, helpers, messages, window } = dashboard(assistant);
  const section = dom.document.createElement("section");
  await window.actleApps.reply.render(section, helpers, {});
  const text = section.textContent;
  assert.match(text, /Reply to the copied message…/);
  assert.match(text, /reply ghost skipped: shorthand nope\/ is not in the library/);
  const rows = section.querySelectorAll("tr").map((row) => row.querySelectorAll("td").map((cell) => cell.textContent));
  assert.deepEqual(rows[1], ["Late deliverylate-delivery", "not arrived, late, delayed, still waiting", "firstName, order, promise", helpers.preview(SAMPLE.replies[0].text), "1", "0"]);
  assert.deepEqual(rows[3].slice(3), ["shortcut ret/", "0", "0"]);
  assert.deepEqual(rows[5].slice(3), ["shortcut nope/ (not in the library)", "0", "0"]);
  assert.deepEqual(rows[7], ["customer", "the rest of the line after \"Customer ID\"", "all replies"]);
  assert.deepEqual(rows[8], ["tracking", "pattern /\\b1Z[A-Z0-9]{16}\\b/", "Tracking number"]);
  const buttons = section.querySelectorAll("button");
  const box = section.querySelector("textarea");
  box.value = "Refund please, I want my money back.\nThanks, Ola";
  await box.dispatch("input");
  await buttons.find((b) => b.textContent === "Rank replies").dispatch("click");
  assert.deepEqual(messages, ["1 reply fits"]);
  assert.match(section.textContent, /Returns and refunds \(returns\): found refund, money back/);
  assert.match(section.textContent, /Returns are accepted within 30 days\./);
  await buttons.find((b) => b.textContent === "Reset counts").dispatch("click");
  assert.deepEqual(messages.pop(), "Counts reset (2 replies)");
  const again = dom.document.createElement("section");
  await window.actleApps.reply.render(again, helpers, {});
  assert.equal(again.querySelector("textarea").value, "Refund please, I want my money back.\nThanks, Ola", "the draft survives a re-render");
  assert.match(again.textContent, /Returns and refunds \(returns\)/, "so does the last result");
  assert.equal(again.querySelectorAll("tr")[1].querySelectorAll("td")[4].textContent, "0", "counts were reset");
  await window.actleApps.reply.render(again, { ...helpers, api: { invoke: async () => ({ ok: false, error: "unknown channel reply:info" }) } }, {});
  assert.match(again.textContent, /Reply is not available: unknown channel reply:info/);
});

test("the dashboard page says when the policy is paused or has no replies, and when nothing fits a tried message", async () => {
  const { assistant } = desk({ reply: null, paused: { message: "Audit" } });
  const { dom, helpers, messages, window } = dashboard(assistant);
  const section = dom.document.createElement("section");
  await window.actleApps.reply.render(section, helpers, {});
  assert.match(section.textContent, /Paused by your organisation: no replies are offered\./);
  assert.match(section.textContent, /The organisation policy has no replies \(section "reply"\)\./);
  assert.match(section.textContent, /No extractors beyond the built-in blanks\./);
  assert.equal(section.querySelectorAll("tr").length, 1, "the replies table has its heading row only, the extractors table is not drawn");
  assert.match(section.textContent, /From:\/Sent:\/To:\/Subject: header is ignored/);
  const run = section.querySelectorAll("button").find((b) => b.textContent === "Rank replies");
  const box = section.querySelector("textarea");
  await run.dispatch("click");
  assert.deepEqual(messages, ["No reply fits"]);
  assert.equal(section.textContent.includes("No reply fits this message."), false, "an empty box gets no verdict");
  box.value = "Where is my order 123456?";
  await box.dispatch("input");
  await run.dispatch("click");
  assert.match(section.textContent, /No reply fits this message\./);
  assert.deepEqual(messages, ["No reply fits", "No reply fits"]);
});
