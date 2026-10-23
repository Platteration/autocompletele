// The suite's apps (mactle, extle, cactle, gactle, dactle; ids reply, sheets,
// forms, guard, notes) plug into the desktop assistant through this registry.
// Each app lives in its own folder, desktop/apps/<id>/app.js, and exports
// createApp(host) returning the shape below. Plain Node: the assistant, the
// tests and the simulator load apps the same way; main.js adds the Electron
// pieces (popovers, tray items, IPC).
//
//   {
//     id: "guard",                       // required, matches the folder and the policy section
//     title: "gactle",                   // dashboard tab title, the app's name from NAMES; omit `tab: false` to show a tab
//     tab: true,
//     ipc: { "guard:summary": (payload) => result },   // channels the dashboard calls through window.actle.invoke
//     extension: { id, trigger(textBeforeCaret), check(fieldText, context), reset() },  // engine hooks, optional
//     popovers: { "warning": { file: "apps/guard-popover", size: (action) => ({ width, height }), submit: async (state, payload, shell) => result } },
//     palette: { items: () => [...], choose: (choice) => action|null },   // optional palette contributions, kind "app:guard"
//     trayItems: () => [{ label, click }],                                // optional
//     onPolicy(policy), onSettings(settings), onFocus(context), onClearLearning(), onStart(shell), onStop(),   // optional
//                                        // onClearLearning: after "Delete learned text"; the app deletes what it learned itself; a throw is logged
//     simulate(sim),                      // optional headless walk-through for desktop/simulate.js
//   }
//
// Conventions the five apps share (keep them when adding an app):
// * A typed trigger is removed from the engine's field and session text at
//   the hit, so recordInsert gets typed: "" and the trigger's length goes in
//   spentKeystrokes (when backspaces > 0). From the palette nothing was typed.
// * A popover closes before the paste: shell.closePopover(), then await
//   shell.settle() (gives the focus back), then shell.sender.replace(...).
// * Blank answers travel as { answers: { name: value } } from inputs named
//   "answer:<name>" (Notes still uses { values } and "value:<name>").
// * Audit entries hold ids and counts only. Reply, Forms, Notes and Sheets
//   write "<app>-<verb>" events; Guard writes event "guard" with an outcome.
//
// The host handed to createApp:
//   { store, engine, ledger, policy: () => policy, settings: () => settings, saveSettings(next),
//     audit(entry), now(), log(line), recordInsert(event), dataDir }
"use strict";

const path = require("node:path");

const APP_IDS = Object.freeze(["reply", "sheets", "forms", "guard", "notes"]);

// The names people see, by id, and what each app covers. Only the names
// changed: ids, policy sections, channels, metric kinds, audit events, files
// and storage keys keep the id. Filing is built into the desk rather than
// loaded through this registry; its name is listed here so the six are in one
// place. The dashboard pages (renderer/apps/<id>.js, index.html) cannot load
// this file and repeat the names; test/apps-registry.test.js holds them to it.
const NAMES = Object.freeze({
  reply: Object.freeze({ name: "mactle", covers: "replies to mail" }),
  sheets: Object.freeze({ name: "extle", covers: "Excel and Google Sheets" }),
  forms: Object.freeze({ name: "cactle", covers: "CRM and ticket forms" }),
  guard: Object.freeze({ name: "gactle", covers: "compliance warnings" }),
  notes: Object.freeze({ name: "dactle", covers: "minutes, handovers and logs in Word, Docs or any editor" }),
  filing: Object.freeze({ name: "factle", covers: "document filing" }),
});

function validate(app, id) {
  if (!app || typeof app !== "object") throw new Error("app " + id + " did not return an object");
  if (app.id !== id) throw new Error("app " + id + " reports id " + JSON.stringify(app.id));
  const out = Object.assign({ title: id, tab: true, ipc: {}, popovers: {} }, app);
  if (!out.ipc || typeof out.ipc !== "object") out.ipc = {};
  for (const channel of Object.keys(out.ipc)) {
    if (!channel.startsWith(id + ":")) throw new Error("app " + id + " channel " + channel + " must start with " + id + ":");
    if (typeof out.ipc[channel] !== "function") throw new Error("app " + id + " channel " + channel + " is not a function");
  }
  if (out.extension && out.extension.id !== id) out.extension = Object.assign({}, out.extension, { id });
  return out;
}

/**
 * Load every app that has a module. A missing or broken app is skipped with a
 * logged reason, never fatal: the assistant must start even when one app of
 * the suite cannot.
 */
function loadApps(host, options) {
  const given = options || {};
  const settings = { ids: Array.isArray(given.ids) ? given.ids : APP_IDS, log: typeof given.log === "function" ? given.log : () => {}, factories: given.factories };
  const apps = [];
  for (const id of settings.ids) {
    let create;
    if (settings.factories && typeof settings.factories[id] === "function") {
      create = settings.factories[id];
    } else {
      try {
        create = require(path.join(__dirname, id, "app.js")).createApp;
      } catch (error) {
        settings.log("app " + id + " not loaded: " + error.message);
        continue;
      }
    }
    if (typeof create !== "function") {
      settings.log("app " + id + " not loaded: no createApp export");
      continue;
    }
    try {
      apps.push(validate(create(host), id));
    } catch (error) {
      settings.log("app " + id + " not loaded: " + error.message);
    }
  }
  return apps;
}

module.exports = { APP_IDS, NAMES, loadApps, validate };
