// Headless walk-through of actle Guard for desktop/simulate.js: a message
// with a Luhn-valid card number and a contract without the disclaimer is
// typed into a mail window. Each warning opens its own popover as it fires,
// as main.js shows one window per word end, and the person answers it
// through a stand-in shell: Dismiss for the card, the text fix for the
// contract. A chat window then shows the limits: a warning left open is
// replaced by the next one and counts as unanswered, and a fix clicked after
// the focus moved is refused. The counts are printed and the audit file is
// checked for card digits. Synchronous on purpose, so its lines land before
// the simulator's metrics section. Throws on anything that should not happen.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const guard = require("../../../core/guard.js");
const { expander } = require("../../../core/personal.js");
const SAMPLE = require("./sample-policy.json");

const CARD = "4111 1111 1111 1111";
const MESSAGE = "Hello,\n\nThe card on file is " + CARD + ", thanks. Please sign the attached contract ";
const CHAT = "It is guaranteed, see the contract ";
const MAIL = Object.freeze({ process: "OUTLOOK.EXE", title: "Payment details - Message" });
const TEAMS = Object.freeze({ process: "Teams.exe", title: "Chat" });
const BANK = Object.freeze({ process: "chrome.exe", title: "Online Banking" });

/** A shell whose sender answers at once and records what it typed, copied, said and opened. */
function fakeShell() {
  const calls = { replaced: [], copied: [], notified: [], actions: [], closed: 0 };
  return {
    calls,
    sender: {
      replace: (action) => { calls.replaced.push(action); return { ok: true }; },
      press: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      isAvailable: () => true,
    },
    clipboard: { readText: () => "", writeText: (text) => calls.copied.push(text) },
    notify: (body) => calls.notified.push(body),
    broadcast: () => {},
    closePopover: () => { calls.closed += 1; },
    handleAction: (action) => calls.actions.push(action),
    showItemInFolder: () => {},
    openDashboard: () => {},
  };
}

