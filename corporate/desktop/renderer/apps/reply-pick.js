// Lists the replies that fit the copied message, best first, with their
// blanks filled from it. The radios are the one selection model (a fieldset
// names the group): ↑ ↓ anywhere in the popover or a click pick one, the
// blanks the message could not fill become inputs, Enter inserts. What was
// typed into a candidate's blanks is kept while the selection moves. The app
// refuses a reply with an open blank, so the refusal stays readable here
// instead of reaching the mail.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "app" || state.app !== "reply" || !Array.isArray(state.candidates) || !state.candidates.length) return window.actle.closePopover();
  const $ = (id) => document.getElementById(id);
  const list = $("list");
  const blanks = $("blanks");
  const candidates = state.candidates;
  // Answers typed so far, per candidate, so moving the selection and back loses nothing.
  const typed = candidates.map(() => ({}));
  let selected = 0;

  function line(className, textValue) {
    const node = document.createElement("div");
    if (className) node.className = className;
    node.textContent = textValue;
    return node;
  }

  function renderBlanks() {
    blanks.textContent = "";
    const at = selected;
    const missing = candidates[at].missing || [];
    for (const name of missing) {
      const label = document.createElement("label");
      const span = document.createElement("span");
      span.textContent = name;
      const input = document.createElement("input");
      input.type = "text";
      input.name = "answer:" + name;
      input.required = true;
      input.autocomplete = "off";
      input.value = typed[at][name] || "";
      input.addEventListener("input", () => { typed[at][name] = input.value; });
      label.append(span, input);
      blanks.append(label);
    }
    $("insert").textContent = missing.length ? "Fill in and insert" : "Insert";
    $("error").textContent = "";
  }

  function focusFirst() {
    const first = blanks.querySelector("input") || list.querySelectorAll("input[type=radio]")[selected];
    if (first) first.focus();
  }

  function select(index) {
    selected = Math.max(0, Math.min(candidates.length - 1, index));
    list.querySelectorAll("input[type=radio]").forEach((radio, i) => { radio.checked = i === selected; });
    renderBlanks();
    focusFirst();
  }

  candidates.forEach((candidate, index) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "candidate";
    radio.value = String(index);
    radio.checked = index === selected;
    radio.addEventListener("change", () => { if (radio.checked) select(index); });
    const body = document.createElement("div");
    const matched = Array.isArray(candidate.matched) && candidate.matched.length ? " (" + candidate.matched.join(", ") + ")" : "";
    body.append(line("", candidate.label + matched));
    body.append(line("path", String(candidate.text || "").replace(/\s+/g, " ").slice(0, 160)));
    const found = Object.entries(candidate.values || {});
    if (found.length) body.append(line("path", "From the message: " + found.map(([name, value]) => name + " = " + value).join("; ")));
    if (candidate.missing && candidate.missing.length) body.append(line("path", "Still needed: " + candidate.missing.join(", ")));
    label.append(radio, body);
    item.append(label);
    list.append(item);
  });
  renderBlanks();

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const answers = {};
    for (const [key, value] of new FormData($("form")).entries()) {
      if (key.startsWith("answer:")) answers[key.slice(7)] = value;
    }
    $("insert").disabled = true;
    const result = await window.actle.submitPopover({ index: selected, answers });
    if (result && result.ok === false) {
      $("error").textContent = result.error || "Could not insert the reply.";
      $("insert").disabled = false;
    }
  });
  $("cancel").addEventListener("click", () => window.actle.closePopover());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return window.actle.closePopover();
    // The radios move the selection themselves while one of them has the focus.
    const inRadio = event.target && event.target.type === "radio";
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !inRadio) {
      select(selected + (event.key === "ArrowDown" ? 1 : -1));
      event.preventDefault();
    }
  });
  focusFirst();
})();
