const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, FIXTURE, EXTENSION_DIR } = require("./helper.js");
const { LIBRARY, configuredPackage, runPreviewCases, runEnforcedCases, seedState,
  inspectNotice, fabricateDismiss } = require("./premium-cases.js");

async function adapter(app) {
  const options = await app.context.newPage();
  await options.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  let current = app.page;
  const fixture = async (file = "page.html") => {
    current = app.page;
    await current.goto(FIXTURE.replace(/page\.html$/, file));
    await current.bringToFront();
  };
  async function inspectShadow(hostId, fn) {
    const client = await current.context().newCDPSession(current);
    try {
      const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
      function find(node) {
        const attrs = node.attributes || [];
        if (attrs.some((item, i) => i % 2 === 0 && item === "id" && attrs[i + 1] === hostId)) return node;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
          const result = find(child); if (result) return result;
        }
      }
      const host = find(root);
      assert.ok(host && host.shadowRoots.length === 1);
      const { object } = await client.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId });
      const result = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: fn.toString(),
      });
      assert.equal(result.exceptionDetails, undefined);
      return result.result.value;
    } finally { await client.detach(); }
  }
  return {
    evaluate: (fn, arg) => current.evaluate(fn, arg),
    pause: (ms) => current.waitForTimeout(ms),
    fixture,
    options: async () => {
      current = options;
      await current.goto(`chrome-extension://${app.extensionId}/src/options.html`);
      await current.bringToFront();
    },
    popup: async () => {
      current = await app.context.newPage();
      await current.goto(`chrome-extension://${app.extensionId}/src/popup.html`);
      await current.bringToFront();
    },
    reload: () => current.reload(),
    click: (selector) => current.click(selector),
    fill: (selector, text) => current.fill(selector, text),
    type: (text) => current.keyboard.type(text),
    key: (key) => current.keyboard.press(key),
    pointer: (x, y) => current.mouse.click(x, y),
    value: (selector) => current.evaluate((selector) => {
      const field = document.querySelector(selector);
      return "value" in field ? field.value : field.textContent;
    }, selector),
    text: (selector) => current.textContent(selector),
    status: () => options.evaluate(() => self.ActlePremium.status()),
    seed: (patch) => options.evaluate(seedState, patch),
    template: () => inspectShadow("shorthand-template-host", function () {
      return { error: this.querySelector('[role="alert"]').textContent,
        answers: [...this.querySelectorAll("input")].map((input) => input.value) };
    }),
    notice: () => inspectShadow("actle-usage-notice", inspectNotice),
    fakeNoticeDismiss: () => inspectShadow("actle-usage-notice", fabricateDismiss),
    delayedClaim: async (change) => {
      await options.evaluate(seedState, { used: 99 });
      await fixture();
      await current.waitForTimeout(150);
      // A privileged browser-test hook pauses only the real background's next
      // receipt write. No client response or approval is fabricated, and the
      // unchanged production code must recheck the page when that write ends.
      await app.worker.evaluate(() => {
        const original = chrome.storage.local.set.bind(chrome.storage.local);
        self.premiumTestHeld = false;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        self.premiumTestRelease = () => {
          chrome.storage.local.set = original;
          release();
        };
        chrome.storage.local.set = async (items) => {
          const state = items["actle-premium"];
          if (!self.premiumTestHeld && state && Object.keys(state.pending).length) {
            self.premiumTestHeld = true;
            await gate;
          }
          return original(items);
        };
      });
      try {
        await current.click("#inp");
        await current.keyboard.type("cool/");
        for (let attempt = 0; attempt < 80 && !await app.worker.evaluate(() => self.premiumTestHeld); attempt++) {
          await current.waitForTimeout(50);
        }
        assert.equal(await app.worker.evaluate(() => self.premiumTestHeld), true, "Hold the actual pending receipt write");
        if (change === "paused") {
          await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ enabled: false }));
        } else {
          await current.evaluate((change) => {
            const field = document.querySelector("#inp");
            if (change === "value") field.value = "Newer draft";
            else field.autocomplete = "username";
          }, change);
        }
      } finally { await app.worker.evaluate(() => self.premiumTestRelease()); }
      try {
        await options.waitForFunction(async () => (await self.ActlePremium.status()).usedToday === 99);
        assert.equal(await current.inputValue("#inp"), change === "value" ? "Newer draft" : "cool/");
        assert.deepEqual(await options.evaluate(async () =>
          (await chrome.storage.local.get("actle-premium"))["actle-premium"].pending), {});
      } finally {
        if (change === "paused") await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ enabled: true }));
      }
    },
    twoTabAttempts: async () => {
      const pages = [app.page, await app.context.newPage()];
      try {
        for (const page of pages) {
          await page.goto(FIXTURE);
          await page.waitForTimeout(150);
          await page.click("#inp");
          await page.keyboard.type("cool");
        }
        // Distinct page targets deliver trusted input concurrently. The real
        // service worker must serialize the final remaining reservation.
        await Promise.all(pages.map((page) => page.keyboard.type("/")));
        await options.waitForFunction(async () => (await self.ActlePremium.status()).usedToday === 100);
        await pages[0].waitForTimeout(150);
        return Promise.all(pages.map((page) => page.inputValue("#inp")));
      } finally {
        await pages[1].close();
        current = app.page;
      }
    },
  };
}

test("premium preview and configured lifetime licenses in Chrome", { timeout: 180000 }, async (t) => {
  const preview = await launch({ shorthands: LIBRARY, settings: { animationMode: "off" } });
  try {
    await runPreviewCases(t, await adapter(preview));
    assert.deepEqual(preview.errors, []);
  } finally { await preview.close(); }

  const configured = await configuredPackage(EXTENSION_DIR);
  t.after(configured.close);
  const app = await launch({ extensionPath: configured.extensionPath,
    shorthands: LIBRARY, settings: { animationMode: "off" } });
  t.after(() => app.close());
  await runEnforcedCases(t, await adapter(app), configured.tokens);
  assert.deepEqual(app.errors, []);
});

test("a page left open when actle reloads keeps expanding without a usage notice", { timeout: 60000 }, async (t) => {
  // Chrome does not re-inject content scripts after an update or reload; the
  // script already in an open page stays but can no longer reach the background.
  const app = await launch({ settings: { animationMode: "off" } });
  t.after(() => app.close());
  const { page } = app;
  await page.click("#inp");
  await page.keyboard.type("cool/");
  assert.equal(await page.inputValue("#inp"), "That is really cool!");
  await app.worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await page.waitForTimeout(1000);
  await page.fill("#inp", "");
  await page.click("#inp");
  await page.keyboard.type("brb/");
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue("#inp"), "be right back");
  assert.equal(await page.evaluate(() => !!document.getElementById("actle-usage-notice")), false);
});
