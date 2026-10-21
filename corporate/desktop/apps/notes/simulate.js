// Headless walk-through of actle Notes for desktop/simulate.js: a notes
// window gets the focus, the minutes trigger is typed, the blanks are filled
// through a stand-in shell and the rendered note is printed; then a note with
// three action items is "copied", the tray entry rebuilds its action block on
// the clipboard and the block is printed. Synchronous on purpose, so its
// lines land before the simulator's metrics section. Throws on anything that
// should not happen.
"use strict";

const core = require("../../../core/notes.js");
const { createEngine } = require("../../../core/engine.js");
const SAMPLE = require("./sample-policy.json");

const WINDOW = Object.freeze({ process: "notepad.exe", title: "ops-sync.md - Notepad" });
const VALUES = Object.freeze({ meeting: "Weekly ops sync", author: "Dana Reyes", attendees: "Ann Lee, Bob Osei, Cy Park" });
const NOTE = [
  "# Weekly ops sync",
  "",
  "## Discussion",
  "Sam will restock ward 3 by Friday.",
  "TODO: Omar to book the room for the review.",
  "@priya.k to call the vendor tomorrow.",
  "Quiet week otherwise.",
  "",
  "## Action items",
  "- None",
  "",
].join("\n");

/** A shell whose sender answers at once and whose clipboard keeps what was written; `calls.order` keeps the sequence of closes and pastes. */
function fakeShell(clipboardText) {
  const calls = { replaced: [], copied: [], notified: [], actions: [], order: [] };
  const clipboard = { text: String(clipboardText == null ? "" : clipboardText) };
  return {
    calls,
    sender: {
      replace: (action) => { calls.replaced.push(action); calls.order.push("replace"); return { ok: true }; },
      press: () => ({ ok: true }),
      undo: () => ({ ok: true }),
      isAvailable: () => true,
    },
    clipboard: { readText: () => clipboard.text, writeText: (text) => { clipboard.text = String(text); calls.copied.push(clipboard.text); } },
    notify: (body) => calls.notified.push(body),
    broadcast: () => {},
    closePopover: () => calls.order.push("closePopover"),
    handleAction: (action) => calls.actions.push(action),
    showItemInFolder: () => {},
    openDashboard: () => {},
  };
}

function typeAll(engine, text) {
  let actions = [];
  for (const ch of text) actions = actions.concat(engine.keyTyped({ text: ch }));
  return actions;
}

function simulate(sim, internals) {
  const { print, brief } = sim;
  const { host, createApp } = internals;
  let app = internals.app;
  let engine = sim.assistant.engine;
  let focus = (context) => sim.focus(context);
  if (!app.ipc["notes:info"]().configured) {
    // The example policy may not carry a notes section: the same app is built
    // again over a host whose policy has the sample one, with a private engine
    // so the document triggers can still be typed.
    print("  the policy has no notes section; running with the app's sample section (its insert still counts in the metrics below)");
    const sample = core.normalizeNotes(SAMPLE);
    if (sample.warnings.length) throw new Error("sample section: " + sample.warnings.join("; "));
    delete sample.warnings;
    const policy = Object.assign({}, host.policy(), { notes: sample });
    app = createApp(Object.assign({}, host, { policy: () => policy }));
    engine = createEngine({ library: [], policy, now: sim.now });
    engine.setExtensions([app.extension]);
    focus = (context) => {
      sim.focus(context);
      engine.focusChanged(context);
    };
  }

  // The shell goes to submit and the tray entry as arguments; onStart is
  // main.js's, so the registered app keeps whatever shell it was given.
  const shell = fakeShell("");
  focus(WINDOW);
  const action = typeAll(engine, "Weekly ops sync /mins").find((a) => a.type === "app" && a.app === "notes");
  if (!action) throw new Error("typing /mins opened nothing");
  print(`  typed "/mins" -> fill popover for ${action.label}; deletes ${action.backspaces}; blanks: ${action.blanks.map((b) => b.name + (b.list ? " (list)" : "") + (b.value ? " = " + b.value : "")).join(", ")}`);
  const refused = app.submit(action, { values: {} }, shell);
  print("  Insert with nothing filled in -> " + (refused.ok ? "INSERTED" : "refused: " + refused.error));
  if (refused.ok || shell.calls.replaced.length) throw new Error("a note with open blanks was inserted");
  const result = app.submit(action, { values: VALUES }, shell);
  if (result && typeof result.then === "function") throw new Error("the stand-in sender should answer at once");
  if (!result.ok) throw new Error("insert refused: " + result.error);
  const typed = shell.calls.replaced[0];
  if (!typed || typed.text.includes("[[")) throw new Error("an open blank reached the editor");
  if (shell.calls.order.join(",") !== "closePopover,replace") throw new Error("the paste did not follow the popover's close: " + shell.calls.order.join(","));
  print(`  Insert with ${Object.keys(VALUES).join(", ")} -> popover closed, then deleted ${typed.backspaces}, pasted ${typed.text.length} characters, caret at ${typed.cursorOffset}, saves ${result.keystrokesSaved} keystrokes:`);
  for (const line of typed.text.replace(/\n$/, "").split("\n")) print("    | " + line);
  const remembered = host.settings().notesAuthor;
  if (remembered !== VALUES.author) throw new Error("the author was not remembered: " + JSON.stringify(remembered));
  print("  author remembered for next time: " + remembered);

  // Action items: the note is on the clipboard, the tray entry rebuilds its block there.
  const before = sim.assistant.ledger.entries().length;
  const copied = fakeShell(NOTE);
  print("  copied note: " + brief(NOTE));
  const [tray] = app.trayItems(copied);
  const updated = tray.click(copied);
  if (!updated.ok || updated.items !== 3 || !copied.calls.copied.length) throw new Error("the tray entry did not update the block: " + JSON.stringify(updated));
  print(`  tray "${tray.label}" -> ${updated.items} action items; ${copied.calls.notified.pop()}`);
  const text = copied.clipboard.readText();
  const block = text.slice(text.lastIndexOf("## "));
  for (const line of block.replace(/\n$/, "").split("\n")) print("    | " + line);
  if (text.split("## Action items").length !== 2) throw new Error("the block was duplicated");
  const again = tray.click(copied);
  if (!again.ok || again.changed) throw new Error("a second update changed the note");
  print("  again -> " + again.items + " action items, note unchanged");
  if (sim.assistant.ledger.entries().length !== before) throw new Error("a clipboard update reached the metrics");
  print("  metrics entries for the clipboard updates: none (actle typed nothing)");
  const empty = fakeShell("");
  tray.click(empty);
  print("  empty clipboard -> " + empty.calls.notified[0]);
}

module.exports = { simulate, fakeShell, typeAll, WINDOW, VALUES, NOTE };
