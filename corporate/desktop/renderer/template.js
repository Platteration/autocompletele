// Asks for the [[blanks]] and pronoun choices of a template, then inserts.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "template") return window.actle.closePopover();
  document.getElementById("title").textContent = "Fill in " + state.trigger;
  const form = document.getElementById("form");
  for (const field of state.fields) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = field.label;
    const input = document.createElement("input");
    input.type = "text";
    input.name = "field:" + field.name;
    input.required = true;
    input.autocomplete = "off";
    label.append(span, input);
    form.append(label);
  }
  if (state.variables.some((name) => name !== "weekday")) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = "Pronouns";
    const select = document.createElement("select");
    select.name = "pronouns";
    for (const preset of ["they/them", "she/her", "he/him"]) {
      const option = document.createElement("option");
      option.value = preset;
      option.textContent = preset;
      select.append(option);
    }
    label.append(span, select);
    form.append(label);
  }
  const PRESETS = {
    "she/her": { subject: "she", object: "her", possessive: "her", possessivepronoun: "hers", reflexive: "herself" },
    "he/him": { subject: "he", object: "him", possessive: "his", possessivepronoun: "his", reflexive: "himself" },
    "they/them": { subject: "they", object: "them", possessive: "their", possessivepronoun: "theirs", reflexive: "themself" },
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = {};
    let pronouns = null;
    for (const [key, value] of new FormData(form).entries()) {
      if (key.startsWith("field:")) values[key.slice(6)] = value;
      else if (key === "pronouns") pronouns = PRESETS[value] || null;
    }
    window.actle.submitPopover({ values, pronouns });
  });
  document.getElementById("cancel").addEventListener("click", () => window.actle.closePopover());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
  const first = form.querySelector("input, select");
  if (first) first.focus();
})();
