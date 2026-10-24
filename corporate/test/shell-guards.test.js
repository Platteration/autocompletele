// The Electron shell's guards: what desktop/shell-guards.js decides (plain
// functions), the filing popover page under a few lines of DOM, and
// desktop/main.js itself loaded with a stand-in "electron" module that
// records windows, IPC handlers, file-manager reveals and notifications.
// The stand-in is not Electron: whether a window really keeps or takes the
// keyboard focus was checked separately with Electron 44.9.0 under Xvfb (see
// desktop/README.md), not here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const signing = require("../core/policy-signing.js");
const guards = require("../desktop/shell-guards.js");

const DESKTOP = path.join(__dirname, "..", "desktop");
// Objects made inside the page's vm context have that context's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const folders = [];
test.after(() => { for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true }); });

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), prefix || "actle-shell-"));
  folders.push(dir);
  return dir;
}

// ---- shell-guards.js -------------------------------------------------------

test("a filing popover, and any popover that cannot take the keys, is shown without taking the focus; popovers the person opened are shown as before", () => {
  assert.equal(guards.popoverShowMethod("filing"), "showInactive");
  assert.equal(guards.popoverShowMethod("filing", { width: 540 }), "showInactive");
  for (const kind of ["keyword", "app"]) assert.equal(guards.popoverShowMethod(kind, { width: 380, focusable: false }), "showInactive", kind);
  for (const kind of ["template", "documents", "keyword", "app", undefined]) {
    assert.equal(guards.popoverShowMethod(kind), "show", String(kind));
    assert.equal(guards.popoverShowMethod(kind, { width: 420, height: 192 }), "show", String(kind));
    assert.equal(guards.popoverShowMethod(kind, { focusable: true }), "show", String(kind));
  }
});

test("reveal accepts a filing index entry id or the exact Sheets export path, and nothing else", () => {
  const known = {
    entries: [{ id: "6f1c0d0e-1111-4222-8333-944455556666", path: "/srv/Finance/2026/invoice.pdf" }, { id: "broken" }],
    exportPaths: ["/home/ann/.config/actle-corporate-desktop/apps/sheets-config.json"],
  };
  assert.equal(guards.revealTarget("6f1c0d0e-1111-4222-8333-944455556666", known), "/srv/Finance/2026/invoice.pdf");
  assert.equal(guards.revealTarget("/home/ann/.config/actle-corporate-desktop/apps/sheets-config.json", known), "/home/ann/.config/actle-corporate-desktop/apps/sheets-config.json");
  for (const refused of [
    "/srv/Finance/2026/invoice.pdf", // an entry's path, not its id
    "/etc/passwd",
    "\\\\attacker.example\\share\\x.txt",
    "/home/ann/.config/actle-corporate-desktop/apps/../apps/sheets-config.json", // the same file, spelled otherwise
    "/home/ann/.config/actle-corporate-desktop/apps/sheets-config.json/",
    "broken", // an entry without a path
    "", null, undefined, 42, { id: "6f1c0d0e-1111-4222-8333-944455556666" }, ["/etc/passwd"],
  ]) assert.equal(guards.revealTarget(refused, known), null, JSON.stringify(refused));
  assert.equal(guards.revealTarget("/etc/passwd", undefined), null);
  assert.equal(guards.revealTarget("", { exportPaths: [""] }), null);
});

test("a document belongs to its own watch folder and to every recursive watch above it", () => {
  const inbox = { path: "/data/inbox", recursive: true, source: "organization" };
  const flat = { path: "/data/flat", recursive: false, source: "organization" };
  const nested = { path: "/data/inbox/sub", source: "personal" };
  const sibling = { path: "/data/inbox2", recursive: true, source: "personal" };
  const all = [inbox, flat, nested, sibling];
  const opts = { platform: "linux" };
  assert.deepEqual(guards.watchesCovering("/data/inbox/doc.txt", all, opts), [inbox]);
  assert.deepEqual(guards.watchesCovering("/data/inbox/sub/doc.txt", all, opts), [inbox, nested], "nested watches both propose it");
  assert.deepEqual(guards.watchesCovering("/data/inbox/sub/deeper/doc.txt", all, opts), [inbox], "a non-recursive watch covers its own folder only");
  assert.deepEqual(guards.watchesCovering("/data/flat/doc.txt", all, opts), [flat]);
  assert.deepEqual(guards.watchesCovering("/data/flat/sub/doc.txt", all, opts), [], "a sub-folder of a non-recursive watch is not watched");
  assert.deepEqual(guards.watchesCovering("/data/inbox2/doc.txt", [inbox], opts), [], "a sibling sharing a prefix is not a sub-folder");
  assert.deepEqual(guards.watchesCovering("/data/inbox/doc.txt", [{ path: "/data/inbox/", recursive: false }], opts).length, 1, "a trailing separator still matches");
  assert.deepEqual(guards.watchesCovering("/etc/doc.txt", [{ path: "/", recursive: true }], opts).length, 1, "a recursive root covers everything");
  assert.deepEqual(guards.watchesCovering("/data/inbox/doc.txt", [{ path: "" }, { path: "  " }, null, { path: 7 }], opts), []);
  // Windows: forward slashes in the policy, other case on disk.
  const scanner = { path: "S:/Scans/Finance", recursive: false };
  assert.deepEqual(guards.watchesCovering("S:\\Scans\\Finance\\doc.pdf", [scanner], { platform: "win32" }), [scanner]);
  assert.deepEqual(guards.watchesCovering("s:\\scans\\FINANCE\\doc.pdf", [scanner], { platform: "win32" }), [scanner]);
  assert.deepEqual(guards.watchesCovering("S:\\Scans\\Finance\\2026\\doc.pdf", [scanner], { platform: "win32" }), []);
  assert.deepEqual(guards.watchesCovering("S:\\Scans\\Finance\\2026\\doc.pdf", [Object.assign({}, scanner, { recursive: true })], { platform: "win32" }).length, 1);
  assert.deepEqual(guards.watchesCovering("/Data/Inbox/doc.txt", [inbox], opts), [], "case counts outside Windows");
  // The queue keeps what an active watch still covers, in order.
  assert.deepEqual(guards.stillWatched(["/data/inbox/a", "/data/flat/b", "/data/inbox/sub/c", "/elsewhere/d"], [inbox], opts), ["/data/inbox/a", "/data/inbox/sub/c"]);
});

