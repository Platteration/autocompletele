// A gactle rule fired on what the person is writing: show each warning with
// its severity, message and masked findings, offer the rule's fix, and let
// the person dismiss them all. The window never takes the focus, so the field
// being typed in keeps it; main.js closes the window after a fix or Dismiss,
// or when a later warning or offer replaces it. (The Escape handler below
// only works while the window has keyboard focus, which a non-focusable
// window normally never has; it is kept for parity with the keyword popover.)
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "app" || state.app !== "guard" || !Array.isArray(state.hits) || !state.hits.length) return window.actle.closePopover();
  const $ = (id) => document.getElementById(id);
  const list = $("list");
  const SEVERITY = { block: "must not be sent", warn: "warning", info: "note" };
  // A text fix at the start cannot be typed at the caret: it goes to the clipboard like a remove fix, and says so.
  const buttonLabel = (fix) => (fix.kind === "text" && fix.position !== "start" ? "Add the text" : fix.kind === "shorthand" ? "Insert " + fix.trigger : "Copy corrected text");
  const describeFinding = (f) => f.kind + (f.country ? " " + f.country : "") + ": " + f.value;
  const buttons = [];
  let pending = false;

  function line(className, textValue) {
    const node = document.createElement("div");
    if (className) node.className = className;
    node.textContent = textValue;
    return node;
  }

  // One answer at a time: while a fix is pasting, Dismiss must not count the same warning twice.
  async function submit(payload) {
    if (pending) return;
    pending = true;
    for (const button of buttons) button.disabled = true;
    $("error").textContent = "";
    const result = await window.actle.submitPopover(payload);
    pending = false;
    if (result && result.ok === false) {
      $("error").textContent = result.error || "Could not apply the fix.";
      for (const button of buttons) button.disabled = false;
    }
  }

  state.hits.forEach((hit, index) => {
    const item = document.createElement("li");
    item.className = "warning";
    const head = line("", hit.label || hit.rule);
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = SEVERITY[hit.severity] || hit.severity;
    head.append(tag);
    item.append(head, line("", hit.message));
    if (Array.isArray(hit.findings) && hit.findings.length) item.append(line("path", "Found " + hit.findings.map(describeFinding).join("; ")));
    // A warning raised by the key that may have sent the message offers no fix: it would land in the next message.
    if (hit.fix && state.leftField) item.append(line("path", "Raised as the message went out: check it and correct it by hand."));
    if (hit.fix && !state.leftField) {
      const button = document.createElement("button");
      button.className = "primary";
      button.type = "button";
      button.textContent = buttonLabel(hit.fix);
      button.addEventListener("click", () => submit({ action: "fix", index }));
      buttons.push(button);
      item.append(button);
    }
    list.append(item);
  });
  buttons.push($("dismiss"));
  $("dismiss").addEventListener("click", () => submit({ action: "dismiss" }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
})();
