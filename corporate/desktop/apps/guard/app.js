// actle Guard: the desktop side of core/guard.js. The engine hands the text
// typed in the current field to the core at every word end; a rule that fires
// opens the "warning" popover with its message, masked findings and, where
// the rule has one, a Fix button. Recipients cannot be read from a compose
// window, so rules for external recipients only fire with assumeExternal.
// Nothing typed leaves the desk: the action, the audit trail and the metrics
// carry rule ids, counts and masked values only.
"use strict";

const guard = require("../../../core/guard.js");
const { baseName } = require("../../../core/capture-policy.js");
const { DEFAULTS } = require("../../../core/engine.js");
const { template } = require("../../../core/personal.js");
const { simulate } = require("./simulate.js");

const ID = "guard";
// Popover: heading and error line, then one block per warning (label, a message of up to two lines, findings, button). Arithmetic only: not seen in Electron.
const SIZE = Object.freeze({ width: 460, base: 110, hit: 120, max: 640 });
const CLIPBOARD_NOTE = "The corrected text is on your clipboard. It covers only what you typed in this field since it got the focus: select that text and paste over it.";
// The engine keeps the last maxFieldText characters of a field: a corrected copy of a longer message would start mid-word.
const TOO_LONG = "This message is longer than actle holds (" + DEFAULTS.maxFieldText + " characters), so a corrected copy would be incomplete: correct it by hand.";
const FOCUS_MOVED = "The focus moved since this warning was raised; type the fix by hand.";
const PAUSED = "Paused by your organisation.";
// The engine marks a warning raised by Enter, Tab or a shortcut key as having
// left the field: that key may have sent the message, and the caret may be in
// the next one. A fix typed now would land in the wrong message.
const SENT = "The key that raised this warning (Enter, Tab or a shortcut) may already have sent the message; check it and correct it by hand.";
// A policy without a guard section: normalised once, not on every key the engine polls the extension on.
const EMPTY = guard.normalizeGuard(null);

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function splitRecipients(value) {
  const list = Array.isArray(value) ? value : String(value == null ? "" : value).split(/[,;\n]/);
  return list.map((item) => String(item == null ? "" : item).trim()).filter(Boolean);
}

function describeFix(fix) {
  if (!fix) return null;
  if (fix.kind === "text") return { kind: "text", text: fix.text, position: fix.position };
  if (fix.kind === "shorthand") return { kind: "shorthand", trigger: fix.trigger };
  return { kind: "remove", with: fix.with };
}

