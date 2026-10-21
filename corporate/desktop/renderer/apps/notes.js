// actle Notes: dashboard tab (stub). Registers a renderer for the "notes" section.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  window.actleApps.notes = {
    async render(section, helpers) {
      const info = await helpers.api.invoke("notes:info");
      section.textContent = "";
      section.append(helpers.el("p", { class: "hint", text: "actle Notes is work in progress. Policy section loaded: " + (info && info.policy ? "yes" : "no") + "." }));
    },
  };
})();
