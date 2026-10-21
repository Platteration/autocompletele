// actle Notes: the desktop side of core/notes.js. A document's trigger typed
// in any application (or the document picked in the search palette) opens
// the "fill" popover: one input per blank, the author prefilled from the
// person's own setting, list blanks as comma-separated values. Insert renders
// the document with the date, weekday and answers and pastes it in place of
// the trigger. The editor cannot be read, so action items are collected from
// a copied note: a tray entry or a palette item rebuilds the action block on
// the clipboard, never in the editor, and counts nothing (actle typed
// nothing). Metrics and the audit trail carry document ids and counts only.
"use strict";

const core = require("../../../core/notes.js");
const metrics = require("../../../core/metrics.js");
const { simulate } = require("./simulate.js");

const ID = "notes";
const TRAY_LABEL = "Update action items in the copied note";
const PALETTE_LABEL = "Update action items in copied note";
const UPDATED = "Action items updated on your clipboard: select your note and paste.";
const NONE_FOUND = "No action items found in the copied note.";
const DATA_VERSION = 1;
// Popover: heading and hint, one input row per blank, the error line and the buttons.
const SIZE = Object.freeze({ width: 480, base: 150, blank: 62, max: 700 });

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function count(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/** Run `fn` on a value or on what a promise resolves to; the stand-in shells answer at once, Electron's sender through a promise. */
function then(value, fn) {
  return value && typeof value.then === "function" ? value.then(fn) : fn(value);
}

/** A list blank's answer: an array as given, or one comma-separated line. */
function listValues(value) {
  const items = Array.isArray(value) ? value : String(value == null ? "" : value).split(",");
  return items.map(asText).filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeData(raw) {
  const data = isObject(raw) ? raw : {};
  const inserted = {};
  for (const [id, n] of Object.entries(isObject(data.inserted) ? data.inserted : {})) {
    if (count(n)) inserted[id] = count(n);
  }
  return { version: DATA_VERSION, inserted, actionUpdates: count(data.actionUpdates) };
}

function createApp(host) {
  // The shell the palette's action-items entry needs for the clipboard; main.js hands it over in onStart.
  let shell = null;

  function config() {
    const section = host.policy().notes;
    if (section && Array.isArray(section.documents)) return section;
    const fallback = core.normalizeNotes(null);
    delete fallback.warnings;
    return fallback;
  }

  function paused() {
    const state = host.policy().paused;
    return !!(state && state.active);
  }

  function authorSetting() {
    const settings = host.settings();
    return asText(settings && settings.notesAuthor);
  }

  function documentById(id) {
    return config().documents.find((doc) => doc.id === asText(id)) || null;
  }

  function loadData() {
    return normalizeData(host.appData(ID).load({}));
  }

  function saveData(data) {
    host.appData(ID).save(normalizeData(data));
  }

  function readClipboard(from) {
    try {
      const text = from.clipboard.readText();
      return String(text == null ? "" : text);
    } catch (error) {
      host.log("notes: the clipboard could not be read: " + error.message);
      return "";
    }
  }

  /**
   * The action settings for a copied note: a document's own when the note
   * holds a block under that document's heading, else the policy's. The
   * editor cannot say which document a note came from.
   */
  function actionConfig(text) {
    const cfg = config();
    const lines = String(text == null ? "" : text).split("\n");
    for (const doc of cfg.documents) {
      if (!doc.actions || (cfg.actions && doc.actions.heading.toLowerCase() === cfg.actions.heading.toLowerCase())) continue;
      const heading = new RegExp("^#{1,6}\\s+" + escapeRegExp(doc.actions.heading) + "\\s*#*\\s*$", "i");
      if (lines.some((line) => heading.test(line))) return doc;
    }
    return cfg;
  }

  /** The blanks the popover asks for; the author blank is prefilled from the person's setting. */
  function describeBlanks(doc) {
    const author = config().author;
    return core.blanks(doc).map((blank) => ({ name: blank.name, list: blank.list, value: blank.name === author ? authorSetting() : "" }));
  }

  function describeDocument(doc, data) {
    return {
      id: doc.id,
      trigger: doc.trigger,
      label: doc.label,
      title: doc.title,
      sections: doc.sections.map((section) => ({ heading: section.heading, repeat: section.repeat, empty: !section.body.trim() })),
      blanks: core.blanks(doc),
      actions: doc.actions ? { heading: doc.actions.heading, patterns: doc.actions.patterns.slice(), empty: doc.actions.empty } : null,
      inserted: data.inserted[doc.id] || 0,
    };
  }

  /** What opens the fill popover; the engine adds type, app, trigger and backspaces to a trigger hit. */
  function fillAction(doc, via) {
    return { popover: "fill", documentId: doc.id, label: doc.label, via, blanks: describeBlanks(doc) };
  }

  /**
   * The popover's answers as the core takes them: list blanks become arrays,
   * the rest strings. What the person typed into the blanks is not a saving;
   * the author prefilled from the setting was not typed.
   */
  function answers(doc, given) {
    const values = {};
    let typedKeystrokes = 0;
    const prefilled = authorSetting();
    for (const blank of core.blanks(doc)) {
      if (!Object.hasOwn(given, blank.name)) continue;
      const raw = given[blank.name];
      values[blank.name] = blank.list ? listValues(raw) : String(raw == null ? "" : raw);
      const typed = Array.isArray(raw) ? raw.join(", ") : String(raw == null ? "" : raw);
      if (asText(typed) && !(blank.name === config().author && asText(typed) === prefilled)) typedKeystrokes += metrics.graphemes(typed);
    }
    return { values, typedKeystrokes };
  }

  function rememberAuthor(values) {
    const value = values[config().author];
    if (typeof value !== "string" || !asText(value) || asText(value) === authorSetting()) return;
    host.saveSettings({ notesAuthor: asText(value) });
  }

  /** Count the insert and remember the author. @returns {number} keystrokes saved */
  function record(doc, state, rendered, values, typedKeystrokes) {
    const backspaces = count(state.backspaces);
    // The trigger was typed into the field only when it has to be deleted
    // (from the palette nothing was typed). It goes in as spent keystrokes,
    // not as `typed`: the engine took the trigger out of its field text at
    // the hit, and `typed` would take the same characters out a second time.
    const spent = count(state.spentKeystrokes) + typedKeystrokes + (backspaces ? metrics.graphemes(asText(state.trigger)) : 0);
    const entry = host.recordInsert({ kind: "notes", trigger: doc.id, inserted: rendered.text, typed: "", spentKeystrokes: spent });
    rememberAuthor(values);
    const data = loadData();
    data.inserted[doc.id] = (data.inserted[doc.id] || 0) + 1;
    saveData(data);
    const keystrokesSaved = entry ? entry.keystrokesSaved : 0;
    // Ids and counts only: never the note, a heading or an answer.
    host.audit({ event: "notes-inserted", document: doc.id, via: state.via || "trigger", blanks: Object.keys(values).length, keystrokesSaved });
    return keystrokesSaved;
  }

  /** "owner (2 of 3 values)" for a list blank that a repeat section needs more values of; else the name. */
  function describeMissing(name, short) {
    const gap = short && short[name];
    return gap ? name + " (" + gap.given + " of " + gap.needed + " values)" : name;
  }

  /**
   * The fill popover's Insert: render, refuse while a blank is open, close the
   * popover so the editor has the focus again, paste through the sender, then
   * count. Once the note reached the editor the answer never keeps the popover
   * open: a second Insert would paste the note a second time.
   */
  function submit(state, payload, from) {
    const doc = documentById(state && state.documentId);
    if (!doc) return { ok: false, error: "This document is no longer in your organisation's policy." };
    if (paused()) return { ok: false, error: "Paused by your organisation." };
    const given = answers(doc, payload && isObject(payload.values) ? payload.values : {});
    const rendered = core.render(doc, given.values, new Date(host.now()));
    if (!rendered.ready) return { ok: false, error: "Fill in: " + rendered.fields.map((name) => describeMissing(name, rendered.short)).join(", "), missing: rendered.fields };
    // The sender types into the active window, which is the popover while it is open.
    if (typeof from.closePopover === "function") from.closePopover();
    // Give the focus back to the note's window before the paste keystroke (shell.settle; a stand-in without it answers at once).
    const settled = typeof from.settle === "function" ? from.settle() : null;
    const sent = then(settled, () => from.sender.replace({ backspaces: count(state.backspaces), text: rendered.text, cursorOffset: rendered.caret }));
    return then(sent, (result) => {
      // The popover is gone, so a failed paste is reported by the sender's own notification.
      if (!result || result.ok === false) return { ok: false, error: "Could not insert the note" + (result && result.error ? ": " + result.error : "."), close: true };
      const out = { ok: true, document: doc.id, inserted: rendered.text.length, caret: rendered.caret, keystrokesSaved: 0 };
      try {
        out.keystrokesSaved = record(doc, state, rendered, given.values, given.typedKeystrokes);
      } catch (error) {
        // A disk fault in the bookkeeping must not look like a failed paste.
        host.log("notes: the insert could not be counted: " + error.message);
        from.notify("The note was inserted, but it could not be counted: " + error.message);
        out.recorded = false;
      }
      return out;
    });
  }

  /**
   * Rebuild the action block of the copied note on the clipboard. Nothing is
   * recorded in the metrics: actle typed nothing, the person pastes the note.
   */
  function updateClipboard(from, via) {
    if (paused()) {
      from.notify("Paused by your organisation.");
      return { ok: false, error: "paused" };
    }
    const text = readClipboard(from);
    if (!text.trim()) {
      from.notify("Copy your note first, then choose \"" + TRAY_LABEL + "\" again.");
      return { ok: false, error: "clipboard empty" };
    }
    const cfg = actionConfig(text);
    if (!cfg.actions) {
      from.notify("Action items are switched off in your organisation's policy.");
      return { ok: false, error: "actions off" };
    }
    const now = new Date(host.now());
    const items = core.collectActions(text, cfg, now).items.length;
    const updated = core.updateActionBlock(text, cfg, now);
    if (!items && updated === text) {
      from.notify(NONE_FOUND);
      return { ok: true, items: 0, changed: false };
    }
    try {
      from.clipboard.writeText(updated);
    } catch (error) {
      host.log("notes: the clipboard could not be written: " + error.message);
      from.notify("The clipboard could not be written: " + error.message);
      return { ok: false, error: "clipboard: " + error.message };
    }
    from.notify(UPDATED);
    const data = loadData();
    data.actionUpdates += 1;
    saveData(data);
    host.audit({ event: "notes-actions-updated", via, items });
    return { ok: true, items, changed: updated !== text };
  }

  function info() {
    const cfg = config();
    const data = loadData();
    return {
      configured: cfg.documents.length > 0,
      paused: paused(),
      author: { blank: cfg.author, value: authorSetting() },
      dateOrder: cfg.dateOrder,
      actions: cfg.actions ? { heading: cfg.actions.heading, patterns: cfg.actions.patterns.slice(), empty: cfg.actions.empty } : null,
      trayLabel: TRAY_LABEL,
      paletteLabel: PALETTE_LABEL,
      documents: cfg.documents.map((doc) => describeDocument(doc, data)),
      actionUpdates: data.actionUpdates,
    };
  }

  function tryActions(payload) {
    const text = payload && payload.text != null ? String(payload.text) : "";
    const cfg = actionConfig(text);
    const now = new Date(host.now());
    if (!cfg.actions) return { ok: true, enabled: false, items: [], block: "" };
    const found = core.collectActions(text, cfg, now);
    return { ok: true, enabled: true, items: found.items.map((item) => Object.assign({}, item)), block: found.block };
  }

  function tryUpdate(payload) {
    const text = payload && payload.text != null ? String(payload.text) : "";
    const cfg = actionConfig(text);
    const now = new Date(host.now());
    if (!cfg.actions) return { ok: true, enabled: false, text, items: 0, changed: false };
    const updated = core.updateActionBlock(text, cfg, now);
    return { ok: true, enabled: true, text: updated, items: core.collectActions(text, cfg, now).items.length, changed: updated !== text };
  }

  function tryRender(payload) {
    const doc = documentById(payload && payload.documentId);
    if (!doc) return { ok: false, error: "No document with id " + JSON.stringify(asText(payload && payload.documentId)) + "." };
    const given = answers(doc, payload && isObject(payload.values) ? payload.values : {});
    const rendered = core.render(doc, given.values, new Date(host.now()));
    return { ok: true, text: rendered.text, fields: rendered.fields, caret: rendered.caret, ready: rendered.ready };
  }

  function setAuthor(payload) {
    const value = asText(payload && payload.author);
    host.saveSettings({ notesAuthor: value });
    return { ok: true, author: value, broadcast: { apps: true } };
  }

  const app = {
    id: ID,
    title: "Notes",
    tab: true,
    ipc: {
      "notes:info": () => info(),
      "notes:render": (payload) => tryRender(payload),
      "notes:actions": (payload) => tryActions(payload),
      "notes:update": (payload) => tryUpdate(payload),
      "notes:setAuthor": (payload) => setAuthor(payload),
    },
    extension: {
      id: ID,
      // A paused policy never reaches this hook: the engine answers nothing while paused.
      trigger: (textBeforeCaret) => {
        const found = core.findDocument(textBeforeCaret, config());
        return found ? { trigger: found.document.trigger, action: fillAction(found.document, "trigger") } : null;
      },
      reset: () => {},
    },
    popovers: {
      fill: {
        file: "apps/notes-fill",
        size: (action) => {
          const blanks = action && Array.isArray(action.blanks) ? action.blanks.length : 0;
          return { width: SIZE.width, height: Math.min(SIZE.max, SIZE.base + SIZE.blank * blanks) };
        },
        submit,
      },
    },
    palette: {
      // Listed from the policy each time, so the items follow policy changes.
      // A paused policy never reaches these hooks: the assistant's palette answers nothing while paused.
      items: () => {
        const cfg = config();
        const documents = cfg.documents.map((doc) => {
          const headings = doc.sections.map((section) => section.heading).filter(Boolean);
          return {
            trigger: doc.trigger,
            expansion: [doc.label, doc.id, doc.title, "note", "notes"].concat(headings).join(" "),
            preview: (doc.label + ": " + headings.join(", ")).replace(/\s+/g, " ").slice(0, 140),
          };
        });
        if (!cfg.actions) return documents;
        return documents.concat([{
          trigger: PALETTE_LABEL,
          expansion: ["action", "items", "actions", "todo", "clipboard", "note", "notes", cfg.actions.heading].join(" "),
          preview: "Collect the action items of the copied note into its \"" + cfg.actions.heading + "\" block, on the clipboard",
        }]);
      },
      choose: (choice) => {
        if (!choice) return null;
        if (choice.trigger === PALETTE_LABEL) {
          if (!shell) {
            host.log("notes: the palette item needs the shell, which has not started");
            return null;
          }
          // Done here and now; there is no popover to open, so the shell gets no action.
          updateClipboard(shell, "palette");
          return null;
        }
        const doc = config().documents.find((d) => d.trigger === choice.trigger);
        if (!doc) return null;
        return Object.assign({ type: "app", app: ID, trigger: doc.trigger, backspaces: 0, spentKeystrokes: count(choice.spentKeystrokes) }, fillAction(doc, "palette"));
      },
    },
    // Always present: the tray menu is built at start, so it cannot follow a policy that gains or loses documents.
    trayItems: () => [{ label: TRAY_LABEL, click: (from) => updateClipboard(from, "tray") }],
    onStart: (started) => { shell = started; },
    onStop: () => { shell = null; },
    simulate: (sim) => simulate(sim, { host, createApp, app }),
    // Called directly by the simulator and the tests; main.js uses the entries above.
    submit,
    updateClipboard,
  };
  return app;
}

module.exports = { createApp, TRAY_LABEL, PALETTE_LABEL, UPDATED, NONE_FOUND, SIZE, normalizeData, listValues };
