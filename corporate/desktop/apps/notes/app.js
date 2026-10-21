// actle Notes: desktop app module (stub). Replaced by the app's real shell
// integration; see desktop/apps/index.js for the shape.
"use strict";

function createApp(host) {
  return {
    id: "notes",
    title: "Notes",
    tab: true,
    ipc: {
      "notes:info": () => ({ id: "notes", wip: true, policy: host.policy().notes }),
    },
  };
}

module.exports = { createApp };
