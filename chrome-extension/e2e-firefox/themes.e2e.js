const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, Key, By } = require("./helper.js");

test("Firefox style choice saves locally, restyles the library and keeps overlays working", { timeout: 120000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver, element, waitValue } = app;
  await app.openOptions();
  const original = await driver.executeScript("return chrome.storage.local.get(null)");

  await t.test("Classic shows by default without writing settings", async () => {
    assert.equal(await app.value("#theme"), "classic");
    assert.equal(await driver.executeScript("return document.documentElement.dataset.actleTheme"), "classic");
    assert.equal(await driver.executeScript("return getComputedStyle(document.querySelector('.card')).borderTopLeftRadius"), "20px");
    assert.deepEqual(await driver.executeScript("return chrome.storage.local.get(null)"), original);
  });

  await t.test("a chosen style applies at once and survives reload", async () => {
    await driver.findElement(By.css("#theme option[value='swiss']")).click();
    await driver.wait(async () => await app.text("#themeMsg") === "Style saved: Swiss Grid.", 5000);
    assert.equal((await driver.executeScript("return chrome.storage.local.get('settings')")).settings.theme, "swiss");
    assert.deepEqual(await driver.executeScript("return chrome.storage.sync.get(null)"), {});
    await driver.navigate().refresh();
    await app.waitValue("#theme", "swiss");
    assert.equal(await driver.executeScript("return document.documentElement.dataset.actleTheme"), "swiss");
    assert.equal(await driver.executeScript("return getComputedStyle(document.querySelector('.card')).borderTopLeftRadius"), "0px");
  });

  await t.test("the picker opens and inserts under a strict page CSP with a non-Classic style", async () => {
    await app.openFixture("strict-csp.html");
    await driver.executeScript("window.violations=[]; document.addEventListener('securitypolicyviolation', e=>window.violations.push(e.violatedDirective))");
    // The content script reads settings after load; an expansion shows it is ready.
    await (await element("#inp")).sendKeys("brb/");
    await waitValue("#inp", "be right back");
    await (await element("#inp")).sendKeys(" ;;");
    await driver.wait(() => driver.executeScript("return !!document.getElementById('shorthand-picker-host')"), 5000);
    const box = await driver.executeScript(() => {
      const host = document.getElementById("shorthand-picker-host");
      return { position: getComputedStyle(host).position, width: host.getBoundingClientRect().width };
    });
    assert.equal(box.position, "fixed", "the overlay's own sheet must still apply next to the shared style sheet");
    // Classic draws a 1px frame around the 340px panel; Swiss Grid's shared sheet draws 2px.
    assert.ok(box.width >= 343.5 && box.width <= 344.5, `Swiss Grid must restyle the open picker: ${JSON.stringify(box)}`);
    await (await element("#inp")).sendKeys("cool");
    await (await element("#inp")).sendKeys(Key.ENTER);
    await waitValue("#inp", "be right back That is really cool!");
    assert.deepEqual(await driver.executeScript("return window.violations"), []);
  });
});
