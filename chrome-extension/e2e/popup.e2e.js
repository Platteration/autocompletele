const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

test("toolbar palette searches, copies text, and pauses expansion", async (t) => {
  const app = await launch({ shorthands: [
    { trigger: "addr/", expansion: "123 Example Street" },
    { trigger: "ty/", expansion: "Thank you!" },
  ] });
  t.after(() => app.close());
  const popup = await app.context.newPage();
  popup.on("pageerror", (e) => app.errors.push(String(e)));
  await popup.goto(`chrome-extension://${app.extensionId}/src/popup.html`);
  await popup.waitForSelector(".result");

  await popup.fill("#search", "example");
  assert.deepEqual(await popup.locator(".result .trigger").allTextContents(), ["addr/"]);
  await popup.locator(".result").click();
  await popup.waitForFunction(() => document.getElementById("toast").textContent === "Copied addr/");
  await app.page.bringToFront();
  await app.page.click("#inp");
  await app.page.keyboard.press("Control+v");
  assert.equal(await app.page.inputValue("#inp"), "123 Example Street");

  await popup.bringToFront();
  await popup.locator("#enabled").uncheck();
  await popup.waitForFunction(() => document.getElementById("status").textContent === "Paused");
  assert.equal(await app.worker.evaluate(async () => (await self.ShorthandStorage.getAll()).settings.enabled), false);
  await app.page.fill("#inp", "");
  await app.page.keyboard.type("ty/");
  assert.equal(await app.page.inputValue("#inp"), "ty/");
  assert.deepEqual(app.errors, []);
});
