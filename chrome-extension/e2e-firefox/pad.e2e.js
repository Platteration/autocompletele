const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

test("Firefox: the Writing pad saves a draft locally and keeps it after a reload", { timeout: 120000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver, element, value, waitValue } = app;
  const ready = () => driver.wait(() => driver.executeScript(
    "return !document.getElementById('suggestToggle').disabled"
  ), 10000, "The pad must finish loading its drafts");
  const saved = () => driver.wait(async () => /^Saved\b/.test(await driver.executeScript(
    "return document.getElementById('padSave').textContent"
  )), 5000, "The draft must save");

  await driver.switchTo().window(app.optionsHandle);
  await driver.get(`${app.extensionURL}/src/pad.html`);
  await ready();
  assert.equal(await driver.getTitle(), "Writing pad · actle");

  await (await element("#padBody")).sendKeys("Dear Sam, cool/");
  await waitValue("#padBody", "Dear Sam, That is really cool!");
  await saved();

  await driver.navigate().refresh();
  await ready();
  assert.equal(await value("#padBody"), "Dear Sam, That is really cool!");
  const local = await driver.executeScript("return chrome.storage.local.get(null)");
  const drafts = Object.entries(local).filter(([key]) => key.startsWith("pad-draft:")).map(([, draft]) => draft.body);
  assert.deepEqual(drafts, ["Dear Sam, That is really cool!"]);
  assert.deepEqual(await driver.executeScript("return chrome.storage.sync.get(null)"), {});
  assert.equal(await driver.executeScript(
    "return self.ShorthandStorage.isLibraryChange({ 'pad-draft:x': {} }, 'local')"
  ), false, "a draft save is not a library change in Firefox's local storage");
});