function simulate(sim, internals) {
  const { print, brief, assistant } = sim;
  const { host, createApp } = internals;
  let app = internals.app;
  const viaEngine = app.ipc["guard:info"]().configured;
  // Without a guard section in the policy, the same app is built again over a
  // host whose policy has the sample one. The engine runs only the policy's
  // app, so this copy is fed the field text and the focus changes by hand.
  let field = "";
  if (!viaEngine) {
    print("  the policy has no guard section; running with the app's sample section");
    const sample = guard.normalizeGuard(SAMPLE);
    if (sample.warnings.length) throw new Error("sample section: " + sample.warnings.join("; "));
    delete sample.warnings;
    app = createApp(Object.assign({}, host, { policy: () => Object.assign({}, host.policy(), { guard: sample }) }));
  }
  const shell = fakeShell();
  // main.js keeps one popover on screen; a new one closes the previous.
  let open = null;
  const unanswered = [];

  function focus(context) {
    sim.focus(context);
    if (!viaEngine) {
      app.extension.reset();
      field = "";
    }
  }

  function leftOpen() {
    const left = open ? open.hits.filter((hit) => !hit.outcome).map((hit) => hit.rule) : [];
    unanswered.push(...left);
    open = null;
    return left;
  }

  function show(action, answer) {
    const replaced = leftOpen();
    if (replaced.length) print("  a new warning replaces the window: " + replaced.join(", ") + " left unanswered");
    open = Object.assign({ kind: "app" }, action);
    if (JSON.stringify(open).includes(CARD.slice(0, 9))) throw new Error("card digits reached the action");
    print("  popover (" + open.hits.length + " warning" + (open.hits.length === 1 ? "" : "s") + ", masked):");
    for (const hit of open.hits) {
      print(`    ${hit.severity} ${hit.pack}/${hit.rule}: ${hit.message}`);
      print(`      found ${hit.findings.map((f) => f.kind + " " + JSON.stringify(f.value)).join("; ")}${hit.fix ? "; fix: " + hit.fix.kind : ""}`);
    }
    if (answer) answer(open);
  }

  /** Type `text` key by key into `context`; `answer(popover)` runs when a warning window opens, as the person would see it. */
  function type(context, text, answer) {
    for (const ch of text) {
      const key = ch === "\n" ? { text: "\n", resetsBuffer: true } : { text: ch };
      const actions = assistant.keyTyped(key).filter((action) => action.type === "app" && action.app === "guard");
      if (!viaEngine && !key.resetsBuffer) {
        // The engine checks at a word end; the sample copy gets the same moments.
        const ended = field.length > 0 && !expander.isBoundary(field[field.length - 1]) && expander.isBoundary(ch);
        field += ch;
        const hit = ended ? app.extension.check(field, context) : null;
        if (hit) actions.push(Object.assign({ type: "app", app: "guard" }, hit));
      }
      for (const action of actions) show(action, answer);
      sim.tick(120);
    }
  }

  /** The popover's answer; main.js closes the window on anything but a refusal, and the warnings left in it are unanswered. */
  function submit(payload) {
    const result = app.submit(open, payload, shell);
    if (result && typeof result.then === "function") throw new Error("the stand-in sender should answer at once");
    if (result.ok !== false) leftOpen();
    return result;
  }

  focus(MAIL);
  print(`  typing ${MESSAGE.length} characters into the mail window: a Luhn-valid test card number, then a contract without the notice`);
  type(MAIL, MESSAGE, (popover) => {
    const hit = popover.hits[0];
    if (hit.fix && hit.fix.kind === "text") {
      const fixed = submit({ action: "fix", index: 0 });
      if (!fixed.ok) throw new Error("fix refused: " + fixed.error);
      const typed = shell.calls.replaced[shell.calls.replaced.length - 1];
      if (!viaEngine) field += typed.text;
      print(`  Fix "${hit.label}" -> typed ${typed.text.length} characters at the caret: ${brief(typed.text)}; saves ${fixed.keystrokesSaved} keystrokes`);
    } else {
      print(`  Dismiss -> ${submit({ action: "dismiss" }).dismissed} warning(s) dismissed`);
    }
  });
  if (shell.calls.replaced.length !== 1) throw new Error("expected one typed fix, got " + shell.calls.replaced.length);

  focus(TEAMS);
  print(`  typing ${brief(CHAT)} into a chat window without answering the warnings`);
  type(TEAMS, CHAT, null);
  if (!open) throw new Error("no warning left open in the chat window");
  focus(BANK);
  const stale = submit({ action: "fix", index: 0 });
  if (stale.ok !== false || shell.calls.replaced.length !== 1) throw new Error("a fix after the focus moved must be refused");
  print(`  Fix clicked after the focus moved -> refused: ${stale.error}`);
  print(`  Dismiss -> ${submit({ action: "dismiss" }).dismissed} warning(s) dismissed`);

  const tried = app.ipc["guard:check"]({ text: "Her NIE is X1234567L, see PRJ-ORCA.", recipients: "buyer@customer.test" });
  print(`  Try it with an outside recipient -> ${tried.hits.map((hit) => hit.rule + " [" + hit.findings.map((f) => f.value).join(", ") + "]").join("; ") || "nothing"}`);
  const summary = app.ipc["guard:summary"]().summary;
  print(`  counts: ${summary.total.raised} raised, ${summary.total.accepted} fixed, ${summary.total.dismissed} dismissed, ${summary.total.unanswered} unanswered`);
  if (summary.total.unanswered !== unanswered.length) throw new Error("unanswered: summary says " + summary.total.unanswered + ", the shell saw " + unanswered.length);
  for (const row of summary.byRule) print(`    ${row.pack}/${row.rule}: raised ${row.raised}, fixed ${row.accepted}, dismissed ${row.dismissed}, unanswered ${row.unanswered}`);
  const auditFile = path.join(host.dataDir, "audit.jsonl");
  const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
  if (!audit.includes('"event":"guard"')) throw new Error("no guard lines in the audit file");
  if (/4111|1111 1111/.test(audit)) throw new Error("card digits reached the audit file");
  print("  audit log holds card digits: no; typed text: " + (audit.includes("Please sign") ? "YES" : "no"));
}

module.exports = { simulate, fakeShell, MESSAGE, CHAT, CARD, MAIL, TEAMS, BANK };