test("turning off a recursive parent says so; turning off the document's own folder needs no message", () => {
  const inbox = { path: "/data/inbox", recursive: true };
  const message = guards.ignoredFoldersMessage("/data/inbox/sub/doc.txt", [inbox], { platform: "linux" });
  assert.equal(message, "No longer watching /data/inbox (and its sub-folders) for documents to file on this desk. The factle tab turns a folder back on.");
  assert.equal(guards.ignoredFoldersMessage("/data/inbox/doc.txt", [inbox], { platform: "linux" }), null);
  assert.match(guards.ignoredFoldersMessage("/data/inbox/sub/doc.txt", [inbox, { path: "/data/inbox/sub" }], { platform: "linux" }), /\/data\/inbox \(and its sub-folders\), \/data\/inbox\/sub for/);
  assert.equal(guards.ignoredFoldersMessage("S:\\Scans\\doc.pdf", [{ path: "s:/scans" }], { platform: "win32" }), null);
});

test("a guarded web contents cancels every navigation it starts and denies new windows", () => {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = (fn) => { contents.openHandler = fn; };
  guards.guardNavigation(contents);
  let prevented = 0;
  contents.emit("will-navigate", { preventDefault() { prevented += 1; } }, "https://attacker.example/");
  assert.equal(prevented, 1);
  assert.deepEqual(contents.openHandler({ url: "https://attacker.example/" }), { action: "deny" });
});

// ---- renderer/filing.js under a few lines of DOM ---------------------------
// Elements with value, text, children, listeners, focus(), select() and
// blur(); FormData over named inputs; a window with listeners; timers the
// test runs by hand. Not a browser: layout, the drag area and real keyboard
// behaviour are not exercised here (see desktop/README.md for the run under
// Electron).
function filingPage(state, submit) {
  const byId = new Map();
  const log = { focused: [], selected: [], blurred: [], submitted: [], closed: 0 };
  const timers = [];
  let shownListener = null;
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag.toUpperCase(), children: [], listeners: {}, value: "", text: "", disabled: false, name: "" }); }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.text = String(value); this.children = []; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
    dispatch(name, extra) { return Promise.all((this.listeners[name] || []).map((fn) => fn(Object.assign({ target: this, preventDefault() {} }, extra || {})))); }
    all() { return this.children.flatMap((child) => [child, ...child.all()]); }
    querySelector(tag) { return this.all().find((node) => node.tagName === tag.toUpperCase()) || null; }
    focus() { log.focused.push(this.id); }
    select() { log.selected.push(this.id); }
    blur() { log.blurred.push(this.id); if (document.activeElement === this) document.activeElement = body; }
  }
  const make = (tag, id, parent) => { const node = new Node(tag); node.id = id; byId.set(id, node); if (parent) parent.append(node); return node; };
  const body = new Node("body");
  for (const [tag, id] of [["h1", "title"], ["p", "source"], ["p", "why"]]) make(tag, id, body);
  const form = make("form", "form", body);
  make("input", "name", form);
  make("div", "blanks", form);
  make("p", "folder", form);
  for (const [tag, id] of [["p", "error"], ["button", "never"], ["button", "skip"], ["button", "file"]]) make(tag, id, body);
  const document = {
    body,
    activeElement: body,
    createElement: (tag) => new Node(tag),
    getElementById: (id) => byId.get(id) || null,
    addEventListener: (name, fn) => body.addEventListener(name, fn),
    dispatch: (name, extra) => body.dispatch(name, extra),
  };
  class FormData {
    constructor(of) { this.of = of; }
    entries() { return this.of.all().filter((node) => node.name).map((node) => [node.name, node.value]); }
  }
  const actle = {
    getPopover: async () => state,
    submitPopover: async (payload) => { log.submitted.push(payload); return submit ? submit(payload) : { ok: true }; },
    closePopover: async () => { log.closed += 1; },
    onPopoverShown: (fn) => { shownListener = fn; },
  };
  const win = new Node("window");
  win.actle = actle;
  const setTimeout = (fn, ms) => { timers.push({ fn, ms }); };
  const done = vm.runInNewContext(fs.readFileSync(path.join(DESKTOP, "renderer", "filing.js"), "utf8"), { window: win, document, FormData, setTimeout });
  // A press as Chromium delivers it: mousedown (whose default action moves
  // the caret) and pointerdown, on a field.
  const press = async (id) => {
    let prevented = false;
    const target = byId.get(id || "name");
    await document.dispatch("pointerdown", { target });
    await document.dispatch("mousedown", { target, preventDefault() { prevented = true; } });
    if (!prevented) document.activeElement = target;
    return { prevented };
  };
  // Keys a person typing into another application could send here.
  const typeKeys = async () => {
    for (const key of ["Tab", "h", "u", "n", "t", "e", "r", "2", "Enter", " ", "Tab", " ", "Enter"]) {
      await document.dispatch("keydown", { key });
      if (document.activeElement !== body) await document.activeElement.dispatch("keydown", { key });
    }
  };
  return {
    done, document, window: win, $: (id) => byId.get(id), log, timers, press, typeKeys,
    shown: () => shownListener && shownListener(),
    elapse: () => { for (const timer of timers.splice(0)) timer.fn(); },
  };
}

