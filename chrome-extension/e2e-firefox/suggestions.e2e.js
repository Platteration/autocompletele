const test = require("node:test");
const { launch, Key, By } = require("./helper.js");
const { HOST, LIBRARY, inspectMenu, runCases } = require("../e2e/suggestion-cases.js");

test("saved shortcut suggestions and protected fields in Firefox", { timeout: 180000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver } = app;
  await app.openOptions();
  await driver.executeScript((items) => self.ShorthandStorage.replaceAll(items), LIBRARY);
  await app.settings({ animationMode: "off" });
  const keys = { ArrowDown: Key.ARROW_DOWN, Enter: Key.ENTER, Escape: Key.ESCAPE,
    Tab: Key.TAB, Backspace: Key.BACK_SPACE };
  async function inMenu(fn) {
    const root = await (await app.element(HOST)).getShadowRoot();
    const panel = await root.findElement(By.css(".panel"));
    return driver.executeScript(`return (${fn.toString()}).call(arguments[0]);`, panel);
  }
  await runCases(t, {
    evaluate: (fn, arg) => driver.executeScript(fn, arg),
    pause: (ms) => driver.sleep(ms),
    fixture: (file = "page.html") => app.openFixture(file),
    options: () => app.openOptions(),
    reload: () => driver.navigate().refresh(),
    click: async (selector) => (await app.element(selector)).click(),
    type: (text) => driver.actions().sendKeys(text).perform(),
    key: (key) => driver.actions().sendKeys(keys[key] || key).perform(),
    pointer: (x, y) => driver.actions().move({ x: Math.round(x), y: Math.round(y), origin: "viewport" }).click().perform(),
    settings: (patch) => app.settings(patch),
    menu: () => inMenu(inspectMenu),
    fabricatedPick: () => inMenu(function () {
      const row = this.getRootNode().querySelector(".item");
      for (const type of ["mousedown", "click"]) row.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, button: 0 }));
    }),
  });
});
