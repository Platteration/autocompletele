// Lists the files behind a document shortcut: Attach puts the chosen files
// into the message being written; Copy file paths and Reveal are the fallbacks.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "documents") return window.actle.closePopover();
  document.getElementById("title").textContent = state.label + " (" + state.trigger + ")";
  const list = document.getElementById("list");
  state.documents.forEach((doc, index) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = true;
    box.dataset.index = String(index);
    const text = document.createElement("span");
    text.textContent = doc.title;
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = doc.path;
    label.append(box, text, path);
    item.append(label);
    list.append(item);
  });
  const selected = () => Array.from(list.querySelectorAll("input:checked")).map((box) => Number(box.dataset.index));
  document.getElementById("attach").addEventListener("click", () => window.actle.submitPopover({ action: "attach", selected: selected() }));
  document.getElementById("copy").addEventListener("click", () => window.actle.submitPopover({ action: "copy", selected: selected() }));
  document.getElementById("reveal").addEventListener("click", () => window.actle.submitPopover({ action: "reveal", selected: selected() }));
  document.getElementById("cancel").addEventListener("click", () => window.actle.closePopover());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
  document.getElementById("attach").focus();
})();
