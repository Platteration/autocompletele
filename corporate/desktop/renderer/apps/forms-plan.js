// Shows the plan for a form record: the form matched to the window the
// trigger was typed in, a reference that fills the customer fields from a
// lookup list (tried on the clipboard once, when the popover opened), the
// values about to be typed with the fields Tab passes over, and an input for
// every blank still open. Fill closes this window and types the values. The
// app refuses a plan with an open blank, so the refusal stays readable here
// instead of reaching the form. Changing the reference plans again through
// the forms:plan channel.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "app" || state.app !== "forms" || !state.record || !state.plan) return window.actle.closePopover();
  const $ = (id) => document.getElementById(id);
  const notes = state.notes || {};
  // Answers typed so far, kept across re-plans so a reference change does not empty them.
  const answers = {};
  let planned = { form: state.form, lookup: state.lookup, plan: state.plan, reference: state.reference || "" };
  let sequence = 0;

  function line(parent, className, textValue) {
    const node = document.createElement("div");
    if (className) node.className = className;
    node.textContent = textValue;
    parent.append(node);
    return node;
  }

  function render() {
    $("title").textContent = "Fill " + state.record.label + (state.record.own ? " (your record)" : "");
    document.title = "Fill " + state.record.label;
    $("matched").textContent = planned.form ? "Form: " + planned.form.label : (notes.noForm || "No form matched this window.");
    $("selectors").textContent = planned.form && planned.form.selectors && planned.form.selectors.length ? (notes.selectors || "") : "";
    const lookup = planned.lookup;
    $("lookup").textContent = lookup ? "Reference " + lookup.key + " (" + lookup.lookup + "): " + Object.entries(lookup.row).map(([name, value]) => name + " = " + value).join("; ")
      : planned.reference ? "No lookup row matches " + planned.reference + "." : "";
    const steps = $("steps");
    steps.textContent = "";
    for (const step of planned.plan.steps) {
      const item = document.createElement("li");
      if (step.over && step.over.length) line(item, "path", "Tab over " + step.over.join(", "));
      line(item, "", step.label + ": " + step.value);
      if (step.missing.length) line(item, "path", "needs " + step.missing.join(", "));
      steps.append(item);
    }
    if (!planned.plan.steps.length) {
      const item = document.createElement("li");
      item.className = "warning";
      item.textContent = "Nothing to fill: this form has none of the record's fields.";
      steps.append(item);
    }
    $("skipped").textContent = planned.plan.skipped.length ? "Not on this form: " + planned.plan.skipped.join(", ") : "";
    const blanks = $("blanks");
    blanks.textContent = "";
    for (const name of planned.plan.missing) {
      const label = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = name;
      const input = document.createElement("input");
      input.type = "text";
      input.name = "answer:" + name;
      input.required = true;
      input.autocomplete = "off";
      input.value = answers[name] || "";
      input.addEventListener("input", () => { answers[name] = input.value; });
      label.append(span, input);
      blanks.append(label);
    }
    $("fill").textContent = planned.plan.missing.length ? "Fill in and fill the form" : "Fill";
    $("fill").disabled = !planned.plan.steps.length;
  }

  /** Plan again for the reference typed; a stale answer (an earlier keystroke) is dropped, a refusal is shown over the last plan. */
  async function replan() {
    if (typeof window.actle.invoke !== "function") return;
    const reference = $("reference").value;
    const mine = ++sequence;
    let result;
    try {
      result = await window.actle.invoke("forms:plan", { recordId: state.recordId, formId: state.formId, reference, answers: {} });
    } catch (error) {
      result = { ok: false, error: "Could not plan: " + ((error && error.message) || error) };
    }
    if (mine !== sequence) return;
    if (!result || result.ok === false) {
      $("error").textContent = (result && result.error) || "Could not plan the fill.";
      return;
    }
    planned = { form: result.form, lookup: result.lookup, plan: result.plan, reference: result.reference };
    render();
    $("error").textContent = "";
  }

  $("reference").value = planned.reference;
  render();
  $("reference").addEventListener("input", replan);
  // The desk could not read the clipboard while the trigger was being typed: ask once now, and plan again with it.
  if (state.clipboardPending && !$("reference").value) {
    window.actle.invoke("forms:clipboardReference").then((result) => {
      if (result && result.reference && !$("reference").value) {
        $("reference").value = result.reference;
        replan();
      }
    }, () => {});
  }
  $("plan-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const given = {};
    for (const [key, value] of new FormData($("plan-form")).entries()) {
      if (key.startsWith("answer:")) given[key.slice(7)] = value;
    }
    $("fill").disabled = true;
    $("error").textContent = "";
    let result;
    try {
      result = await window.actle.submitPopover({ reference: $("reference").value, answers: given });
    } catch (error) {
      result = { ok: false, error: "Could not fill the form: " + ((error && error.message) || error) };
    }
    // A refusal keeps the popover open; a fill that failed half-way closes it (the app said so through a notification).
    if (result && result.ok === false && !result.close) {
      $("error").textContent = result.error || "Could not fill the form.";
      $("fill").disabled = false;
    }
  });
  $("cancel").addEventListener("click", () => window.actle.closePopover());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
  const first = $("blanks").querySelector("input") || $("reference");
  first.focus();
})();