function createApp(host) {
  const state = guard.createState();
  // Counts the fields that had the focus; a warning carries the number of its
  // field, so a fix clicked after the focus moved is refused instead of being
  // typed into whatever application is focused now.
  let focus = 0;

  function config() {
    const section = host.policy().guard;
    return section && Array.isArray(section.packs) ? section : EMPTY;
  }

  function ruleById(id) {
    return config().packs.flatMap((pack) => pack.rules).find((rule) => rule.id === id) || null;
  }

  function fieldText() {
    return host.engine && typeof host.engine.fieldText === "string" ? host.engine.fieldText : "";
  }

  /** What leaves the core for the popover, the audit and the dashboard: ids, labels and masked findings. */
  function describeHit(hit) {
    return {
      rule: hit.rule.id,
      pack: hit.rule.pack,
      label: hit.rule.label,
      severity: hit.severity,
      message: hit.message,
      findings: hit.findings.map((f) => Object.assign({ kind: f.kind, value: f.value }, f.country ? { country: f.country } : {})),
      fix: describeFix(hit.fix),
    };
  }

  function describeRule(rule) {
    return {
      id: rule.id, label: rule.label, pack: rule.pack, severity: rule.severity, recipients: rule.recipients, message: rule.message,
      detect: rule.detect.slice(), keywords: rule.keywords.slice(), match: rule.match, caseSensitive: rule.caseSensitive,
      phrases: rule.options.phrases.slice(), countries: rule.options.countries.slice(), unless: rule.unless.slice(), apps: rule.apps.slice(),
      fix: describeFix(rule.fix),
    };
  }

  /** One audit line per outcome: rule, pack, outcome, time. The "event" field lets the dashboard find them. */
  function record(hit, outcome) {
    const entry = guard.auditEntry({ rule: { id: hit.rule, pack: hit.pack } }, outcome, host.now());
    if (entry) host.audit(Object.assign({ event: "guard" }, entry));
    // The answer (fixed or dismissed) is kept on the popover's own copy of the hit, so it cannot be answered twice.
    if (outcome !== "raised") hit.outcome = outcome;
    return entry;
  }

  // A policy shortcut named by a fix is the organisation's; a personal one
  // with the same trigger is used only when the policy has none.
  function resolveShorthand(trigger) {
    const policy = host.policy();
    const shared = (Array.isArray(policy.library) ? policy.library : []).find((sh) => sh.trigger === trigger);
    const own = host.engine && Array.isArray(host.engine.library) ? host.engine.library.find((sh) => sh.trigger === trigger) : null;
    return shared || own || null;
  }

  /** Paste `addition` at the caret. The stand-in senders answer at once, Electron's through a promise that may reject. */
  function insert(from, hit, rule, addition, cursorOffset) {
    // Marked before the paste resolves, so a Dismiss that lands meanwhile skips this warning instead of counting it twice.
    hit.outcome = "fixing";
    const refused = (why) => {
      delete hit.outcome;
      return { ok: false, error: "Could not insert the text" + (why ? ": " + why : ".") };
    };
    const done = (result) => {
      if (!result || result.ok === false) return refused(result && result.error);
      record(hit, "fixed");
      const entry = host.recordInsert({ kind: "guard", trigger: rule.id, inserted: addition, typed: "" });
      return { ok: true, rule: rule.id, via: "typed", inserted: addition.length, keystrokesSaved: entry ? entry.keystrokesSaved : 0 };
    };
    let pasted;
    try {
      pasted = from.sender.replace({ backspaces: 0, text: addition, cursorOffset });
    } catch (error) {
      return refused(error && error.message);
    }
    return pasted && typeof pasted.then === "function" ? pasted.then(done, (error) => refused(error && error.message)) : done(pasted);
  }

  /**
   * Apply a hit's fix. Text at the end and a shortcut are typed at the caret.
   * The shell cannot edit text already in the field, so a "remove" fix and a
   * text fix at the start put the corrected field text (what actle saw typed
   * since the field got the focus) on the clipboard instead. Every kind is
   * refused once the focus moved (the popover never closes on its own) or
   * while the organisation has paused the desk. No warning is raised in a
   * password manager, a terminal or a sign-in window: the engine holds no
   * field text there and runs no check (core/engine.js tracksField), and a
   * warning from another window is refused once the focus moves there.
   */
  function fix(hit, from, popover) {
    const policy = host.policy();
    if (policy.paused && policy.paused.active) return { ok: false, error: PAUSED };
    if (popover.focus !== focus) return { ok: false, error: FOCUS_MOVED };
    if (popover.leftField) return { ok: false, error: SENT };
    const rule = ruleById(hit.rule);
    if (!rule) return { ok: false, error: "The rule " + hit.rule + " is no longer in the policy." };
    if (!rule.fix) return { ok: false, error: "This warning has no fix to apply." };
    const field = fieldText();
    const live = { rule, fix: rule.fix };
    if (rule.fix.kind === "remove" || rule.fix.position === "start") {
      if (field.length >= DEFAULTS.maxFieldText) return { ok: false, error: TOO_LONG };
      const corrected = guard.applyFix(field, live);
      if (corrected === field) return { ok: false, error: field ? "Nothing to correct in the text actle saw in this field." : "actle saw no text in this field; correct it by hand." };
      const copied = () => {
        from.notify(CLIPBOARD_NOTE);
        record(hit, "fixed");
        return { ok: true, rule: rule.id, via: "clipboard", inserted: 0 };
      };
      const failed = (error) => {
        const reason = error && error.message || String(error);
        delete hit.outcome;
        host.log("guard: the clipboard could not be written: " + reason);
        return { ok: false, error: "The corrected text could not be copied (" + reason + "); correct it by hand." };
      };
      // Marked while the write is pending, as insert() does for a paste.
      hit.outcome = "fixing";
      let written;
      try { written = from.clipboard.writeText(corrected); } catch (error) { return failed(error); }
      // Electron 44 writes asynchronously: report the fix only once the text is on the clipboard.
      return written && typeof written.then === "function" ? written.then(copied, failed) : copied();
    }
    if (rule.fix.kind === "text") {
      const fixed = guard.applyFix(field, live);
      if (fixed === field) return { ok: false, error: "The fix text is already in the message." };
      const addition = fixed.slice(field.length);
      return insert(from, hit, rule, addition, addition.length);
    }
    const sh = resolveShorthand(rule.fix.trigger);
    if (!sh) return { ok: false, error: "Shortcut " + rule.fix.trigger + " is not in the library." };
    // Blanks need the template form, which this popover cannot open; the person types the trigger instead.
    if (template.requiresInput(sh.expansion)) return { ok: false, error: "Shortcut " + sh.trigger + " asks for blanks; type " + sh.trigger + " in the field to fill them in." };
    const rendered = template.render(sh.expansion, null, new Date(host.now()));
    const fixed = guard.applyFix(field, live, () => rendered.text);
    if (fixed === field) return { ok: false, error: "The shortcut's text is already in the message." };
    const addition = fixed.slice(field.length);
    return insert(from, hit, rule, addition, rendered.cursorOffset + (addition.length - rendered.text.length));
  }

  /** Dismiss closes the popover: every warning in it that was not fixed counts as dismissed. */
  function dismiss(hits, payload) {
    const chosen = Number.isInteger(payload.index) ? hits.filter((hit, i) => i === payload.index) : hits;
    const open = chosen.filter((hit) => !hit.outcome);
    for (const hit of open) record(hit, "dismissed");
    return { ok: true, dismissed: open.length };
  }

  function submit(state, payload, from) {
    const popover = isObject(state) ? state : {};
    const hits = Array.isArray(popover.hits) ? popover.hits : [];
    const data = isObject(payload) ? payload : {};
    if (data.action === "dismiss") return dismiss(hits, data);
    if (data.action !== "fix") return { ok: false, error: "Unknown action " + String(data.action) + "." };
    const hit = Number.isInteger(data.index) ? hits[data.index] : null;
    if (!hit) return { ok: false, error: "Choose a warning first." };
    if (hit.outcome === "fixing") return { ok: false, error: "This fix is still being applied." };
    if (hit.outcome) return { ok: false, error: "This warning was already " + hit.outcome + "." };
    return fix(hit, from, popover);
  }

  function info() {
    const cfg = config();
    const policy = host.policy();
    return {
      configured: cfg.packs.length > 0,
      paused: !!(policy.paused && policy.paused.active),
      assumeExternal: cfg.assumeExternal === true,
      internalDomains: cfg.internalDomains.slice(),
      internalCodes: cfg.internalCodes.map((re) => re.source),
      detectors: Object.keys(guard.DETECTORS),
      countries: guard.COUNTRIES.slice(),
      packs: cfg.packs.map((pack) => ({ id: pack.id, label: pack.label, rules: pack.rules.map(describeRule) })),
      warnings: (Array.isArray(policy.warnings) ? policy.warnings : []).filter((line) => /^guard /.test(line)),
    };
  }

  function summary() {
    const all = host.store && typeof host.store.loadAudit === "function" ? host.store.loadAudit() : [];
    const entries = all.filter((entry) => isObject(entry) && entry.event === "guard");
    return { ok: true, entries: entries.length, summary: guard.summarise(entries) };
  }

  /** The dashboard's "Try it": the same check with recipients and an application typed in; nothing is audited or counted. */
  function tryCheck(payload) {
    const data = isObject(payload) ? payload : {};
    const cfg = config();
    const recipients = splitRecipients(data.recipients);
    const app = baseName(data.app);
    const hits = guard.check(data.text, { recipients, app }, cfg);
    return { ok: true, recipients: recipients.length, external: guard.treatAsExternal(recipients, cfg), app, hits: hits.map(describeHit) };
  }

  /** The engine's word-end hook: the field text against the policy's rules, each rule once per field. */
  function check(text, context) {
    const ctx = isObject(context) ? context : {};
    // No recipients are known to the shell; the core decides with assumeExternal.
    const hits = guard.check(text, { recipients: [], app: baseName(ctx.process) || ctx.app, title: ctx.title }, config(), state);
    if (!hits.length) return null;
    const described = hits.map(describeHit);
    for (const hit of described) record(hit, "raised");
    return { popover: "warning", focus, hits: described };
  }

  const app = {
    id: ID,
    title: "Guard",
    tab: true,
    ipc: {
      "guard:info": () => info(),
      "guard:summary": () => summary(),
      "guard:check": (payload) => tryCheck(payload),
    },
    extension: {
      id: ID,
      // Offered only while the policy has rule packs, so the engine holds the field's text in memory only then, as it does for keyword rules.
      get check() { return config().packs.length ? check : undefined; },
      // The engine resets on every focus change: open warnings belong to the field that lost it.
      reset: () => { state.reset(); focus += 1; },
    },
    popovers: {
      warning: {
        file: "apps/guard-warning",
        focusable: false,
        size: (action) => ({ width: SIZE.width, height: Math.min(SIZE.max, SIZE.base + SIZE.hit * (action && Array.isArray(action.hits) ? action.hits.length : 0)) }),
        submit,
      },
    },
    simulate: (sim) => simulate(sim, { host, createApp, app }),
    // Exposed for the simulator and the tests; main.js uses the entries above.
    submit,
  };
  return app;
}

module.exports = { createApp, CLIPBOARD_NOTE, TOO_LONG, FOCUS_MOVED, PAUSED, SENT, SIZE, splitRecipients };
