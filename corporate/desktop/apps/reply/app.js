// actle Reply: the desktop side of core/reply.js. The compose window cannot
// be read, so the message a person is answering comes in through the
// clipboard: a tray entry or a palette item reads it, the core ranks the
// organisation's replies against it, and the "pick" popover lists the fits
// with their blanks filled from the message. Blanks the message could not
// fill are asked in the same popover; nothing is inserted while one is open.
"use strict";

const core = require("../../../core/reply.js");
const metrics = require("../../../core/metrics.js");
const { template } = require("../../../core/personal.js");
const { simulate } = require("./simulate.js");

const ID = "reply";
const TRAY_LABEL = "Reply to the copied message…";
const PALETTE_LABEL = "Reply to copied message";
const DATA_VERSION = 1;
// Popover: heading and hint, one block per candidate, one input row per open blank, the error line and the buttons.
const SIZE = Object.freeze({ width: 560, base: 150, candidate: 88, blank: 62, max: 720 });

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function describeExtractor(extractor) {
  return extractor.pattern != null
    ? { name: extractor.name, kind: "pattern", pattern: extractor.pattern, group: extractor.group }
    : { name: extractor.name, kind: "after", after: extractor.after };
}

function createApp(host) {
  // The shell the palette path needs to read the clipboard; main.js hands it over in onStart.
  let shell = null;

  function config() {
    const section = host.policy().reply;
    return section && Array.isArray(section.replies) ? section : core.normalizeReplies(null);
  }

  function library() {
    return host.engine && Array.isArray(host.engine.library) ? host.engine.library : [];
  }

  function loadStats() {
    const data = host.appData(ID).load({});
    return core.normalizeStats(isObject(data) ? data.stats : null);
  }

  function saveStats(stats) {
    host.appData(ID).save({ version: DATA_VERSION, stats });
  }

  function candidatesFor(text) {
    return core.rank(text, config(), library(), { now: new Date(host.now()) });
  }

  /** What the popover and the dashboard see of a candidate: the id, the fit, the filled text and what is still open (prepare() fills the body again, so no caret offset travels). */
  function describe(candidate, index) {
    return {
      index,
      id: candidate.reply.id,
      label: candidate.reply.label,
      matched: candidate.matched.slice(),
      body: candidate.body,
      text: candidate.text,
      values: Object.assign({}, candidate.values),
      missing: candidate.missing.slice(),
    };
  }

  function readClipboard(from) {
    try {
      const text = from.clipboard.readText();
      return String(text == null ? "" : text);
    } catch (error) {
      host.log("reply: the clipboard could not be read: " + error.message);
      return "";
    }
  }

  /**
   * Rank the copied message and build the action that opens the pick
   * popover. Null, with a notification saying why, when nothing can be
   * offered: paused, no replies in the policy, nothing copied, no fit.
   */
  function offer(from, extra) {
    const policy = host.policy();
    if (policy.paused && policy.paused.active) {
      from.notify("Paused by your organisation.");
      return null;
    }
    if (!config().replies.length) {
      from.notify("Your organisation has not set up any replies.");
      return null;
    }
    const text = readClipboard(from);
    if (!text.trim()) {
      from.notify("Copy the message you are answering first, then choose Reply again.");
      return null;
    }
    const ranked = candidatesFor(text);
    if (!ranked.length) {
      from.notify("No prewritten reply fits the copied message.");
      return null;
    }
    let stats = loadStats();
    for (const candidate of ranked) stats = core.recordStat(stats, candidate.reply.id, "offered");
    saveStats(stats);
    return Object.assign({ type: "app", app: ID, popover: "pick", via: "tray", spentKeystrokes: 0, candidates: ranked.map(describe) }, extra || {});
  }

  /** Validate the popover's choice and fill the reply again through the core; a blank still open is a refusal. */
  function prepare(state, payload) {
    const candidates = state && Array.isArray(state.candidates) ? state.candidates : [];
    const index = payload && Number.isInteger(payload.index) ? payload.index : -1;
    const chosen = candidates[index];
    if (!chosen) return { ok: false, error: "Choose a reply first." };
    const answers = payload && isObject(payload.answers) ? payload.answers : {};
    const filled = core.fill(chosen.body, chosen.values, answers, { now: new Date(host.now()) });
    if (filled.missing.length) return { ok: false, error: "Fill in: " + filled.missing.join(", "), missing: filled.missing };
    // What the person typed into the blanks is not a saving; it is subtracted like a palette query.
    const answered = Object.keys(filled.values).filter((name) => asText(answers[name]) === filled.values[name]);
    const typedKeystrokes = answered.reduce((sum, name) => sum + metrics.graphemes(filled.values[name]), 0);
    return { ok: true, candidate: chosen, text: filled.text, cursorOffset: filled.cursorOffset, answered, typedKeystrokes };
  }

  function record(prepared, state) {
    const spent = Math.max(0, Math.floor(Number(state.spentKeystrokes) || 0)) + prepared.typedKeystrokes;
    const entry = host.recordInsert({ kind: "reply", trigger: prepared.candidate.id, inserted: prepared.text, typed: "", spentKeystrokes: spent });
    saveStats(core.recordStat(loadStats(), prepared.candidate.id, "inserted"));
    // Ids and counts only: never the message, the reply text or an answer.
    host.audit({ event: "reply-inserted", reply: prepared.candidate.id, via: state.via || "tray", candidates: state.candidates.length, blanksAnswered: prepared.answered.length, keystrokesSaved: entry.keystrokesSaved });
    return { ok: true, reply: prepared.candidate.id, inserted: prepared.text.length, keystrokesSaved: entry.keystrokesSaved };
  }

  /**
   * The pick popover's Insert: fill, close the popover, paste through the
   * sender, then count. A refusal (open blank) keeps the popover open. The
   * popover holds the focus while it is shown, so it is closed before the
   * paste keystroke goes out or that keystroke would land in the popover
   * itself; main.js tolerates its own second close.
   */
  function submit(state, payload, from) {
    const prepared = prepare(state, payload);
    if (!prepared.ok) return prepared;
    from.closePopover();
    // Give the focus back to the compose window before the paste keystroke
    // (shell.settle; a stand-in without it answers at once).
    const paste = () => from.sender.replace({ backspaces: 0, text: prepared.text, cursorOffset: prepared.cursorOffset });
    const settled = typeof from.settle === "function" ? from.settle() : null;
    const sent = settled && typeof settled.then === "function" ? settled.then(paste) : paste();
    // A paste the sender could not perform is reported by the sender's own notification and counts nothing.
    const after = (result) => (!result || result.ok === false
      ? { ok: false, error: "Could not insert the reply" + (result && result.error ? ": " + result.error : ".") }
      : record(prepared, state));
    // Electron's sender answers with a promise; the headless simulator's stand-in answers at once so its walk-through prints in order.
    return sent && typeof sent.then === "function" ? sent.then(after) : after(sent);
  }

  function info() {
    const cfg = config();
    const lib = library();
    const stats = loadStats();
    const policy = host.policy();
    return {
      configured: cfg.replies.length > 0,
      paused: !!(policy.paused && policy.paused.active),
      max: cfg.max,
      dateOrder: cfg.dateOrder,
      trayLabel: TRAY_LABEL,
      paletteLabel: PALETTE_LABEL,
      builtin: core.BUILTIN_VALUES.slice(),
      extractors: Object.values(cfg.extract).map(describeExtractor),
      replies: cfg.replies.map((reply) => {
        const body = core.bodyOf(reply, lib);
        const row = stats[reply.id] || { offered: 0, inserted: 0 };
        return {
          id: reply.id,
          label: reply.label,
          keywords: reply.keywords.slice(),
          match: reply.match,
          caseSensitive: reply.caseSensitive,
          shorthand: reply.shorthand,
          text: body,
          available: body != null,
          blanks: body == null ? [] : template.fields(body).map((field) => field.name),
          extractors: Object.values(reply.extract).map(describeExtractor),
          offered: row.offered,
          inserted: row.inserted,
        };
      }),
      warnings: core.checkLibrary(cfg, lib),
    };
  }

  function resetStats() {
    const count = Object.keys(loadStats()).length;
    saveStats({});
    host.audit({ event: "reply-stats-reset", replies: count });
    return { ok: true, reset: count, broadcast: { apps: true } };
  }

  const app = {
    id: ID,
    title: "Reply",
    tab: true,
    ipc: {
      "reply:info": () => info(),
      "reply:rank": (payload) => ({ ok: true, candidates: candidatesFor(payload && payload.text != null ? String(payload.text) : "").map(describe) }),
      "reply:stats": () => ({ ok: true, stats: loadStats() }),
      "reply:resetStats": () => resetStats(),
    },
    popovers: {
      pick: {
        file: "apps/reply-pick",
        size: (action) => {
          const candidates = action && Array.isArray(action.candidates) ? action.candidates : [];
          const blanks = candidates.reduce((most, c) => Math.max(most, Array.isArray(c.missing) ? c.missing.length : 0), 0);
          return { width: SIZE.width, height: Math.min(SIZE.max, SIZE.base + SIZE.candidate * candidates.length + SIZE.blank * blanks) };
        },
        submit,
      },
    },
    palette: {
      // Listed only while the policy has replies; the search runs items() each time, so this follows policy changes.
      items: () => (config().replies.length ? [{
        trigger: PALETTE_LABEL,
        expansion: ["reply", "answer", "message", "clipboard"].concat(config().replies.map((reply) => reply.label)).join(" "),
        preview: "Rank the prewritten replies against the copied message and insert one",
      }] : []),
      choose: (choice) => {
        if (!choice || choice.trigger !== PALETTE_LABEL) return null;
        if (!shell) {
          host.log("reply: the palette item needs the shell, which has not started");
          return null;
        }
        return offer(shell, { via: "palette", spentKeystrokes: choice.spentKeystrokes || 0 });
      },
    },
    // Always present: the tray menu is built at start, so it cannot follow a policy that gains or loses replies.
    trayItems: () => [{
      label: TRAY_LABEL,
      click: (from) => {
        const action = offer(from, { via: "tray" });
        if (action) from.handleAction(action);
        return action;
      },
    }],
    onStart: (started) => { shell = started; },
    onStop: () => { shell = null; },
    simulate: (sim) => simulate(sim, { host, createApp, app }),
    // Exposed for the simulator and the tests; main.js uses the entries above.
    offer,
    prepare,
    submit,
  };
  return app;
}

module.exports = { createApp, TRAY_LABEL, PALETTE_LABEL };