const PROPOSAL = {
  path: "/data/inbox/statement.txt", fileName: "statement.txt", name: "2026-10-22_statement.txt", folder: "/data/inbox", inPlace: true,
  rule: { id: "invoice", label: "Supplier invoice" }, matched: ["invoice"], missing: ["client"], read: { kind: "text" },
};
const NOT_YET = "Click the name or File it to file this document.";

async function attempt(page) {
  await page.$("form").dispatch("submit");
  await page.$("never").dispatch("click");
}

test("the filing popover focuses and selects nothing, and no key, focus or Enter files it or turns its folder off", async () => {
  const page = filingPage({ kind: "filing", proposal: PROPOSAL });
  await page.done;
  page.shown();
  assert.equal(page.$("name").value, "2026-10-22_statement.txt");
  assert.deepEqual([page.log.focused, page.log.selected], [[], []], "no field takes the keys typed for another application");
  const blank = page.$("blanks").querySelector("input");
  assert.equal(blank.name, "answer:client");
  // Keys meant for another application: a name typed over the field, a blank filled, Enter.
  page.$("name").value = "hunter2";
  blank.value = "Correct-Horse";
  for (const phase of ["before the popover is armed", "after it is armed"]) {
    await page.typeKeys();
    await page.window.dispatch("focus");
    await page.document.dispatch("focusin", { target: page.$("name") });
    await page.$("name").dispatch("focus");
    await attempt(page);
    assert.deepEqual(page.log.submitted, [], phase + ": nothing is filed and no folder is turned off");
    assert.equal(page.$("error").textContent, NOT_YET, phase);
    page.elapse();
  }
  // Esc and Skip leave the file untouched, so they need no click.
  await page.document.dispatch("keydown", { key: "Escape" });
  await page.$("skip").dispatch("click");
  assert.equal(page.log.closed, 2);
  // The person clicks the Name field and files it.
  assert.deepEqual(await page.press("name"), { prevented: false }, "an armed press places the caret");
  page.$("name").value = "Q3 statement";
  await page.$("form").dispatch("submit");
  assert.deepEqual(plain(page.log.submitted), [{ action: "file", path: PROPOSAL.path, name: "Q3 statement", answers: { client: "Correct-Horse" } }]);
});

// This replaces "a click that lands before the popover state arrives
// counts": that expectation was the click race itself (a press aimed at
// another application as the popover appears, then typing and Enter, filed
// the document), so a press now counts only once the popover has been on
// screen for at least 500 ms.
test("a press as the popover appears is refused and leaves no caret; a press once it has been on screen a moment counts", async () => {
  const page = filingPage({ kind: "filing", proposal: Object.assign({}, PROPOSAL, { missing: [] }) }, (payload) => (payload.action === "ignoreFolder" ? { ok: false, error: "This document's folder is no longer watched." } : { ok: true }));
  // A press before the page has its state, and one right after it is shown.
  assert.deepEqual(await page.press("name"), { prevented: true });
  await page.done;
  assert.equal(page.timers.length, 0, "not armed before main.js says the popover is on screen");
  page.shown();
  assert.equal(page.timers.length, 1);
  assert.ok(page.timers[0].ms >= 500, "armed no sooner than Chromium's 500 ms for new prompts: " + page.timers[0].ms);
  assert.deepEqual(await page.press("name"), { prevented: true }, "the caret stays out of the Name field");
  assert.equal(page.document.activeElement, page.document.body);
  await page.typeKeys();
  await attempt(page);
  assert.deepEqual(page.log.submitted, [], "typed text plus Enter after an early press files nothing");
  assert.equal(page.$("error").textContent, NOT_YET);
  page.elapse();
  await page.press("never");
  await page.$("never").dispatch("click");
  assert.deepEqual(plain(page.log.submitted), [{ action: "ignoreFolder", path: PROPOSAL.path }]);
  assert.equal(page.$("error").textContent, "This document's folder is no longer watched.", "a refused 'Never for this folder' stays readable");
  const other = filingPage({ kind: "keyword" });
  await other.done;
  assert.equal(other.log.closed, 1, "a state that is not a filing closes the popover");
});

