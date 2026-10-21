// actle Reply: dashboard tab (stub). Registers a renderer for the "reply" section.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  window.actleApps.reply = {
    async render(section, helpers) {
      const info = await helpers.api.invoke("reply:info");
      section.textContent = "";
      section.append(helpers.el("p", { class: "hint", text: "actle Reply is work in progress. Policy section loaded: " + (info && info.policy ? "yes" : "no") + "." }));
    },
  };
})();
