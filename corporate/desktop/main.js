// Electron main process: tray icon, the dashboard window, popovers for
// templates, documents, keyword offers and document filing, and the wiring
// between the input listener, the folder watcher, the headless assistant and
// the text sender.
"use strict";

const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, nativeImage, Notification, dialog, safeStorage, globalShortcut } = require("electron");
const { createAssistant } = require("./assistant.js");
const { createInputListener } = require("./adapters/input.js");
const { createSender } = require("./adapters/sender.js");
const { createFolderWatcher } = require("./filer.js");
const { personal } = require("../core/index.js");

const SINGLE = app.requestSingleInstanceLock();
if (!SINGLE) {
  app.quit();
} else {
  app.on("second-instance", () => openDashboard());
  app.whenReady().then(start);
}

let assistant = null;
let listener = null;
let sender = null;
let tray = null;
let dashboard = null;
let popover = null;
let popoverState = null;
let listenerStatus = { available: false, error: "starting" };
let dashboardFocused = false;
let lastContext = {};
let paletteWindow = null;
let paletteStatus = { accelerator: "", registered: false, error: null };
let folderWatcher = null;
// Documents waiting for their filing popover: one at a time, in arrival order.
const filingQueue = [];
let filingStatus = { watching: 0, folders: [] };

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: "actle", body }).show();
  else assistant && assistant.log(body);
}

function broadcast(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("app:changed", payload || {});
  }
}

function windowOptions(extra) {
  return Object.assign({
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }, extra || {});
}

function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.show();
    dashboard.focus();
    return;
  }
  dashboard = new BrowserWindow(windowOptions({ width: 980, height: 700, minWidth: 720, minHeight: 480, title: "actle Corporate" }));
  dashboard.loadFile(path.join(__dirname, "renderer", "index.html"));
  dashboard.once("ready-to-show", () => dashboard.show());
  dashboard.on("focus", () => setOwnWindow(true));
  dashboard.on("blur", () => setOwnWindow(false));
  dashboard.on("closed", () => { dashboard = null; setOwnWindow(false); });
}

// Typing inside the dashboard (for example a trigger into the editor) must
// never expand, so the engine is told it is looking at its own window.
function setOwnWindow(focused) {
  dashboardFocused = focused;
  if (!assistant) return;
  assistant.focusChanged(Object.assign({}, lastContext, { ownWindow: focused }));
}

function updateTray() {
  if (!tray) return;
  const enabled = assistant.settings().enabled;
  const state = assistant.paused ? "paused by your organisation"
    : enabled ? (listenerStatus.available ? "on" : "listener unavailable") : "paused";
  tray.setToolTip("actle Corporate: " + state);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open dashboard", click: openDashboard },
    { label: "Search shortcuts…" + (paletteStatus.registered ? " (" + paletteStatus.accelerator.replace("CommandOrControl", process.platform === "darwin" ? "Cmd" : "Ctrl") + ")" : ""), click: openPalette },
    { label: "Enabled", type: "checkbox", checked: enabled, click: (item) => { assistant.setEnabled(item.checked); updateTray(); broadcast({ settings: true }); } },
    ...appTrayItems(),
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

function appTrayItems() {
  const items = [];
  for (const appItem of assistant.apps) {
    if (typeof appItem.trayItems !== "function") continue;
    try {
      for (const entry of appItem.trayItems(shellApi()) || []) {
        if (entry && entry.label && typeof entry.click === "function") items.push({ label: entry.label, click: () => entry.click(shellApi()) });
      }
    } catch (error) {
      assistant.log("app " + appItem.id + " tray items failed: " + error.message);
    }
  }
  return items.length ? [{ type: "separator" }, ...items] : [];
}

function trayIcon() {
  // A 16 px glyph drawn at run time, so the shell ships no binary asset.
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const ring = Math.hypot(x - 7.5, y - 7.5);
      const on = ring <= 7 && (ring >= 5 || (x >= 6 && x <= 9 && y >= 4 && y <= 11));
      canvas[i] = 35; canvas[i + 1] = 87; canvas[i + 2] = 215; canvas[i + 3] = on ? 255 : 0;
    }
  }
  return nativeImage.createFromBitmap(canvas, { width: size, height: size });
}