test("a popover main.js showed before the page listened arms from the state, and only once it shows the proposal", async () => {
  // The event went out before this page listened: only the state says the popover is on screen.
  const missed = filingPage({ kind: "filing", shown: true, proposal: PROPOSAL });
  assert.equal(missed.timers.length, 0, "not armed before the proposal is on the page");
  await missed.done;
  assert.equal(missed.timers.length, 1, "armed from the state");
  missed.elapse();
  await missed.press("name");
  await missed.$("form").dispatch("submit");
  assert.equal(missed.log.submitted.length, 1);
  // The event arrives before the state: armed once, when the proposal is on the page.
  const early = filingPage({ kind: "filing", shown: false, proposal: PROPOSAL });
  early.shown();
  assert.equal(early.timers.length, 0, "not armed before the proposal is on the page");
  await early.done;
  assert.equal(early.timers.length, 1);
  early.shown();
  assert.equal(early.timers.length, 1, "armed once, whichever came first");
});

test("a press stops counting when the popover loses the focus, and no field keeps the caret for keys meant elsewhere", async () => {
  const page = filingPage({ kind: "filing", proposal: Object.assign({}, PROPOSAL, { missing: [] }) });
  await page.done;
  page.shown();
  page.elapse();
  await page.press("name");
  assert.equal(page.document.activeElement, page.$("name"));
  // Back to another application; later the window manager hands the focus back.
  await page.window.dispatch("blur");
  assert.deepEqual(page.log.blurred, ["name"]);
  assert.equal(page.document.activeElement, page.document.body);
  await page.window.dispatch("focus");
  page.$("name").value = "SECRET2";
  await page.typeKeys();
  await attempt(page);
  assert.deepEqual(page.log.submitted, [], "a press before the focus left does not count any more");
  assert.equal(page.$("error").textContent, NOT_YET);
  // A blur of one field inside the popover is not the window losing the focus.
  await page.press("name");
  await page.window.dispatch("blur", { target: page.$("name") });
  await page.$("form").dispatch("submit");
  assert.equal(page.log.submitted.length, 1, "a new press counts again");
});

// ---- desktop/main.js with a stand-in electron ------------------------------

function fakeElectron(dataDir) {
  const record = { windows: [], handlers: new Map(), revealed: [], notified: [], shortcuts: [], picked: [] };
  const app = new EventEmitter();
  let ready;
  record.ready = new Promise((resolve) => { ready = resolve; });
  Object.assign(app, {
    requestSingleInstanceLock: () => true,
    whenReady: () => record.ready,
    getPath: () => dataDir,
    getVersion: () => "0.0.0-test",
    hide: () => {},
    quit: () => {},
  });
  record.app = app;
  record.start = ready;
  class WebContents extends EventEmitter {
    constructor() { super(); this.sent = []; this.messages = []; }
    send(channel, payload) { this.sent.push(channel); this.messages.push([channel, payload]); }
    setWindowOpenHandler(fn) { this.openHandler = fn; }
  }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      Object.assign(this, { options, calls: [], destroyed: false, webContents: new WebContents() });
      record.windows.push(this);
      app.emit("web-contents-created", {}, this.webContents);
    }
    loadFile(file) { this.page = path.basename(file); }
    show() { this.calls.push("show"); }
    showInactive() { this.calls.push("showInactive"); }
    focus() { this.calls.push("focus"); }
    close() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
    isDestroyed() { return this.destroyed; }
    static getAllWindows() { return record.windows.filter((w) => !w.destroyed); }
    static getFocusedWindow() { return null; }
  }
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { record.trayMenu = menu; } }
  class Notification { constructor(options) { this.body = options.body; } show() { record.notified.push(this.body); } static isSupported() { return true; } }
  return {
    record,
    electron: {
      app, BrowserWindow, Tray, Notification,
      Menu: { buildFromTemplate: (template) => template },
      ipcMain: { handle: (channel, fn) => record.handlers.set(channel, fn) },
      // As in Electron 44, which the desktop app pins: both calls answer with a promise.
      clipboard: {
        readText: () => Promise.resolve(record.copied || ""),
        writeText: (text) => (record.clipboardFails ? Promise.reject(new Error(record.clipboardFails)) : Promise.resolve().then(() => { record.copied = text; })),
      },
      shell: { showItemInFolder: (p) => record.revealed.push(p) },
      nativeImage: { createFromBitmap: () => ({}) },
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => (record.picked.length ? { canceled: false, filePaths: [record.picked.shift()] } : { canceled: true, filePaths: [] }),
      },
      safeStorage: { isEncryptionAvailable: () => false },
      globalShortcut: { register: (accelerator, fn) => { record.shortcuts.push(fn); return true; }, unregisterAll: () => {} },
    },
  };
}

