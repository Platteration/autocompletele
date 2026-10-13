const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, By } = require("./helper.js");

test("Firefox animation preferences save visibly and retain local data", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver } = app;
  await app.openOptions();
  const legacySettings = { enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", retained: "keep" };
  await driver.executeScript((settings) => chrome.storage.local.set({ settings }), legacySettings);
  const original = await driver.executeScript("return chrome.storage.local.get(null)");
  await driver.navigate().refresh();
  await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length > 0, 5000);
  assert.equal((await driver.findElements(By.css("label[for='animationMode']"))).length, 1);

  async function choose(mode) {
    await driver.findElement(By.css(`#animationMode option[value='${mode}']`)).click();
  }

  await t.test("legacy preferences show Expand and accessible help without rewriting storage", async () => {
    assert.equal(await app.value("#animationMode"), "expand");
    assert.equal(await app.text("label[for='animationMode']"), "Text animation");
    assert.deepEqual(await driver.executeScript(() => [...document.querySelectorAll("#animationMode option")]
      .map((option) => [option.value, option.textContent])), [
      ["expand", "Expand"], ["casino", "Casino"], ["off", "Off — instant"],
    ]);
    assert.equal(await (await app.element("#animationMode")).getAttribute("aria-describedby"), "animationHint animationMsg");
    assert.equal(await (await app.element("#animationMsg")).getAttribute("role"), "status");
    assert.match(await app.text("#animationHint"), /Reduced motion skips animation/);
    assert.equal(await driver.executeScript("return document.querySelector('#animationHint a').getAttribute('href')"), "#playground");
    assert.equal((await driver.findElements(By.css("#playground"))).length, 1);
    assert.deepEqual(await driver.executeScript("return chrome.storage.local.get(null)"), original);
  });

  await t.test("all choices save immediately and survive reload without altering other data", async () => {
    for (const [mode, label] of [["casino", "Casino"], ["off", "Off — instant"], ["expand", "Expand"]]) {
      await choose(mode);
      await driver.wait(async () => await app.text("#animationMsg") === `Animation saved: ${label}.`, 5000);
      assert.equal(await (await app.element("#animationMode")).isEnabled(), true);
      assert.equal(await driver.executeScript("return document.activeElement.id"), "animationMode");
      assert.deepEqual(await driver.executeScript("return chrome.storage.local.get(null)"), {
        ...original, settings: { ...legacySettings, animationMode: mode, suggestionsEnabled: true },
      });
      await driver.navigate().refresh();
      await app.waitValue("#animationMode", mode);
    }
    assert.deepEqual(await driver.executeScript("return chrome.storage.sync.get(null)"), {});
  });

  await t.test("unknown saved modes display Expand without rewriting the stored preference", async () => {
    await driver.executeScript((settings) => chrome.storage.local.set({
      settings: { ...settings, animationMode: "unsupported" },
    }), legacySettings);
    await driver.navigate().refresh();
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length > 0, 5000);
    assert.equal(await app.value("#animationMode"), "expand");
    assert.equal((await driver.executeScript("return chrome.storage.local.get('settings')")).settings.animationMode, "unsupported");
  });

  await t.test("a rejected save restores the saved choice with a visible error and leaves all data intact", async () => {
    await driver.executeScript(() => self.ShorthandStorage.saveSettings({ animationMode: "casino" }));
    await app.waitValue("#animationMode", "casino");
    const before = await driver.executeScript("return chrome.storage.local.get(null)");
    // Only the rejected response is simulated; successful writes and subsequent
    // reloads above exercise actual Firefox extension local storage.
    await driver.executeScript(() => {
      self.ShorthandStorage.saveSettings = () => new Promise((_resolve, reject) => {
        self.rejectAnimationSave = () => reject(new Error("Test storage write rejected"));
      });
    });
    await choose("off");
    assert.equal(await (await app.element("#animationMode")).isEnabled(), false);
    assert.equal(await app.text("#animationMsg"), "Saving animation…");
    await driver.executeScript("self.rejectAnimationSave()");
    await driver.wait(() => driver.executeScript("return document.getElementById('animationMsg').classList.contains('error')"), 5000);
    assert.equal(await app.value("#animationMode"), "casino");
    assert.equal(await (await app.element("#animationMode")).isEnabled(), true);
    assert.equal(await driver.executeScript("return document.activeElement.id"), "animationMode");
    assert.equal(await app.text("#animationMsg"),
      "Could not save animation: Test storage write rejected. Previous style kept.");
    assert.deepEqual(await driver.executeScript("return chrome.storage.local.get(null)"), before);
    await choose("off");
    await (await app.element("#pickerTrigger")).click();
    await driver.executeScript("self.rejectAnimationSave()");
    await driver.wait(async () => await (await app.element("#animationMode")).isEnabled(), 5000);
    assert.equal(await driver.executeScript("return document.activeElement.id"), "pickerTrigger",
      "Finishing a save must not steal focus from another control");
    await driver.navigate().refresh();
    await app.waitValue("#animationMode", "casino");
  });
});