function showPopover(name, state, size) {
  closePopover();
  popoverState = state;
  popover = new BrowserWindow(windowOptions(Object.assign({
    frame: false, alwaysOnTop: true, resizable: false, skipTaskbar: true, title: "actle",
  }, size)));
  popover.loadFile(path.join(__dirname, "renderer", name + ".html"));
  popover.once("ready-to-show", () => popover.show());
  // Values typed into a template form are actle's own input: never expanded
  // or learned (the keyword popover cannot take the focus at all).
  popover.on("focus", () => setOwnWindow(true));
  popover.on("blur", () => { setOwnWindow(false); if (state.kind === "keyword") closePopover(); });
  // A window closed while focused may not emit "blur" first; never leave the
  // engine believing actle's own window has the focus.
  popover.on("closed", () => { popover = null; popoverState = null; setOwnWindow(!!BrowserWindow.getFocusedWindow()); setTimeout(nextFiling, 0); });
}

function closePopover() {
  if (popover && !popover.isDestroyed()) popover.close();
  popover = null;
  popoverState = null;
}

function handleAction(action) {
  switch (action.type) {
    case "expand":
      return sender.replace(action);
    case "undo":
      return sender.undo(action);
    case "template":
      return showPopover("template", Object.assign({ kind: "template" }, action), { width: 420, height: 120 + 72 * (action.fields.length + action.variables.length) });
    case "documents":
      return showPopover("documents", Object.assign({ kind: "documents" }, action), { width: 460, height: 160 + 44 * action.documents.length });
    case "filing":
      return showPopover("filing", { kind: "filing", proposal: action.proposal }, { width: 540, height: 250 + 62 * action.proposal.missing.length });
    case "app":
      return showAppPopover(action);
    case "keyword":
    case "warning":
      return showPopover("keyword", { kind: "keyword", warning: action.type === "warning", hits: action.hits.map((hit) => ({ rule: hit.rule, matched: hit.matched })) }, { width: 380, height: 90 + 72 * action.hits.length, focusable: false });
    default:
      return null;
  }
}

async function submitPopover(payload) {
  const state = popoverState;
  if (state && state.kind === "filing") return submitFiling(state, payload);
  if (state && state.kind === "app") return submitAppPopover(state, payload);
  closePopover();
  if (!state || !payload) return { ok: false };
  if (state.kind === "template") {
    const rendered = personal.template.render(state.expansion, payload.values || {}, new Date(), payload.pronouns || null);
    await sender.replace({ backspaces: state.backspaces, text: rendered.text, cursorOffset: rendered.cursorOffset });
    // The trigger was typed into the field only when it has to be deleted
    // (typed trigger); from a keyword offer or the palette nothing was typed.
    assistant.recordInsert({ kind: "template", trigger: state.trigger, source: state.source, inserted: rendered.text, typed: state.backspaces ? state.trigger : "", spentKeystrokes: state.spentKeystrokes });
  } else if (state.kind === "documents") {
    const chosen = state.documents.filter((doc, index) => (payload.selected || []).includes(index));
    if (payload.action === "reveal") {
      for (const doc of chosen) shell.showItemInFolder(doc.path);
    }
    if (chosen.length) {
      clipboard.writeText(chosen.map((doc) => doc.path).join("\n"));
      if (state.backspaces) await sender.replace({ backspaces: state.backspaces, text: "", cursorOffset: 0 });
      assistant.recordInsert({ kind: "document", trigger: state.trigger, count: chosen.length });
      notify(chosen.length + " file path" + (chosen.length === 1 ? "" : "s") + " copied. Paste or drag them into the attachment area.");
    }
  } else if (state.kind === "keyword") {
    const hit = state.hits[payload.index || 0];
    if (!hit || !hit.rule.insert) return { ok: false };
    const insert = hit.rule.insert;
    if (insert.kind === "text") {
      await sender.replace({ backspaces: 0, text: insert.text, cursorOffset: insert.text.length });
      assistant.recordInsert({ kind: "keyword", trigger: hit.rule.id, inserted: insert.text, typed: "" });
    } else if (insert.kind === "shorthand") {
      // A keyword rule names an organisation shortcut; a person's own shortcut
      // with the same trigger must not be inserted in its place.
      const sh = assistant.policy().library.map((item) => Object.assign({ source: "organization" }, item)).find((item) => item.trigger === insert.trigger);
      if (sh) {
        if (personal.template.requiresInput(sh.expansion)) {
          handleAction({ type: "template", trigger: sh.trigger, expansion: sh.expansion, fields: personal.template.fields(sh.expansion), variables: personal.template.variables(sh.expansion), backspaces: 0, source: sh.source });
        } else {
          const rendered = personal.template.render(sh.expansion, null, new Date());
          await sender.replace({ backspaces: 0, text: rendered.text, cursorOffset: rendered.cursorOffset });
          assistant.recordInsert({ kind: "keyword", trigger: hit.rule.id, inserted: rendered.text, typed: "" });
        }
      }
    } else if (insert.kind === "document") {
      const shortcut = assistant.policy().documents.shortcuts.find((s) => s.trigger === insert.shortcut);
      if (shortcut) handleAction({ type: "documents", trigger: shortcut.trigger, label: shortcut.label, documents: shortcut.documents, backspaces: 0 });
    }
  }
  broadcast({ metrics: true });
  return { ok: true };
}

