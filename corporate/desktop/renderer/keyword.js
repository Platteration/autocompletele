// A keyword rule matched what the person is writing: offer its insert.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "keyword") return window.actle.closePopover();
  const list = document.getElementById("list");
  state.hits.forEach((hit, index) => {
    const item = document.createElement("li");
    const label = document.createElement("div");
    label.textContent = hit.rule.label + " (" + hit.matched.join(", ") + ")";
    const what = document.createElement("div");
    what.className = "path";
    what.textContent = hit.rule.insert.kind === "text" ? hit.rule.insert.text.slice(0, 120)
      : hit.rule.insert.kind === "shorthand" ? "Insert shortcut " + hit.rule.insert.trigger : "List documents " + hit.rule.insert.shortcut;
    const button = document.createElement("button");
    button.className = "primary";
    button.type = "button";
    button.textContent = "Insert";
    button.addEventListener("click", () => window.actle.submitPopover({ index }));
    item.append(label, what, button);
    list.append(item);
  });
  document.getElementById("cancel").addEventListener("click", () => window.actle.closePopover());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
})();
