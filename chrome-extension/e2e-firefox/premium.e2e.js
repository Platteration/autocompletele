const test = require("node:test");
const path = require("node:path");
const { launch, Key, By } = require("./helper.js");
const { LIBRARY, configuredPackage, runPreviewCases, runEnforcedCases, seedState,
  inspectNotice, fabricateDismiss } = require("../e2e/premium-cases.js");

async function adapter(app) {
  const { driver } = app;
  await app.openOptions();
  await driver.executeScript((items) => self.ShorthandStorage.replaceAll(items), LIBRARY);
  await app.settings({ animationMode: "off" });
  const keys = { ArrowDown: Key.ARROW_DOWN, Enter: Key.ENTER, Escape: Key.ESCAPE,
    Tab: Key.TAB, Backspace: Key.BACK_SPACE };
  const fixtureURL = await (async () => { await app.openFixture(); return driver.getCurrentUrl(); })();
  async function privileged(fn, arg) {
    const handle = await driver.getWindowHandle();
    try {
      await driver.switchTo().window(app.optionsHandle);
      return await driver.executeScript(fn, arg);
    } finally { await driver.switchTo().window(handle); }
  }
  return {
    evaluate: (fn, arg) => driver.executeScript(fn, arg),
    pause: (ms) => driver.sleep(ms),
    fixture: (file) => app.openFixture(file),
    options: () => app.openOptions(),
    popup: async () => {
      await driver.switchTo().newWindow("tab");
      await driver.get(`${app.extensionURL}/src/popup.html`);
    },
    reload: () => driver.navigate().refresh(),
    click: async (selector) => (await app.element(selector)).click(),
    fill: (selector, text) => app.fill(selector, text),
    type: (text) => driver.actions().sendKeys(text).perform(),
    key: (key) => driver.actions().sendKeys(keys[key] || key).perform(),
    pointer: (x, y) => driver.actions().move({ x: Math.round(x), y: Math.round(y), origin: "viewport" }).click().perform(),
    value: (selector) => driver.executeScript((selector) => {
      const field = document.querySelector(selector);
      return "value" in field ? field.value : field.textContent;
    }, selector),
    text: (selector) => driver.executeScript((selector) => document.querySelector(selector).textContent, selector),
    status: () => privileged(() => self.ActlePremium.status()),
    seed: (patch) => privileged(seedState, patch),
    template: async () => {
      const root = await (await app.element("#shorthand-template-host")).getShadowRoot();
      const panel = await root.findElement(By.css(".panel"));
      return driver.executeScript((panel) => ({ error: panel.querySelector('[role="alert"]').textContent,
        answers: [...panel.querySelectorAll("input")].map((input) => input.value) }), panel);
    },
    notice: async () => {
      const root = await (await app.element("#actle-usage-notice")).getShadowRoot();
      return driver.executeScript(`return (${inspectNotice.toString()}).call(arguments[0]);`,
        await root.findElement(By.css(".notice")));
    },
    fakeNoticeDismiss: async () => {
      const root = await (await app.element("#actle-usage-notice")).getShadowRoot();
      return driver.executeScript(`return (${fabricateDismiss.toString()}).call(arguments[0]);`,
        await root.findElement(By.css(".notice")));
    },
    twoTabAttempts: async () => {
      await app.openFixture();
      await driver.sleep(150);
      await (await app.element("#inp")).sendKeys("cool");
      await driver.switchTo().newWindow("tab");
      const second = await driver.getWindowHandle();
      try {
        await driver.get(fixtureURL);
        await driver.sleep(150);
        await (await app.element("#inp")).sendKeys("cool");
        // WebDriver has one active browsing context. Actual trusted actions
        // therefore run in each tab in turn; concurrent reservation races are
        // additionally exercised by Chrome and the accounting unit tests.
        const outcomes = [];
        for (const handle of [app.fixtureHandle, second]) {
          await driver.switchTo().window(handle);
          await (await app.element("#inp")).sendKeys("/");
          await driver.wait(async () => driver.executeScript(() =>
            document.querySelector("#inp").value === "You got it." || !!document.querySelector("#actle-usage-notice")), 5000);
          outcomes.push(await app.value("#inp"));
        }
        return outcomes;
      } finally {
        await driver.switchTo().window(second);
        await driver.close();
        await driver.switchTo().window(app.fixtureHandle);
      }
    },
  };
}

test("premium preview and configured lifetime licenses in Firefox", { timeout: 180000 }, async (t) => {
  const preview = await launch();
  try { await runPreviewCases(t, await adapter(preview)); }
  finally { await preview.close(); }

  const configured = await configuredPackage(path.join(__dirname, "..", "dist", "firefox"));
  t.after(configured.close);
  const app = await launch({ extensionPath: configured.extensionPath });
  t.after(() => app.close());
  await runEnforcedCases(t, await adapter(app), configured.tokens);
});