// The suite's apps: an engine action {type: "app", app, popover, ...} opens
// the popover the app declared; the app's submit handler gets a small shell
// API to type text, use the clipboard, notify and open further actions.
function shellApi() {
  return {
    sender,
    clipboard,
    notify,
    broadcast,
    closePopover,
    handleAction,
    showItemInFolder: (p) => shell.showItemInFolder(String(p)),
    openDashboard,
    // After a popover closes, give the focus back to the application the
    // person was writing in before the paste keystroke goes out (the palette
    // takes the same pause; macOS also needs the app hidden).
    settle: async () => {
      if (process.platform === "darwin") app.hide();
      await new Promise((resolve) => setTimeout(resolve, 150));
    },
  };
}

function showAppPopover(action) {
  const app = assistant.app(action.app);
  const def = app && app.popovers && app.popovers[action.popover];
  if (!def || !def.file) {
    assistant.log("app " + action.app + " has no popover " + action.popover);
    return null;
  }
  const size = typeof def.size === "function" ? def.size(action) : def.size;
  return showPopover(def.file, Object.assign({ kind: "app" }, action), Object.assign({ width: 440, height: 220 }, size || {}, def.focusable === false ? { focusable: false } : {}));
}

async function submitAppPopover(state, payload) {
  const app = assistant.app(state.app);
  const def = app && app.popovers && app.popovers[state.popover];
  if (!def || typeof def.submit !== "function") {
    closePopover();
    return { ok: false, error: "no handler" };
  }
  let result;
  try {
    result = await def.submit(state, payload || {}, shellApi());
  } catch (error) {
    result = { ok: false, error: String(error && error.message || error) };
  }
  // A refused submission keeps the popover open with the reason, as filing does.
  if (!result || result.ok !== false || result.close) closePopover();
  broadcast({ metrics: true, apps: true });
  return result || { ok: true };
}

// Document filing: new files in watched folders get a popover; the person
// confirms, edits or skips. A refused filing keeps the popover open with the
// reason, so a document is never moved under an unfinished name.
async function submitFiling(state, payload) {
  if (!payload || payload.action === "skip") {
    closePopover();
    return { ok: true };
  }
  if (payload.action === "ignoreFolder") {
    const folder = path.dirname(String(payload.path || state.proposal.path));
    const match = assistant.filingFolders().policy.find((f) => f.path === folder);
    if (match) assistant.filingIgnoreFolder(match.raw, true);
    else assistant.filingRemoveFolder((assistant.filingFolders().own.find((f) => f.path === folder) || { raw: folder }).raw);
    closePopover();
    startWatching();
    broadcast({ settings: true, filing: true });
    return { ok: true };
  }
  const result = assistant.applyFiling({ path: state.proposal.path, name: payload.name, answers: payload.answers });
  if (!result.ok) return result;
  closePopover();
  notify("Filed as " + result.name + (result.folder !== path.dirname(result.from) ? " in " + result.folder : ""));
  broadcast({ metrics: true, filing: true });
  return result;
}

