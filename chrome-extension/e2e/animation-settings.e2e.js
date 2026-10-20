const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

test("animation preferences save visibly and retain the library", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const legacySettings = { enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", retained: "keep" };
  await app.worker.evaluate((settings) => chrome.storage.sync.set({ settings }), legacySettings);
  const original = await app.worker.evaluate(() => chrome.storage.sync.get(null));
  const page = await app.context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  await page.waitForSelector("#list tbody tr");
  assert.equal(await page.getByLabel("Text animation", { exact: true }).count(), 1);

  await t.test("legacy preferences show Expand with accessible help without rewriting storage", async () => {
    assert.equal(await page.inputValue("#animationMode"), "expand");
    assert.deepEqual(await page.locator("#animationMode option").evaluateAll((options) =>
      options.map((option) => [option.value, option.textContent])), [
      ["expand", "Expand"], ["casino", "Casino"], ["off", "Off — instant"],
    ]);
    assert.equal(await page.locator("#animationMode").getAttribute("aria-describedby"), "animationHint animationMsg");
    assert.equal(await page.locator("#animationMsg").getAttribute("role"), "status");
    assert.match(await page.textContent("#animationHint"), /Reduced motion skips animation/);
    assert.equal(await page.locator("#animationHint a").getAttribute("href"), "#playground");
    assert.equal(await page.locator("#playground").count(), 1);
    assert.deepEqual(await app.worker.evaluate(() => chrome.storage.sync.get(null)), original);
  });

  await t.test("all choices save immediately and survive reload without altering other data", async () => {
    for (const [mode, label] of [["casino", "Casino"], ["off", "Off — instant"], ["expand", "Expand"]]) {
      await page.locator("#animationMode").focus();
      await page.selectOption("#animationMode", mode);
      await page.waitForFunction((label) => document.getElementById("animationMsg").textContent ===
        `Animation saved: ${label}.`, label);
      assert.equal(await page.locator("#animationMode").isEnabled(), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), "animationMode");
      assert.deepEqual(await app.worker.evaluate(() => chrome.storage.sync.get(null)), {
        ...original, settings: { ...legacySettings, animationMode: mode, suggestionsEnabled: true, phraseWords: 3 },
      });
      await page.reload();
      await page.waitForFunction((mode) => document.getElementById("animationMode").value === mode, mode);
    }
  });

  await t.test("unknown saved modes display Expand without replacing the stored preference", async () => {
    await app.worker.evaluate((settings) => chrome.storage.sync.set({
      settings: { ...settings, animationMode: "unsupported" },
    }), legacySettings);
    await page.reload();
    await page.waitForSelector("#list tbody tr");
    assert.equal(await page.inputValue("#animationMode"), "expand");
    assert.equal(await app.worker.evaluate(async () =>
      (await chrome.storage.sync.get("settings")).settings.animationMode), "unsupported");
  });

  await t.test("a rejected save restores the saved choice with a visible error and leaves all data intact", async () => {
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ animationMode: "casino" }));
    await page.waitForFunction(() => document.getElementById("animationMode").value === "casino");
    const before = await app.worker.evaluate(() => chrome.storage.sync.get(null));
    // Delay then reject only this page's settings call to inspect pending/error
    // UI. Successful cases above use the browser's real storage API.
    await page.evaluate(() => {
      self.ShorthandStorage.saveSettings = () => new Promise((_resolve, reject) => {
        self.rejectAnimationSave = () => reject(new Error("Test storage write rejected"));
      });
    });
    await page.locator("#animationMode").focus();
    await page.selectOption("#animationMode", "off");
    assert.equal(await page.locator("#animationMode").isDisabled(), true);
    assert.equal(await page.textContent("#animationMsg"), "Saving animation…");
    await page.evaluate(() => self.rejectAnimationSave());
    await page.waitForFunction(() => document.getElementById("animationMsg").classList.contains("error"));
    assert.equal(await page.inputValue("#animationMode"), "casino");
    assert.equal(await page.locator("#animationMode").isEnabled(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "animationMode");
    assert.equal(await page.textContent("#animationMsg"),
      "Could not save animation: Test storage write rejected. Previous style kept.");
    assert.deepEqual(await app.worker.evaluate(() => chrome.storage.sync.get(null)), before);
    await page.selectOption("#animationMode", "off");
    await page.locator("#pickerTrigger").focus();
    await page.evaluate(() => self.rejectAnimationSave());
    await page.waitForFunction(() => !document.getElementById("animationMode").disabled);
    assert.equal(await page.evaluate(() => document.activeElement.id), "pickerTrigger",
      "Finishing a save must not steal focus from another control");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("animationMode").value === "casino");
    assert.deepEqual(errors, []);
  });
});
