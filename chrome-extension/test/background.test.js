const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../src/background.js"), "utf8");

for (const browser of ["chrome", "firefox"]) {
  test(`${browser} background seeds first install and updates the badge from its storage area`, async () => {
    const calls = [];
    const menus = [];
    let draft = "";
    const listeners = {};
    let shorthands = [];
    let settings = { enabled: true };
    const storage = {
      AREA: browser === "firefox" ? "local" : "sync",
      getAll: async () => ({ shorthands, settings }),
      replaceAll: async (items) => { shorthands = items; },
      savePendingDraft: async (text) => { draft = text; return true; },
    };
    const context = {
      URL,
      chrome: {
        runtime: {
          id: "actle-test",
          getURL: (path) => `chrome-extension://actle-test/${path}`,
          onMessage: { addListener: (fn) => { listeners.message = fn; } },
          onInstalled: { addListener: (fn) => { listeners.install = fn; } },
          onStartup: { addListener: (fn) => { listeners.start = fn; } },
          openOptionsPage: () => { calls.push("options"); },
        },
        storage: { local: { get: async () => ({}) }, onChanged: { addListener: (fn) => { listeners.change = fn; } } },
        contextMenus: {
          create: (props, callback) => { menus.push(props); if (callback) callback(); },
          onClicked: { addListener: (fn) => { listeners.menuClick = fn; } },
        },
        action: {
          setBadgeText: async ({ text }) => { calls.push(text); },
          setBadgeBackgroundColor: async () => {},
        },
      },
    };
    context.self = context;
    vm.createContext(context);
    const dependencies = ["storage.js", "premium-config.js", "license.js", "premium-service.js"];
    const loadDependency = (file) => {
      if (file === "storage.js") context.ShorthandStorage = storage;
      else vm.runInContext(fs.readFileSync(require.resolve(`../src/${file}`), "utf8"), context);
    };
    if (browser === "chrome") {
      context.importScripts = (...files) => {
        assert.deepEqual(files, dependencies);
        files.forEach(loadDependency);
      };
    } else {
      // Firefox's background.scripts loads dependencies in a window, not a worker.
      dependencies.forEach(loadDependency);
    }
    vm.runInContext(source, context);
    const premiumStatus = await new Promise((resolve) => {
      assert.equal(listeners.message({ type: "actle-premium", action: "status" }, { id: "actle-test" }, resolve), true);
    });
    assert.equal(premiumStatus.ok, true);
    assert.equal(premiumStatus.result.enforced, false);
    assert.equal(premiumStatus.result.usedToday, 0);
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

    assert.ok(menus.length >= 1 && menus.every((menu) => menu.id === "actle-save-selection"
      && menu.title === "Save selection as actle shorthand" && menu.contexts[0] === "selection"));
    calls.length = 0;
    await listeners.menuClick({ menuItemId: "actle-save-selection", selectionText: "Selected on a page" }, {});
    assert.equal(draft, "Selected on a page");
    assert.deepEqual(calls, ["options"]);
    draft = ""; calls.length = 0;
    await listeners.menuClick({ menuItemId: "other-menu", selectionText: "Not ours" }, {});
    await listeners.menuClick({ menuItemId: "actle-save-selection", selectionText: "" }, {});
    assert.equal(draft, "");
    assert.deepEqual(calls, []);
  });
}