function enqueueFiling(file) {
  if (filingQueue.includes(file)) return;
  filingQueue.push(file);
  nextFiling();
}

function nextFiling() {
  if (popover || !filingQueue.length || !assistant) return;
  const file = filingQueue.shift();
  const proposal = assistant.filingProposal(file);
  if (!proposal) return nextFiling();
  handleAction({ type: "filing", proposal });
}

function startWatching() {
  if (!folderWatcher) {
    folderWatcher = createFolderWatcher({ onFile: enqueueFiling, log: (line) => assistant.log(line) });
  }
  const info = assistant.filingInfo();
  const folders = info.enabled ? info.folders.active : [];
  const watching = folderWatcher.start(folders);
  filingStatus = { watching, folders: folders.map((f) => f.path), enabled: info.enabled };
}

// Signed policy layers are fetched at start and then every refreshMinutes.
// A failed fetch keeps the last good copy (the assistant warns and audits it).
let refreshTimer = null;
async function refreshPolicy() {
  const wasPaused = assistant.paused;
  let result;
  try {
    result = await assistant.refreshPolicy();
  } catch (error) {
    result = { ok: false, error: String(error && error.message || error) };
    assistant.log("policy refresh failed: " + result.error);
  }
  if (assistant.paused !== wasPaused) {
    const message = assistant.policyInfo().paused.message;
    notify(assistant.paused ? "Paused by your organisation" + (message ? ": " + message : ".") : "Your organisation resumed actle.");
  }
  startWatching();
  updateTray();
  broadcast({ settings: true, status: true, policy: true });
  return result;
}

function schedulePolicyRefresh() {
  if (!assistant.managed) return;
  refreshPolicy();
  const minutes = assistant.policyInfo().refreshMinutes || 60;
  refreshTimer = setInterval(refreshPolicy, minutes * 60 * 1000);
}

// Search palette: a global hotkey opens a small window that finds any
// shortcut or document set; Enter inserts into the application underneath.
function registerPaletteShortcut() {
  const accelerator = assistant.settings().paletteShortcut;
  paletteStatus = { accelerator, registered: false, error: null };
  if (!accelerator) return;
  try {
    paletteStatus.registered = globalShortcut.register(accelerator, openPalette);
    if (!paletteStatus.registered) paletteStatus.error = "another application already uses it";
  } catch (error) {
    paletteStatus.error = String(error && error.message || error);
  }
  if (!paletteStatus.registered) notify("The search palette shortcut " + accelerator + " is not available: " + paletteStatus.error + ".");
}

function openPalette() {
  if (assistant.paused) {
    notify("Paused by your organisation; the search palette is unavailable.");
    return;
  }
  if (paletteWindow && !paletteWindow.isDestroyed()) {
    paletteWindow.focus();
    return;
  }
  paletteWindow = new BrowserWindow(windowOptions({
    width: 560, height: 420, frame: false, alwaysOnTop: true, resizable: false, skipTaskbar: true, center: true, title: "actle search",
  }));
  paletteWindow.loadFile(path.join(__dirname, "renderer", "palette.html"));
  paletteWindow.once("ready-to-show", () => { paletteWindow.show(); paletteWindow.focus(); });
  // Typing a query must not expand or be learned.
  paletteWindow.on("focus", () => setOwnWindow(true));
  paletteWindow.on("blur", () => { setOwnWindow(false); closePalette(); });
  paletteWindow.on("closed", () => { paletteWindow = null; setOwnWindow(!!BrowserWindow.getFocusedWindow()); });
}

function closePalette() {
  if (paletteWindow && !paletteWindow.isDestroyed()) paletteWindow.close();
  paletteWindow = null;
}

