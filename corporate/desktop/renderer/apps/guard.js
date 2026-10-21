// actle Guard: dashboard tab (stub). Registers a renderer for the "guard" section.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  window.actleApps.guard = {
    async render(section, helpers) {
      const info = await helpers.api.invoke("guard:info");
      section.textContent = "";
      section.append(helpers.el("p", { class: "hint", text: "actle Guard is work in progress. Policy section loaded: " + (info && info.policy ? "yes" : "no") + "." }));
    },
  };
})();
