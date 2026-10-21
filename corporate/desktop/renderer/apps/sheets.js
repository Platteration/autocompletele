// actle Sheets: dashboard tab (stub). Registers a renderer for the "sheets" section.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  window.actleApps.sheets = {
    async render(section, helpers) {
      const info = await helpers.api.invoke("sheets:info");
      section.textContent = "";
      section.append(helpers.el("p", { class: "hint", text: "actle Sheets is work in progress. Policy section loaded: " + (info && info.policy ? "yes" : "no") + "." }));
    },
  };
})();
