const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../src/background.js"), "utf8");

for (const browser of ["chrome", "firefox"]) {
  test(`${browser} background seeds first install and updates the badge from its storage area`, async () => {
    const calls = [];
    const listeners = {};
    let shorthands = [];
    let settings = { enabled: true };
    const storage = {
      AREA: browser === "firefox" ? "local" : "sync",
      getAll: async () => ({ shorthands, settings }),
      replaceAll: async (items) => { shorthands = items; },
    };
    const context = {
      chrome: {
        runtime: {
          onInstalled: { addListener: (fn) => { listeners.install = fn; } },
          onStartup: { addListener: (fn) => { listeners.start = fn; } },
          openOptionsPage: () => { calls.push("options"); },
        },
        storage: { onChanged: { addListener: (fn) => { listeners.change = fn; } } },
        action: {
          setBadgeText: async ({ text }) => { calls.push(text); },
          setBadgeBackgroundColor: async () => {},
        },
      },
    };
    context.self = context;
    if (browser === "chrome") {
      context.importScripts = (file) => {
        assert.equal(file, "storage.js");
        context.ShorthandStorage = storage;
      };
    } else {
      // Firefox's background.scripts loads storage first in a window, not a worker.
      context.ShorthandStorage = storage;
    }
    vm.runInNewContext(source, context);
    await listeners.install({ reason: "install" });
    await new Promise(setImmediate);
    assert.equal(shorthands.length, 3);
    assert.equal(shorthands[0].trigger, "cool/");
    assert.deepEqual(calls, ["options", ""]);

    settings = { enabled: false };
    calls.length = 0;
    listeners.change({ settings: {} }, storage.AREA);
    await new Promise(setImmediate);
    assert.deepEqual(calls, ["off"]);

    calls.length = 0;
    listeners.change({ settings: {} }, storage.AREA === "local" ? "sync" : "local");
    await new Promise(setImmediate);
    assert.deepEqual(calls, []);
    await listeners.start();
    assert.deepEqual(calls, ["off"]);

    shorthands = [{ trigger: "mine/", expansion: "Keep this" }];
    await listeners.install({ reason: "update" });
    assert.equal(shorthands[0].trigger, "mine/");
    assert.equal(calls.includes("options"), false);
  });
}