async function shellDesk(dataDir, options) {
  const { electron, record } = fakeElectron(dataDir);
  const original = Module._load;
  // With options.typing, main.js gets a stand-in input adapter whose
  // handlers the test calls with keys, as uiohook would deliver them.
  const input = {
    createInputListener: (handlers) => {
      record.input = handlers;
      return { start: () => { handlers.onStatus({ available: false, error: "stand-in" }); return false; }, stop: () => {} };
    },
  };
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "uiohook-napi") throw new Error("not installed in tests");
    if (options && options.typing && request === "./adapters/input.js" && parent && parent.filename === path.join(DESKTOP, "main.js")) return input;
    return original.call(this, request, parent, isMain);
  };
  const logged = console.log;
  console.log = () => {}; // the assistant logs to the console
  try {
    for (const key of Object.keys(require.cache)) if (key.startsWith(DESKTOP + path.sep)) delete require.cache[key];
    require(path.join(DESKTOP, "main.js"));
    record.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    Module._load = original;
    console.log = logged;
  }
  const invoke = async (channel, payload) => record.handlers.get(channel)({}, payload);
  const quit = () => { console.log = () => {}; try { record.app.emit("before-quit"); } finally { console.log = logged; } };
  const popovers = (page) => record.windows.filter((w) => w.page === page);
  const type = (text, context) => {
    record.input.onFocus(context || { process: "slack", title: "general - Slack" });
    for (const ch of text) record.input.onKey(ch === "\n" ? { text: "\n", isBackspace: false, resetsBuffer: true } : { text: ch, isBackspace: false, resetsBuffer: false });
  };
  return { record, invoke, quit, popovers, type };
}

function unmanaged(filing) {
  const dataDir = temp("actle-shell-data-");
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ filing: Object.assign({ rules: [], fallback: { label: "Other", name: "[[date]]_[[original]]" } }, filing) }));
  return dataDir;
}

test("main.js shows the filing popover without taking the focus, and the person can still type into it after a click", async (t) => {
  const docs = temp("actle-shell-docs-");
  fs.writeFileSync(path.join(docs, "statement.txt"), "quarterly statement");
  const shell = await shellDesk(unmanaged({ watch: [{ path: docs, label: "Inbox" }] }));
  t.after(shell.quit);
  assert.deepEqual(await shell.invoke("filing:rescan", docs), { ok: true, queued: 1 });
  const [popover] = shell.popovers("filing.html");
  assert.equal((await shell.invoke("popover:get")).shown, false, "not on screen before ready-to-show");
  assert.deepEqual(popover.webContents.sent, []);
  popover.emit("ready-to-show");
  assert.deepEqual(popover.calls, ["showInactive"], "never show(), which activates the window and the app");
  assert.notEqual(popover.options.focusable, false, "a click must still give it the keys (setFocusable does not exist on Linux)");
  // The page counts clicks only a moment after this (filing.js).
  assert.deepEqual(popover.webContents.sent, ["popover:shown"]);
  assert.equal((await shell.invoke("popover:get")).shown, true);
  const [dashboard] = shell.popovers("index.html");
  dashboard.emit("ready-to-show");
  assert.deepEqual(dashboard.calls, ["show"], "the dashboard the person opened is shown as before");
});

test("'Never for this folder' from a sub-folder of a recursive watch turns that watch off, says so, and drops its queued documents", async (t) => {
  const docs = temp("actle-shell-docs-");
  const inbox = path.join(docs, "inbox");
  fs.mkdirSync(path.join(inbox, "sub"), { recursive: true });
  fs.writeFileSync(path.join(inbox, "sub", "a.txt"), "first");
  fs.writeFileSync(path.join(inbox, "sub", "b.txt"), "second");
  const shell = await shellDesk(unmanaged({ watch: [{ path: inbox, label: "Inbox", recursive: true }] }));
  t.after(shell.quit);
  assert.deepEqual(await shell.invoke("filing:rescan", inbox), { ok: true, queued: 2 });
  const state = await shell.invoke("popover:get");
  assert.equal(path.dirname(state.proposal.path), path.join(inbox, "sub"));
  // The page's path is ignored: only the document this popover shows decides.
  const result = await shell.invoke("popover:submit", { action: "ignoreFolder", path: "/somewhere/else/x.txt" });
  assert.deepEqual(result, { ok: true, turnedOff: [inbox] });
  assert.deepEqual((await shell.invoke("settings:get")).ignoredFolders, [inbox]);
  const info = await shell.invoke("filing:info");
  assert.deepEqual(info.folders.active, [], "the recursive watch is off");
  assert.deepEqual(info.status.folders, [], "and no longer watched");
  assert.equal(shell.popovers("filing.html")[0].destroyed, true);
  assert.ok(shell.record.notified.includes("No longer watching " + inbox + " (and its sub-folders) for documents to file on this desk. The factle tab turns a folder back on."));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(shell.popovers("filing.html").length, 1, "b.txt, queued from the same folder, is not proposed");
});

