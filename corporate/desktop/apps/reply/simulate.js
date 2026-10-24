// Headless walk-through of mactle for desktop/simulate.js: a late-order
// message is "copied", the fitting replies are ranked, one is inserted
// through a stand-in shell, and the counts are printed. Synchronous on
// purpose, so its lines land before the simulator's metrics section. Throws
// on anything that should not happen.
"use strict";

const core = require("../../../core/reply.js");
const SAMPLE = require("./sample-policy.json");

const MESSAGE = [
  "Hi Sam,",
  "",
  "My order #A-55120 placed on 3 October 2026 has still not arrived and the carrier now says it is delayed.",
  "Could you also send me a copy of the invoice?",
  "Customer ID: C-778",
  "",
  "Kind regards,",
  "Jane Doe",
  "",
  "On Mon, 12 Oct 2026, Sam wrote:",
  "> Your order 99999 is on its way, the invoice follows.",
].join("\n");

/** A shell whose sender answers at once and records what it typed; `order` keeps the sequence of closes and pastes. */
function fakeShell(clipboardText) {
  const calls = { replaced: [], notified: [], actions: [], closed: 0, order: [] };
  return {
    calls,
    sender: {
      replace: (action) => { calls.order.push("replace"); calls.replaced.push(action); return { ok: true }; },
      press: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      isAvailable: () => true,
    },
    clipboard: { readText: () => clipboardText, writeText: () => {} },
    notify: (body) => calls.notified.push(body),
    broadcast: () => {},
    closePopover: () => { calls.closed += 1; calls.order.push("closePopover"); },
    handleAction: (action) => calls.actions.push(action),
    showItemInFolder: () => {},
    openDashboard: () => {},
  };
}

function simulate(sim, internals) {
  const { print, brief } = sim;
  const { host, createApp } = internals;
  let app = internals.app;
  if (!app.ipc["reply:info"]().configured) {
    // The example policy may not carry a reply section yet: the same app is
    // built again over a host whose policy has the sample one.
    print("  the policy has no replies; running with the app's sample section");
    const sample = core.normalizeReplies(SAMPLE);
    if (sample.warnings.length) throw new Error("sample section: " + sample.warnings.join("; "));
    delete sample.warnings;
    app = createApp(Object.assign({}, host, { policy: () => Object.assign({}, host.policy(), { reply: sample }) }));
  }
  const { offer, submit } = app;
  print("  copied message: " + brief(MESSAGE));
  const shell = fakeShell(MESSAGE);
  const action = offer(shell, { via: "simulate" });
  if (!action) throw new Error("nothing offered: " + shell.calls.notified.join("; "));
  action.candidates.forEach((c, i) => {
    print(`  ${i + 1}. ${c.label} [${c.matched.join(", ")}] -> ${brief(c.text)}${c.missing.length ? "; asks for " + c.missing.join(", ") : ""}`);
  });
  const first = action.candidates[0];
  if (first.missing.length) {
    const refused = submit(action, { index: 0, answers: {} }, shell);
    print("  Insert without answers -> " + (refused.ok ? "INSERTED" : "refused: " + refused.error));
    if (refused.ok || shell.calls.replaced.length) throw new Error("a reply with open blanks was inserted");
    if (shell.calls.closed) throw new Error("a refusal closed the popover");
  }
  const answers = Object.fromEntries(first.missing.map((name) => [name, name === "promise" ? "Friday 23 October" : "(" + name + ")"]));
  const result = submit(action, { index: 0, answers }, shell);
  if (result && typeof result.then === "function") throw new Error("the stand-in sender should answer at once");
  if (!result.ok) throw new Error("insert refused: " + result.error);
  const typed = shell.calls.replaced[0];
  if (!typed || typed.text.includes("[[")) throw new Error("an open blank reached the field");
  if (shell.calls.order.join(",") !== "closePopover,replace") throw new Error("the paste did not follow the popover's close: " + shell.calls.order.join(","));
  print("  popover closed, then the paste went to the compose window");
  print(`  Insert ${first.label}${first.missing.length ? " with " + Object.keys(answers).join(", ") : ""} -> ${typed.text.length} characters pasted, caret at ${typed.cursorOffset}, saves ${result.keystrokesSaved} keystrokes`);
  for (const line of typed.text.split("\n")) print("    | " + line);
  const stats = app.ipc["reply:stats"]().stats;
  print("  counts: " + Object.entries(stats).map(([id, row]) => id + " offered " + row.offered + ", inserted " + row.inserted).join("; "));
  const empty = fakeShell("");
  if (offer(empty, {}) !== null || empty.calls.actions.length) throw new Error("an empty clipboard opened the popover");
  print("  empty clipboard -> " + empty.calls.notified[0]);
}

module.exports = { simulate, fakeShell, MESSAGE };
