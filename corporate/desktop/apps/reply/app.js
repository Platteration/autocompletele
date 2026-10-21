// actle Reply: desktop app module (stub). Replaced by the app's real shell
// integration; see desktop/apps/index.js for the shape.
"use strict";

function createApp(host) {
  return {
    id: "reply",
    title: "Reply",
    tab: true,
    ipc: {
      "reply:info": () => ({ id: "reply", wip: true, policy: host.policy().reply }),
    },
  };
}

module.exports = { createApp };
