// actle Sheets: desktop app module (stub). Replaced by the app's real shell
// integration; see desktop/apps/index.js for the shape.
"use strict";

function createApp(host) {
  return {
    id: "sheets",
    title: "Sheets",
    tab: true,
    ipc: {
      "sheets:info": () => ({ id: "sheets", wip: true, policy: host.policy().sheets }),
    },
  };
}

module.exports = { createApp };
