// Headless walk-through of cactle for desktop/simulate.js: a ticket
// window gets the focus, a record trigger is typed, the plan is shown, a
// copied order reference fills the customer fields through the lookup list,
// a missing blank is answered, the fill runs through a stand-in shell that
// prints the paste and Tab sequence, and three similar fills end in a learned
// proposal that becomes an own record. Synchronous on purpose, so its lines
// land before the simulator's metrics section. Throws on anything that
// should not happen.
"use strict";

const core = require("../../../core/forms.js");
const { createEngine } = require("../../../core/engine.js");
const SAMPLE = require("./sample-policy.json");

const TICKET = Object.freeze({ process: "C:\\Program Files\\Zendesk\\Zendesk.exe", title: "New ticket - Zendesk" });
const CLIPBOARD = "Re: order A-12345 arrived damaged";
const REASON = "Sorry for the delay.";

/**
 * A shell whose sender answers at once and records what it typed and pressed,
 * with the popover close in the same key list so the order is visible. Its
 * settle() says the focus is back at once, so the app skips its pause.
 */
function fakeShell(clipboardText) {
  const calls = { replaced: [], pressed: [], notified: [], actions: [], keys: [], closed: 0 };
  return {
    calls,
    settle: () => undefined,
    sender: {
      replace: (action) => {
        calls.replaced.push(action);
        const back = action.backspaces ? "backspace x" + action.backspaces : "";
        calls.keys.push(action.text ? (back ? back + ", " : "") + "paste " + JSON.stringify(action.text) : back || "paste \"\"");
        return { ok: true };
      },
      press: (name, count) => {
        calls.pressed.push([name, count]);
        calls.keys.push(name + (count > 1 ? " x" + count : ""));
        return { ok: true };
      },
      undo: () => ({ ok: true }),
      isAvailable: () => true,
    },
    clipboard: { readText: () => clipboardText, writeText: () => {} },
    notify: (body) => calls.notified.push(body),
    broadcast: () => {},
    closePopover: () => { calls.closed += 1; calls.keys.push("close popover"); },
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

function formsAction(actions, what) {
  const action = actions.find((a) => a.type === "app" && a.app === "forms");
  if (!action) throw new Error(what + " opened nothing: " + JSON.stringify(actions));
  return action;
}

function simulate(sim, internals) {
  const { print, brief } = sim;
  const { host, createApp } = internals;
  let app = internals.app;
  let engine = sim.assistant.engine;
  let focus = (context) => sim.focus(context);
  if (!app.ipc["forms:info"]().configured) {
    // The example policy may not carry a forms section: the same app is built
    // again over a host whose policy has the sample one, with a private engine
    // so the record triggers can still be typed.
    print("  the policy has no forms section; running with the app's sample section");
    const sample = core.normalizeForms(SAMPLE);
    if (sample.warnings.length) throw new Error("sample section: " + sample.warnings.join("; "));
    delete sample.warnings;
    const policy = Object.assign({}, host.policy(), { forms: sample });
    app = createApp(Object.assign({}, host, { policy: () => policy }));
    engine = createEngine({ library: [], policy, now: sim.now });
    engine.setExtensions([app.extension]);
    focus = (context) => {
      sim.focus(context);
      engine.focusChanged(context);
      app.onFocus(engine.context);
    };
  }

  const shell = fakeShell(CLIPBOARD);
  app.onStart(shell);
  focus(TICKET);
  print("  clipboard holds " + brief(CLIPBOARD));
  const action = formsAction(typeAll(engine, "Case: refund/"), "typing refund/");
  print(`  typed "refund/" -> plan popover for ${action.record.label} on ${action.form ? action.form.label + " (" + action.form.selectors.length + " selectors, not used)" : "no matched form"}; deletes ${action.backspaces}; reference from the clipboard: ${action.reference || "none"}`);
  for (const step of action.plan.steps) print(`    ${step.label} = ${brief(step.value)}${step.missing.length ? " (needs " + step.missing.join(", ") + ")" : ""}`);
  if (action.plan.skipped.length) print("    not on this form: " + action.plan.skipped.join(", "));
  print("    still needed: " + (action.plan.missing.join(", ") || "nothing"));
  if (!action.plan.missing.includes("reason")) throw new Error("the sample plan should still need the reason");

  const submit = app.popovers.plan.submit;
  const refused = submit(action, { reference: action.reference, answers: {} }, shell);
  print("  Fill without an answer -> " + (refused.ok ? "FILLED" : "refused: " + refused.error));
  if (refused.ok || shell.calls.replaced.length || shell.calls.closed) throw new Error("a plan with an open blank was typed");
  const result = submit(action, { reference: action.reference, answers: { reason: REASON } }, shell);
  if (result && typeof result.then === "function") throw new Error("the stand-in sender should answer at once");
  if (!result.ok) throw new Error("fill refused: " + result.error);
  print(`  Fill with reason -> ${result.fields} fields typed, saves ${result.keystrokesSaved} keystrokes:`);
  for (const key of shell.calls.keys) print("    " + key);
  if (shell.calls.keys[0] !== "close popover") throw new Error("the popover must close before the first key");
  if (shell.calls.replaced.some((call) => call.text.includes("[["))) throw new Error("an open blank reached the form");

  // A record that leaves form fields empty: a Tab for every field passed over.
  const gap = fakeShell("");
  app.onStart(gap);
  focus(TICKET);
  const picked = app.palette.choose({ kind: "app:forms", trigger: "form:address-change", query: "address", spentKeystrokes: 8 });
  if (!picked) throw new Error("the palette did not offer address-change");
  print(`  palette pick ${picked.record.label} with nothing copied -> still needed: ${picked.plan.missing.join(", ")}`);
  const answers = { customer: "Lee Park", address: "1 Main St" };
  const replanned = app.ipc["forms:plan"]({ recordId: picked.recordId, formId: picked.formId, reference: "", answers });
  for (const step of replanned.plan.steps) if (step.over.length) print(`    Tab over ${step.over.join(", ")} before ${step.label}`);
  const filledGap = submit(picked, { reference: "", answers }, gap);
  if (!filledGap.ok) throw new Error("gap fill refused: " + filledGap.error);
  print("    keys: " + gap.calls.keys.join(" | "));
  if (!gap.calls.pressed.some(([, count]) => count === 3)) throw new Error("E-mail and SLA hours were not tabbed over");

  // Two more fills for other customers: the constant fields become a proposal, the varying note a template.
  for (const reference of ["A-54321", "A-10021"]) {
    const again = fakeShell("order " + reference + " late");
    app.onStart(again);
    focus(TICKET);
    const next = formsAction(typeAll(engine, "refund/"), "typing refund/ again");
    const filled = submit(next, { reference: next.reference, answers: { reason: REASON } }, again);
    if (!filled.ok) throw new Error("second fill refused: " + filled.error);
    print(`  Fill again for ${next.lookup ? next.lookup.row.customer : "?"} (${reference}) -> ${filled.fields} fields`);
  }
  const info = app.ipc["forms:info"]();
  print(`  stored fills: ${info.sessions}; proposals: ${info.proposals.length}`);
  // Only what came from the policy is stored: the reason typed into the popover, and the fills' typed customer, never are.
  const storedText = JSON.stringify(host.appData("forms").load({}));
  if (storedText.includes(REASON) || storedText.includes(answers.customer)) throw new Error("a typed answer reached apps/forms.json");
  print("  stored fills hold a typed answer: no");
  const proposal = info.proposals.find((p) => p.constant.includes("sla"));
  if (!proposal) throw new Error("three similar fills proposed nothing");
  print(`  learned "${proposal.label}" (${proposal.count} fills on ${proposal.form}): ` + Object.entries(proposal.fields).map(([name, value]) => name + " = " + brief(value)).join("; "));
  const accepted = app.ipc["forms:acceptProposal"]({ digest: proposal.digest, trigger: "refund2/", label: "Refund with apology" });
  if (!accepted.ok) throw new Error("accept refused: " + accepted.error);
  print(`  accepted as own record ${accepted.record.id} with trigger refund2/`);
  focus(TICKET);
  const own = formsAction(typeAll(engine, "refund2/"), "typing refund2/");
  if (own.record.id !== accepted.record.id) throw new Error("refund2/ opened " + own.record.id);
  print(`  typed "refund2/" -> ${own.record.label}; still needed: ${own.plan.missing.join(", ") || "nothing"}`);
  print("  palette items: " + app.palette.items().map((item) => item.trigger).join(", "));
  app.onStop();
}

module.exports = { simulate, fakeShell, typeAll, TICKET, CLIPBOARD, REASON };
