// Electron main process: tray icon, the dashboard window, popovers for
// templates, documents and keyword offers, and the wiring between the input
// listener, the headless assistant and the text sender.
"use strict";

const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, shell, nativeImage, Notification, dialog } = require("electron");
const { createAssistant } = require("./assistant.js");
const { createInputListener } = require("./adapters/input.js");
const { createSender } = require("./adapters/sender.js");
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
    { label: "Enabled", type: "checkbox", checked: enabled, click: (item) => { assistant.setEnabled(item.checked); updateTray(); broadcast({ settings: true }); } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
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
  popover.on("blur", () => { if (state.kind === "keyword") closePopover(); });
  popover.on("closed", () => { popover = null; popoverState = null; });
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
    case "keyword":
      return showPopover("keyword", { kind: "keyword", hits: action.hits.map((hit) => ({ rule: hit.rule, matched: hit.matched })) }, { width: 380, height: 90 + 60 * action.hits.length, focusable: false });
    default:
      return null;
  }
}

async function submitPopover(payload) {
  const state = popoverState;
  closePopover();
  if (!state || !payload) return { ok: false };
  if (state.kind === "template") {
    const rendered = personal.template.render(state.expansion, payload.values || {}, new Date(), payload.pronouns || null);
    await sender.replace({ backspaces: state.backspaces, text: rendered.text, cursorOffset: rendered.cursorOffset });
    assistant.recordInsert({ kind: "template", trigger: state.trigger, inserted: rendered.text, typed: state.trigger });
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
    if (!hit) return { ok: false };
    const insert = hit.rule.insert;
    if (insert.kind === "text") {
      await sender.replace({ backspaces: 0, text: insert.text, cursorOffset: insert.text.length });
      assistant.recordInsert({ kind: "keyword", trigger: hit.rule.id, inserted: insert.text, typed: "" });
    } else if (insert.kind === "shorthand") {
      const sh = assistant.library().find((item) => item.trigger === insert.trigger);
      if (sh) {
        if (personal.template.requiresInput(sh.expansion)) {
          handleAction({ type: "template", trigger: sh.trigger, expansion: sh.expansion, fields: personal.template.fields(sh.expansion), variables: personal.template.variables(sh.expansion), backspaces: 0 });
        } else {
          const rendered = personal.template.render(sh.expansion, null, new Date());
          await sender.replace({ backspaces: 0, text: rendered.text, cursorOffset: rendered.cursorOffset });
          assistant.recordInsert({ kind: "keyword", trigger: sh.trigger, inserted: rendered.text, typed: "" });
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
  handle("policy:info", () => assistant.policyInfo());
  handle("policy:refresh", () => refreshPolicy());
  handle("policy:audit", () => assistant.audit(100));
  handle("settings:get", () => assistant.settings());
  handle("settings:save", (next) => { const r = assistant.saveSettings(next || {}); updateTray(); broadcast({ settings: true }); return r; });
  handle("settings:enabled", (value) => { const r = assistant.setEnabled(value !== false); updateTray(); broadcast({ settings: true }); return r; });
  handle("learning:candidates", () => assistant.candidates());
  handle("learning:accept", (c) => { const r = assistant.acceptCandidate(c || {}); broadcast({ library: true, learning: true }); return r; });
  handle("learning:dismiss", (text) => { const r = assistant.dismissCandidate(text); broadcast({ learning: true }); return r; });
  handle("app:status", () => ({
    listener: listenerStatus,
    sender: { available: sender.isAvailable(), reason: sender.isAvailable() ? null : sender.unavailableReason() },
    warnings: assistant.warnings(),
    dataDir: assistant.store.root,
    mode: assistant.engine.mode,
    paused: assistant.paused,
    pausedMessage: assistant.policyInfo().paused.message,
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
  openDashboard();
}

function ledgerBroadcast() {
  assistant.ledger.onRecord(() => broadcast({ metrics: true }));
}

app.on("window-all-closed", () => {
  // Stay in the tray.
});

app.on("before-quit", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (listener) listener.stop();
  if (assistant) assistant.endSession();
});
