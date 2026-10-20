// Search palette: find a shortcut or document set by trigger or by any words
// in it, and insert it into the application underneath with Enter.
"use strict";

(function () {
  const api = window.actle;
  const input = document.getElementById("query");
  const list = document.getElementById("results");
  const status = document.getElementById("status");
  let results = [];
  let selected = 0;
  let pending = 0;

  function render() {
    list.textContent = "";
    results.forEach((item, index) => {
      const row = document.createElement("li");
      row.id = "result-" + index;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selected));
      const head = document.createElement("div");
      head.className = "palette-head";
      const trigger = document.createElement("span");
      trigger.className = "mono";
      trigger.textContent = item.trigger;
      const tag = document.createElement("span");
      tag.className = "palette-tag";
      tag.textContent = item.kind === "documents" ? "documents" : item.needsInput ? "fill-in" : item.source === "organization" ? "organisation" : "yours";
      head.append(trigger, tag);
      const body = document.createElement("div");
      body.className = "path";
      body.textContent = item.preview;
      row.append(head, body);
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => { selected = index; choose(); });
      list.append(row);
    });
    if (results.length) {
      input.setAttribute("aria-activedescendant", "result-" + selected);
      const chosen = document.getElementById("result-" + selected);
      if (chosen) chosen.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
      const empty = document.createElement("li");
      empty.className = "palette-empty";
      empty.textContent = input.value.trim() ? "Nothing matches." : "No shortcuts yet.";
      list.append(empty);
    }
    status.textContent = results.length ? results.length + " result" + (results.length === 1 ? "" : "s") : "No results";
  }

  async function update() {
    const ticket = ++pending;
    const found = await api.paletteSearch(input.value);
    if (ticket !== pending) return; // a newer query is on its way
    results = Array.isArray(found) ? found : [];
    selected = 0;
    render();
  }

  function choose() {
    const item = results[selected];
    if (!item) return;
    api.paletteChoose({ kind: item.kind, trigger: item.trigger, query: input.value });
  }

  input.addEventListener("input", () => { update().catch(console.error); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && results.length) {
      selected = (selected + 1) % results.length;
      render();
      event.preventDefault();
    } else if (event.key === "ArrowUp" && results.length) {
      selected = (selected + results.length - 1) % results.length;
      render();
      event.preventDefault();
    } else if (event.key === "Enter") {
      choose();
      event.preventDefault();
    } else if (event.key === "Escape") {
      api.paletteClose();
      event.preventDefault();
    }
  });
  input.focus();
  update().catch(console.error);
})();