test("'Never for this folder' from a document directly in the watched folder turns it off without a message", async (t) => {
  const inbox = temp("actle-shell-docs-");
  fs.writeFileSync(path.join(inbox, "a.txt"), "first");
  const shell = await shellDesk(unmanaged({ watch: [{ path: inbox, label: "Inbox" }] }));
  t.after(shell.quit);
  await shell.invoke("filing:rescan", inbox);
  const before = shell.record.notified.length;
  assert.deepEqual(await shell.invoke("popover:submit", { action: "ignoreFolder" }), { ok: true, turnedOff: [inbox] });
  assert.deepEqual((await shell.invoke("settings:get")).ignoredFolders, [inbox]);
  assert.equal(shell.record.notified.length, before);
});

test("turning a folder off on the Filing tab drops the documents still queued from it", async (t) => {
  const inbox = temp("actle-shell-docs-");
  const own = temp("actle-shell-own-");
  for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(inbox, name), name);
  for (const name of ["c.txt", "d.txt"]) fs.writeFileSync(path.join(own, name), name);
  const shell = await shellDesk(unmanaged({ watch: [{ path: inbox, label: "Inbox" }] }));
  t.after(shell.quit);
  shell.record.picked.push(own);
  await shell.invoke("filing:addFolder");
  await shell.invoke("filing:rescan", inbox);
  await shell.invoke("filing:rescan", own);
  const showing = async () => { const state = await shell.invoke("popover:get"); return state && path.basename(state.proposal.path); };
  const skip = async () => { await shell.invoke("popover:submit", { action: "skip" }); await new Promise((resolve) => setTimeout(resolve, 10)); };
  assert.equal(await showing(), "a.txt", "one at a time: a.txt shown, three queued");
  // A policy folder turned off: b.txt is dropped, the own folder's documents stay.
  await shell.invoke("filing:ignoreFolder", { path: inbox });
  await skip();
  assert.equal(await showing(), "c.txt", "b.txt, from the folder turned off, is not proposed");
  // The person's own folder removed: d.txt is dropped.
  await shell.invoke("filing:removeFolder", own);
  await skip();
  assert.equal(await showing(), null, "d.txt, from the folder removed, is not proposed");
  assert.equal(shell.popovers("filing.html").length, 2, "a.txt and c.txt were the only popovers");
});

test("'Never for this folder' refuses, and keeps the popover open, when that policy folder was already turned off on the Filing tab", async (t) => {
  const docs = temp("actle-shell-docs-");
  const inbox = path.join(docs, "inbox");
  fs.mkdirSync(path.join(inbox, "sub"), { recursive: true });
  fs.writeFileSync(path.join(inbox, "sub", "a.txt"), "first");
  const shell = await shellDesk(unmanaged({ watch: [{ path: inbox, label: "Inbox", recursive: true }] }));
  t.after(shell.quit);
  await shell.invoke("filing:rescan", inbox);
  const [popover] = shell.popovers("filing.html");
  await shell.invoke("filing:ignoreFolder", { path: inbox }); // on the Filing tab, while the popover is open
  const before = shell.record.notified.length;
  const result = await shell.invoke("popover:submit", { action: "ignoreFolder" });
  assert.deepEqual(result, { ok: false, error: "This document's folder is no longer watched, so there is nothing to turn off. Skip it, or change folders on the factle tab." });
  assert.equal(popover.destroyed, false);
  assert.equal(shell.record.notified.length, before, "no notification about a folder that was already off");
  assert.deepEqual((await shell.invoke("settings:get")).ignoredFolders, [inbox]);
});

test("'Never for this folder' when no watch covers the document any more keeps the popover open with the reason", async (t) => {
  const own = temp("actle-shell-own-");
  fs.writeFileSync(path.join(own, "a.txt"), "first");
  const shell = await shellDesk(unmanaged({ watch: [] }));
  t.after(shell.quit);
  shell.record.picked.push(own);
  assert.equal((await shell.invoke("filing:addFolder")).ok, true);
  await shell.invoke("filing:rescan", own);
  const [popover] = shell.popovers("filing.html");
  assert.ok(popover, "the person's own folder proposes the document");
  await shell.invoke("filing:removeFolder", own); // removed on the Filing tab meanwhile
  const result = await shell.invoke("popover:submit", { action: "ignoreFolder" });
  assert.deepEqual(result, { ok: false, error: "This document's folder is no longer watched, so there is nothing to turn off. Skip it, or change folders on the factle tab." });
  assert.equal(popover.destroyed, false);
});

test("filing:reveal shows a filed document by its index id and the Sheets export by its exact path, and refuses any other path", async (t) => {
  const inbox = temp("actle-shell-docs-");
  fs.writeFileSync(path.join(inbox, "statement.txt"), "quarterly statement");
  const shell = await shellDesk(unmanaged({ watch: [{ path: inbox, label: "Inbox" }] }));
  t.after(shell.quit);
  await shell.invoke("filing:rescan", inbox);
  const filed = await shell.invoke("popover:submit", { action: "file", name: "Q3 statement" });
  assert.equal(filed.ok, true);
  const [entry] = await shell.invoke("filing:recent", 10);
  assert.equal(entry.path, path.join(inbox, "Q3_statement.txt"));
  const refusal = { ok: false, error: "Not a filed document or an export of this desk." };
  for (const request of [entry.path, "/etc/passwd", "\\\\attacker.example\\share\\x.txt", inbox, "", undefined, { id: entry.id }]) {
    assert.deepEqual(await shell.invoke("filing:reveal", request), refusal, JSON.stringify(request));
  }
  assert.deepEqual(shell.record.revealed, []);
  assert.deepEqual(await shell.invoke("filing:reveal", entry.id), { ok: true });
  assert.deepEqual(shell.record.revealed, [entry.path]);
  // The extle tab's Show file button sends the path sheets:info gave it.
  assert.equal((await shell.invoke("app:invoke", { channel: "sheets:exportConfig" })).ok, true);
  const sheets = await shell.invoke("app:invoke", { channel: "sheets:info" });
  assert.deepEqual(await shell.invoke("filing:reveal", sheets.lastExport.path), { ok: true });
  assert.deepEqual(shell.record.revealed, [entry.path, sheets.lastExport.path]);
  assert.deepEqual(await shell.invoke("filing:reveal", path.join(path.dirname(sheets.lastExport.path), "reply.json")), refusal, "another file next to it is not the export");
});

