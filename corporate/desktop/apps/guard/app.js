// actle Guard: desktop app module (stub). Replaced by the app's real shell
// integration; see desktop/apps/index.js for the shape.
"use strict";

function createApp(host) {
  return {
    id: "guard",
    title: "Guard",
    tab: true,
    ipc: {
      "guard:info": () => ({ id: "guard", wip: true, policy: host.policy().guard }),
    },
  };
}

module.exports = { createApp };
