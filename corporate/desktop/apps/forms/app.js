// actle Forms: desktop app module (stub). Replaced by the app's real shell
// integration; see desktop/apps/index.js for the shape.
"use strict";

function createApp(host) {
  return {
    id: "forms",
    title: "Forms",
    tab: true,
    ipc: {
      "forms:info": () => ({ id: "forms", wip: true, policy: host.policy().forms }),
    },
  };
}

module.exports = { createApp };