test("an extle usage import of many uses reaches the dashboard as one metrics change, not one per use, and a later import sends its own", async (t) => {
  const dataDir = temp("actle-shell-data-");
  fs.writeFileSync(path.join(dataDir, "policy.json"), "{}");
  const shell = await shellDesk(dataDir);
  t.after(shell.quit);
  const [dashboard] = shell.popovers("index.html");
  const changes = () => dashboard.webContents.messages.filter(([channel]) => channel === "app:changed").map(([, payload]) => payload);
  const day = require("../core/metrics.js").dayKey(new Date());
  const text = (count) => JSON.stringify({ format: "extle-usage", version: 1, instance: "ab".repeat(16), days: { [day]: [["completion", "column", "", count, count * 2]] } });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await tick();
  const before = changes().length;
  // Each ledger entry used to send its own { metrics: true }, and each made the dashboard query the whole ledger again.
  assert.equal((await shell.invoke("app:invoke", { channel: "sheets:importUsage", payload: { text: text(2000) } })).added, 2000);
  await tick();
  assert.deepEqual(changes().slice(before), [{ metrics: true, apps: true }, { metrics: true }], "the import's own change, then one for its 2000 ledger entries");
  assert.equal((await shell.invoke("app:invoke", { channel: "sheets:importUsage", payload: { text: text(2001) } })).added, 1);
  await tick();
  assert.deepEqual(changes().slice(before + 2), [{ metrics: true, apps: true }, { metrics: true }], "a later entry is sent again");
});

test("every window main.js opens keeps its page: navigation is cancelled and window.open denied", async (t) => {
  const inbox = temp("actle-shell-docs-");
  fs.writeFileSync(path.join(inbox, "a.txt"), "first");
  const shell = await shellDesk(unmanaged({ watch: [{ path: inbox, label: "Inbox" }] }));
  t.after(shell.quit);
  await shell.invoke("filing:rescan", inbox);
  shell.record.shortcuts[0](); // the palette hotkey
  assert.deepEqual(shell.record.windows.map((w) => w.page), ["index.html", "filing.html", "palette.html"]);
  for (const win of shell.record.windows) {
    let prevented = 0;
    win.webContents.emit("will-navigate", { preventDefault() { prevented += 1; } }, "https://attacker.example/");
    assert.equal(prevented, 1, win.page);
    assert.deepEqual(win.webContents.openHandler({ url: "https://attacker.example/" }), { action: "deny" }, win.page);
  }
});

