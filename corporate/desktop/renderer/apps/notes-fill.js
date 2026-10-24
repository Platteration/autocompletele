// Asks for the blanks of the note document whose trigger was typed (or that
// was picked in the palette): one input per blank, the author prefilled from
// the person's setting, a list blank as one comma-separated line. Enter
// inserts. The app refuses while a blank is open, so the refusal stays
// readable here instead of reaching the editor.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "app" || state.app !== "notes" || !state.documentId) return window.actle.closePopover();
  const $ = (id) => document.getElementById(id);
  const blanks = Array.isArray(state.blanks) ? state.blanks : [];
  $("title").textContent = "Insert " + (state.label || state.documentId);
  document.title = "Insert " + (state.label || state.documentId);
  $("hint").textContent = blanks.length
    ? "Fill in the blanks and press Enter to paste the note where you are writing." + (blanks.some((b) => b.list) ? " A list takes several values separated by commas." : "")
    : "This document has no blanks: press Enter to paste it where you are writing.";
  const holder = $("blanks");
  for (const blank of blanks) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = blank.name + (blank.list ? " (several, separated by commas)" : "");
    const input = document.createElement("input");
    input.type = "text";
    input.name = "value:" + blank.name;
    input.value = blank.value == null ? "" : String(blank.value);
    input.autocomplete = "off";
    input.spellcheck = false;
    label.append(span, input);
    holder.append(label);
  }
  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = {};
    for (const [key, value] of new FormData($("form")).entries()) {
      if (key.startsWith("value:")) values[key.slice(6)] = value;
    }
    $("insert").disabled = true;
    const result = await window.actle.submitPopover({ values });
    if (result && result.ok === false) {
      $("error").textContent = result.error || "Could not insert the note.";
      $("insert").disabled = false;
    }
  });
  $("cancel").addEventListener("click", () => window.actle.closePopover());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
  // The first blank still open gets the focus; a prefilled author is skipped.
  const inputs = Array.from(holder.querySelectorAll("input"));
  const target = inputs.find((input) => !input.value) || inputs[0] || $("insert");
  if (target) target.focus();
})();
