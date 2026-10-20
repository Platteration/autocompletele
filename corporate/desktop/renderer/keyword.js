// A keyword rule matched what the person is writing: offer its insert, or
// show a compliance warning with an optional fix.
"use strict";

(async function () {
  const state = await window.actle.getPopover();
  if (!state || state.kind !== "keyword") return window.actle.closePopover();
  if (state.warning) {
    document.getElementById("heading").textContent = "Before you send";
    document.title = "Warning";
  }
  const list = document.getElementById("list");
  const describe = (insert) => insert.kind === "text" ? insert.text.slice(0, 120)
    : insert.kind === "shorthand" ? "Insert shortcut " + insert.trigger : "List documents " + insert.shortcut;
  state.hits.forEach((hit, index) => {
    const warns = hit.rule.action === "warn";
    const item = document.createElement("li");
    if (warns) item.className = "warning";
    const label = document.createElement("div");
    label.textContent = warns ? hit.rule.message : hit.rule.label + " (" + hit.matched.join(", ") + ")";
    item.append(label);
    if (hit.rule.insert) {
      const what = document.createElement("div");
      what.className = "path";
      what.textContent = describe(hit.rule.insert);
      const button = document.createElement("button");
      button.className = "primary";
      button.type = "button";
      button.textContent = warns ? "Insert fix" : "Insert";
      button.addEventListener("click", () => window.actle.submitPopover({ index }));
      item.append(what, button);
    }
    list.append(item);
  });
  document.getElementById("cancel").addEventListener("click", () => window.actle.closePopover());
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") window.actle.closePopover(); });
})();
