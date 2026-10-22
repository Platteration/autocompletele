// Shows the name and folder the policy proposes for a new document, asks for
// any blanks the text did not fill, and files it on Enter. Nothing is moved
// until the person confirms; Skip leaves the file untouched.
//
// The popover opens when a file lands in a watched folder, not when the
// person asked, so main.js shows it without taking the focus, and this page
// focuses and selects nothing. It files nothing and turns no folder off
// until the person presses on a field or button once it has been on screen
// for ARM_MS, and that press stops counting when the popover loses the
// focus: keys typed before such a press never file anything.
"use strict";

(async function () {
  // A press that lands as the popover appears was aimed at what was under
  // the pointer a moment before (Chromium ignores input on a new permission
  // prompt for 500 ms for the same reason), so presses count only ARM_MS
  // after main.js has shown the window and this page shows the proposal.
  // main.js says so with an event, or with `shown` in the state when it
  // showed the window before this page listened.
  const ARM_MS = 700;
  let engaged = false;
  let armed = false;
  let shown = false;
  let rendered = false;
  let arming = false;
  const arm = () => {
    if (!shown || !rendered || arming) return;
    arming = true;
    setTimeout(() => { armed = true; }, ARM_MS);
  };
  window.actle.onPopoverShown(() => { shown = true; arm(); });
  // A press on a field or button is the person choosing this popover (the
  // rest of the window is a drag area, which gets no events). Before it is
  // armed, a press leaves no caret in a field for the next keys.
  document.addEventListener("mousedown", (event) => { if (!armed) event.preventDefault(); }, true);
  document.addEventListener("pointerdown", () => { if (armed) engaged = true; }, true);
  // Back from another application (or handed the focus by the window
  // manager), the popover needs a new press, and no field keeps the caret.
  window.addEventListener("blur", (event) => {
    if (event.target !== window) return;
    engaged = false;
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === "function") active.blur();
  });
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "filing" || !state.proposal) return window.actle.closePopover();
  if (state.shown) shown = true;
  const proposal = state.proposal;
  const $ = (id) => document.getElementById(id);
  $("source").textContent = proposal.fileName + (proposal.read && proposal.read.unsupported ? " (file name only; " + (proposal.ext || "this type") + " is not read)" : proposal.read && proposal.read.error ? " (" + proposal.read.error + ")" : "");
  $("why").textContent = proposal.rule.label + (proposal.matched && proposal.matched.length ? ": found " + proposal.matched.join(", ") : proposal.rule.id === "fallback" ? ": no rule matched" : "");
  $("name").value = proposal.name;
  $("folder").textContent = (proposal.inPlace ? "Stays in " : "Moves to ") + proposal.folder;
  const notYet = () => {
    $("error").textContent = "Click the name or File it to file this document.";
  };
  const blanks = $("blanks");
  for (const name of proposal.missing || []) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = name;
    const input = document.createElement("input");
    input.type = "text";
    input.name = "answer:" + name;
    input.required = true;
    input.autocomplete = "off";
    label.append(span, input);
    blanks.append(label);
  }
  rendered = true;
  arm();
  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!engaged) return notYet();
    const answers = {};
    for (const [key, value] of new FormData($("form")).entries()) {
      if (key.startsWith("answer:")) answers[key.slice(7)] = value;
    }
    $("file").disabled = true;
    const result = await window.actle.submitPopover({ action: "file", path: proposal.path, name: $("name").value, answers });
    if (result && result.ok === false) {
      $("error").textContent = result.error || "Could not file the document.";
      $("file").disabled = false;
    }
  });
  $("skip").addEventListener("click", () => window.actle.closePopover());
  $("never").addEventListener("click", async () => {
    if (!engaged) return notYet();
    const result = await window.actle.submitPopover({ action: "ignoreFolder", path: proposal.path });
    if (result && result.ok === false) $("error").textContent = result.error || "Could not turn this folder off.";
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
})();