async function choosePalette(choice) {
  closePalette();
  // Give the focus back to the application the person was writing in.
  if (process.platform === "darwin") app.hide();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const action = assistant.paletteChoose(choice);
  if (!action) return { ok: false };
  if (action.type === "expand") {
    await sender.replace(action);
    assistant.paletteInserted(action);
    broadcast({ metrics: true });
  } else {
    handleAction(action);
  }
  return { ok: true };
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, payload) => fn(payload));
  handle("metrics:summary", (q) => assistant.summary(q || {}));
  handle("metrics:series", (q) => assistant.series(q || {}));
  handle("metrics:byApp", (q) => assistant.byApp(q || {}));
  handle("library:get", () => assistant.library());
  handle("library:save", (sh) => { const r = assistant.saveShorthand(sh || {}); broadcast({ library: true }); return r; });
  handle("library:delete", (trigger) => { const r = assistant.deleteShorthand(String(trigger || "")); broadcast({ library: true }); return r; });
  handle("library:import", (text) => { const r = assistant.importLibrary(String(text || "")); broadcast({ library: true }); return r; });
  handle("library:export", async () => {
    const result = await dialog.showSaveDialog({ defaultPath: "shorthands.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    require("node:fs").writeFileSync(result.filePath, assistant.exportLibrary(), "utf8");
    return { ok: true, path: result.filePath };
  });
  handle("report:preview", () => assistant.usageReport());
  handle("report:save", async () => {
    const report = assistant.usageReport();
    const name = "actle-usage-" + new Date(report.generatedAt).toISOString().slice(0, 10) + ".json";
    const result = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    require("node:fs").writeFileSync(result.filePath, JSON.stringify(report, null, 2) + "\n", "utf8");
    return { ok: true, path: result.filePath };
  });
  handle("palette:search", (query) => assistant.paletteSearch(String(query == null ? "" : query), 8));
  handle("palette:choose", (choice) => choosePalette(choice || null));
  handle("palette:close", () => { closePalette(); return { ok: true }; });
  handle("policy:info", () => assistant.policyInfo());
  handle("policy:refresh", () => refreshPolicy());
  handle("policy:audit", () => assistant.audit(100));
  handle("settings:get", () => assistant.settings());
  handle("settings:save", (next) => { const r = assistant.saveSettings(next || {}); updateTray(); startWatching(); broadcast({ settings: true }); return r; });
  handle("filing:info", () => Object.assign(assistant.filingInfo(), { status: filingStatus }));
  handle("filing:recent", (limit) => assistant.filingRecent(limit));
  handle("filing:undo", (id) => { const r = assistant.undoFiling(String(id || "")); broadcast({ filing: true }); return r; });
  handle("filing:search", (q) => assistant.filingSearch(String(q == null ? "" : q), 50));
  handle("filing:clear", () => { const r = assistant.filingClear(); broadcast({ filing: true }); return r; });
  handle("filing:addFolder", async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const r = assistant.filingAddFolder(picked.filePaths[0]);
    startWatching();
    broadcast({ settings: true, filing: true });
    return r;
  });
  handle("filing:removeFolder", (raw) => { const r = assistant.filingRemoveFolder(String(raw || "")); startWatching(); broadcast({ settings: true, filing: true }); return r; });
  handle("filing:ignoreFolder", (q) => { const r = assistant.filingIgnoreFolder(String((q && q.path) || ""), !(q && q.ignore === false)); startWatching(); broadcast({ settings: true, filing: true }); return r; });
  handle("filing:rescan", (folder) => {
    const target = String(folder || "");
    const known = assistant.filingFolders().active.find((f) => f.path === target);
    if (!known || !folderWatcher) return { ok: false, error: "Not a watched folder." };
    const files = folderWatcher.listFiles(known.path, known.recursive);
    for (const file of files) enqueueFiling(file);
    return { ok: true, queued: files.length };
  });
  handle("filing:reveal", (p) => { if (p) shell.showItemInFolder(String(p)); return { ok: true }; });
  handle("apps:list", () => assistant.appsInfo());
  handle("app:invoke", async (q) => {
    const result = await assistant.invoke(q && q.channel, q && q.payload);
    if (result && result.broadcast) broadcast(result.broadcast);
    return result;
  });
  handle("settings:enabled", (value) => { const r = assistant.setEnabled(value !== false); updateTray(); broadcast({ settings: true }); return r; });
  handle("learning:candidates", () => assistant.candidates());
  handle("learning:accept", (c) => { const r = assistant.acceptCandidate(c || {}); broadcast({ library: true, learning: true }); return r; });
  handle("learning:dismiss", (text) => { const r = assistant.dismissCandidate(text); broadcast({ learning: true }); return r; });
  handle("learning:info", () => assistant.corpusInfo());
  handle("suggestions:add", (candidate) => { const r = assistant.suggest(candidate || {}); broadcast({ learning: true }); return r; });
  handle("suggestions:remove", (text) => { const r = assistant.unsuggest(String(text || "")); broadcast({ learning: true }); return r; });
  handle("suggestions:list", () => assistant.suggestions());
  handle("suggestions:save", async () => {
    const data = assistant.suggestionsExport();
    if (!data.suggestions.length) return { ok: false, error: "Nothing to export." };
    const name = "actle-suggestions-" + new Date(data.generatedAt).toISOString().slice(0, 10) + ".json";
    const result = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    require("node:fs").writeFileSync(result.filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    return { ok: true, path: result.filePath };
  });
  handle("learning:clear", () => { const r = assistant.clearLearning(); broadcast({ learning: true, policy: true }); return r; });
  handle("app:status", () => ({
    listener: listenerStatus,
    sender: { available: sender.isAvailable(), reason: sender.isAvailable() ? null : sender.unavailableReason() },
    warnings: assistant.warnings(),
    dataDir: assistant.store.root,
    mode: assistant.engine.mode,
    paused: assistant.paused,
    pausedMessage: assistant.policyInfo().paused.message,
    palette: paletteStatus,
    filing: filingStatus,
    context: lastContext,
    version: app.getVersion(),
  }));
  handle("popover:get", () => popoverState);
  handle("popover:submit", (payload) => submitPopover(payload));
  handle("popover:close", () => { closePopover(); return { ok: true }; });
}

function start() {
  assistant = createAssistant({
    dataDir: app.getPath("userData"),
    policyFile: process.env.ACTLE_POLICY_FILE || null,
    swallowsTriggerKey: false,
    keychain: safeStorage,
    log: (line) => console.log(line),
  });
  sender = createSender({ clipboard, notify });
  listener = createInputListener({
    onKey: (key) => {
      if (dashboardFocused) return;
      for (const action of assistant.keyTyped(key)) handleAction(action);
    },
    onFocus: (context) => {
      lastContext = context;
      assistant.focusChanged(Object.assign({}, context, { ownWindow: dashboardFocused }));
      broadcast({ context: true });
    },
    onStatus: (status) => {
      listenerStatus = status;
      updateTray();
      broadcast({ status: true });
      if (!status.available) notify("Shortcuts are not being expanded: " + status.error);
    },
  });
  assistant.on("session", () => broadcast({ learning: true }));
  ledgerBroadcast();

  tray = new Tray(trayIcon());
  tray.on("double-click", openDashboard);
  updateTray();
  registerIpc();
  listener.start();
  if (!sender.isAvailable()) notify("Expansions cannot be typed into other applications: " + sender.unavailableReason());
  for (const warning of assistant.warnings()) notify(warning);
  schedulePolicyRefresh();
  registerPaletteShortcut();
  startWatching();
  for (const appItem of assistant.apps) {
    if (typeof appItem.onStart !== "function") continue;
    try {
      appItem.onStart(shellApi());
    } catch (error) {
      assistant.log("app " + appItem.id + " start failed: " + error.message);
    }
  }
  updateTray();
  openDashboard();
}

function ledgerBroadcast() {
  assistant.ledger.onRecord(() => broadcast({ metrics: true }));
}

app.on("window-all-closed", () => {
  // Stay in the tray.
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("before-quit", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (assistant) for (const appItem of assistant.apps) { if (typeof appItem.onStop === "function") { try { appItem.onStop(); } catch (error) { /* quitting */ } } }
  if (folderWatcher) folderWatcher.stop();
  if (listener) listener.stop();
  if (assistant) assistant.endSession();
});