test("when the organisation pauses the desk, an open popover and the palette close, and the resume proposes the same documents again", async (t) => {
  const pair = signing.generateKeyPair();
  const dataDir = temp("actle-shell-data-");
  const inbox = temp("actle-shell-docs-");
  for (const name of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(inbox, name), name);
  const layer = path.join(temp("actle-shell-policy-"), "org.signed.json");
  const policy = { layer: "org", serial: 1, filing: { watch: [{ path: inbox, label: "Inbox" }], rules: [], fallback: { label: "Other", name: "[[date]]_[[original]]" } } };
  fs.writeFileSync(layer, JSON.stringify(signing.signPolicy(policy, pair.privateKey)));
  fs.writeFileSync(path.join(dataDir, "deployment.json"), JSON.stringify({ policySources: [{ layer: "org", label: "Organisation", path: layer }], publicKeys: [pair.publicKey] }));
  const shell = await shellDesk(dataDir);
  t.after(shell.quit);
  await shell.invoke("policy:refresh");
  await shell.invoke("filing:rescan", inbox);
  shell.record.shortcuts[0]();
  const [popover] = shell.popovers("filing.html");
  const [palette] = shell.popovers("palette.html");
  assert.deepEqual([popover.destroyed, palette.destroyed], [false, false]);
  await shell.invoke("policy:refresh");
  assert.deepEqual([popover.destroyed, palette.destroyed], [false, false], "a refresh that does not pause leaves them open");
  fs.writeFileSync(layer, JSON.stringify(signing.signPolicy(Object.assign({}, policy, { serial: 2, paused: { message: "IT review" } }), pair.privateKey)));
  await shell.invoke("policy:refresh");
  assert.equal((await shell.invoke("app:status")).paused, true);
  assert.deepEqual([popover.destroyed, palette.destroyed], [true, true]);
  assert.ok(shell.record.notified.includes("Paused by your organisation: IT review"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await shell.invoke("popover:get"), null, "a paused desk proposes nothing");
  assert.equal(shell.popovers("filing.html").length, 1);
  // Resumed: the document whose popover the pause closed comes first, then the rest of the queue.
  fs.writeFileSync(layer, JSON.stringify(signing.signPolicy(Object.assign({}, policy, { serial: 3 }), pair.privateKey)));
  await shell.invoke("policy:refresh");
  assert.equal((await shell.invoke("app:status")).paused, false);
  const shown = [];
  for (let i = 0; i < 4; i++) {
    const state = await shell.invoke("popover:get");
    if (!state) break;
    shown.push(path.basename(state.proposal.path));
    await shell.invoke("popover:submit", { action: "skip" });
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(shown, ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(fs.readdirSync(inbox).sort(), ["a.txt", "b.txt", "c.txt"], "nothing was moved");
});

test("keyword offers and Guard warnings, which open while the person types elsewhere, are shown without activating actle", async (t) => {
  const dataDir = temp("actle-shell-data-");
  const sample = JSON.parse(fs.readFileSync(path.join(DESKTOP, "apps", "guard", "sample-policy.json"), "utf8"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({
    keywordRules: [{ keywords: ["invoice"], insert: { kind: "text", text: "Invoice no. " } }],
    guard: Object.assign({}, sample, { assumeExternal: true }),
  }));
  const shell = await shellDesk(dataDir, { typing: true });
  t.after(shell.quit);
  shell.type("about the invoice ");
  const [offer] = shell.popovers("keyword.html");
  assert.ok(offer, "the keyword offer opened");
  assert.equal(offer.options.focusable, false);
  offer.emit("ready-to-show");
  assert.deepEqual(offer.calls, ["showInactive"]);
  shell.type("my card is 4111 1111 1111 1111\n");
  const [warning] = shell.popovers("guard-warning.html");
  assert.ok(warning, "the Guard warning opened");
  assert.equal(warning.options.focusable, false);
  warning.emit("ready-to-show");
  assert.deepEqual(warning.calls, ["showInactive"]);
});

test("the dashboard's Reveal buttons send what filing:reveal accepts (a static check of the page source)", () => {
  // dashboard.js is not run here; this pins the call so a page change cannot
  // silently go back to sending paths, which main.js now refuses.
  const calls = (file) => [...fs.readFileSync(path.join(DESKTOP, "renderer", file), "utf8").matchAll(/revealFiled\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(calls("dashboard.js"), ["entry.id"]);
  assert.deepEqual(calls(path.join("apps", "sheets.js")), ["last.path"], "the path sheets:info returns, which the reveal test above accepts");
});

test("main.js waits for the promise clipboard: an app's palette choice opens its popover, and document paths count as copied only once written", async (t) => {
  const dataDir = temp("actle-shell-data-");
  fs.copyFileSync(path.join(__dirname, "..", "shared", "org-policy.example.json"), path.join(dataDir, "policy.json"));
  const shell = await shellDesk(dataDir);
  t.after(shell.quit);
  shell.record.copied = "Hello,\n\nMy order A-55120 has still not arrived and is delayed.\n\nKind regards,\nJane Smith";
  const reply = (await shell.invoke("palette:search", "reply")).find((item) => item.kind === "app:reply");
  assert.ok(reply);
  assert.deepEqual(await shell.invoke("palette:choose", reply), { ok: true });
  assert.equal(shell.popovers("reply-pick.html").length, 1, "the pick popover opened once the clipboard answered");
  const picked = await shell.invoke("popover:get");
  assert.equal(picked.candidates[0].id, "late-delivery");
  await shell.invoke("popover:close");
  const entry = (shell.record.trayMenu || []).find((item) => item.label === "mactle: Reply to the copied message…");
  assert.ok(entry, JSON.stringify((shell.record.trayMenu || []).map((item) => item.label)));
  await entry.click();
  assert.equal(shell.popovers("reply-pick.html").length, 2, "the tray entry opened it too");
  await shell.invoke("popover:close");

  const documents = async () => {
    const set = (await shell.invoke("palette:search", "/sld")).find((item) => item.kind === "documents");
    assert.deepEqual(await shell.invoke("palette:choose", set), { ok: true });
    assert.equal((await shell.invoke("popover:get")).kind, "documents");
  };
  const copiedNotes = () => shell.record.notified.filter((body) => /copied/.test(body));
  await documents();
  shell.record.clipboardFails = "locked";
  assert.deepEqual(await shell.invoke("popover:submit", { action: "copy", selected: [0, 1] }), { ok: false, error: "locked" });
  assert.deepEqual(copiedNotes(), ["The file paths could not be copied (locked)."]);
  shell.record.clipboardFails = null;
  await documents();
  await shell.invoke("popover:submit", { action: "copy", selected: [0, 1] });
  assert.equal(shell.record.copied, "S:/Shared/Logistics/commercial-invoice.docx\nS:/Shared/Logistics/packing-list.xlsx");
  assert.equal(copiedNotes()[1], "2 file paths copied. Paste or drag them into the attachment area.");
});
