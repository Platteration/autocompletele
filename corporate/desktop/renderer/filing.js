// Shows the name and folder the policy proposes for a new document, asks for
// any blanks the text did not fill, and files it on Enter. Nothing is moved
// until the person confirms; Skip leaves the file untouched.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "filing" || !state.proposal) return window.actle.closePopover();
  const proposal = state.proposal;
  const $ = (id) => document.getElementById(id);
  $("source").textContent = proposal.fileName + (proposal.read && proposal.read.unsupported ? " (file name only; " + (proposal.ext || "this type") + " is not read)" : proposal.read && proposal.read.error ? " (" + proposal.read.error + ")" : "");
  $("why").textContent = proposal.rule.label + (proposal.matched && proposal.matched.length ? ": found " + proposal.matched.join(", ") : proposal.rule.id === "fallback" ? ": no rule matched" : "");
  $("name").value = proposal.name;
  $("folder").textContent = (proposal.inPlace ? "Stays in " : "Moves to ") + proposal.folder;
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
  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
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
  $("never").addEventListener("click", () => window.actle.submitPopover({ action: "ignoreFolder", path: proposal.path }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
  const first = blanks.querySelector("input") || $("name");
  first.focus();
  if (first === $("name")) first.select();
})();
