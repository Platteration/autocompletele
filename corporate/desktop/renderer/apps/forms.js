// actle Forms: dashboard tab (stub). Registers a renderer for the "forms" section.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  window.actleApps.forms = {
    async render(section, helpers) {
      const info = await helpers.api.invoke("forms:info");
      section.textContent = "";
      section.append(helpers.el("p", { class: "hint", text: "actle Forms is work in progress. Policy section loaded: " + (info && info.policy ? "yes" : "no") + "." }));
    },
  };
})();
