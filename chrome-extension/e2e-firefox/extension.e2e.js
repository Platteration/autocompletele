const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launch, Key, By, until, DEFAULT_SHORTHANDS } = require("./helper.js");

test("Firefox: real temporary add-on and browser UI", { timeout: 120000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver, element, fill, value, text, waitValue } = app;
  const click = async (selector) => (await element(selector)).click();
  const keys = async (selector, ...keys) => (await element(selector)).sendKeys(...keys);
  const pickerVisible = () => driver.executeScript(
    "return !!document.getElementById('shorthand-picker-host')");
  const row = (trigger) => driver.findElement(By.xpath(
    `//table[@id='list']//tr[td[@class='trigger' and text()='${trigger}']]`));

  await t.test("installs the actual Firefox manifest and seeds only local storage", async () => {
    assert.equal(app.installed.id, app.id);
    assert.deepEqual(app.initialData.shorthands.map((s) => s.trigger), ["cool/", "sig/", "td/"]);
    assert.deepEqual(app.initialSync, {});
    await app.openOptions();
    assert.equal(await driver.executeScript("return self.ShorthandStorage.AREA"), "local");
    const origins = await driver.executeScript("return chrome.permissions.getAll()");
    assert.ok(origins.origins.includes("<all_urls>"));
    await app.openFixture();
  });

  await t.test("expands an input, places the textarea caret, and edits rich text", async () => {
    await keys("#inp", "hey cool/ ok");
    await waitValue("#inp", "hey That is really cool! ok");
    await keys("#ta", "sig/", "X");
    await waitValue("#ta", "Regards,\nX\nAlex");
    await keys("#ce", "a cool/ b");
    assert.equal(await text("#ce"), "a That is really cool! b");
  });

  await t.test("Backspace restores triggers in inputs and rich text", async () => {
    await fill("#inp", "cool/");
    await waitValue("#inp", "That is really cool!");
    await keys("#inp", Key.BACK_SPACE);
    assert.equal(await value("#inp"), "cool/");
    await keys("#inp", Key.BACK_SPACE);
    assert.equal(await value("#inp"), "cool");
    await fill("#ce", "z mid/");
    assert.equal(await text("#ce"), "z abcd");
    await keys("#ce", Key.BACK_SPACE);
    assert.equal(await text("#ce"), "z mid/");
  });

  await t.test("respects word boundaries, password fields, and opt-outs", async () => {
    await fill("#inp", "school/");
    assert.equal(await value("#inp"), "school/");
    await keys("#pw", "cool/");
    assert.equal(await value("#pw"), "cool/");
    await keys("#ign", "cool/");
    assert.equal(await value("#ign"), "cool/");
    await fill("#inp", "td/");
    assert.match(await value("#inp"), /^\d{4}-\d{2}-\d{2}$/);
  });

  await t.test("search intercepts keys without taking focus and supports undo", async () => {
    await fill("#inp", ";;");
    await driver.wait(pickerVisible, 5000);
    await keys("#inp", "brb");
    assert.equal(await value("#inp"), ";;");
    assert.equal(await driver.executeScript("return document.activeElement.id"), "inp");
    await keys("#inp", Key.ENTER);
    await waitValue("#inp", "be right back");
    assert.equal(await pickerVisible(), false);
    await keys("#inp", Key.BACK_SPACE);
    assert.equal(await value("#inp"), ";;");
    await fill("#inp", "hello ;;");
    await driver.wait(pickerVisible, 5000);
    await keys("#inp", Key.ESCAPE);
    assert.equal(await pickerVisible(), false);
    assert.equal(await value("#inp"), "hello ;;");
  });

  await t.test("search inserts in rich text", async () => {
    await fill("#ce", "note ;;");
    await driver.wait(pickerVisible, 5000);
    await keys("#ce", "brb", Key.ENTER);
    assert.equal(await text("#ce"), "note be right back");
  });

  await t.test("works under a strict page CSP", async () => {
    await app.openFixture("strict-csp.html");
    await driver.executeScript("window.violations=[]; document.addEventListener('securitypolicyviolation', e=>window.violations.push(e.violatedDirective))");
    await keys("#inp", "brb/");
    await waitValue("#inp", "be right back");
    await keys("#inp", " ;;");
    await driver.wait(pickerVisible, 5000);
    const box = await driver.executeScript(() => {
      const host = document.getElementById("shorthand-picker-host");
      const rect = host.getBoundingClientRect();
      return { width: rect.width, height: rect.height, position: getComputedStyle(host).position };
    });
    assert.equal(box.position, "fixed", "CSP must not strip the overlay's positioning stylesheet");
    assert.ok(box.width >= 340 && box.width <= 342 && box.height > 50, JSON.stringify(box));
    assert.deepEqual(await driver.executeScript("return window.violations"), []);
    await keys("#inp", Key.ESCAPE);
  });

  await t.test("options add, reject duplicates, edit, and delete persisted snippets", async () => {
    await app.openOptions();
    await fill("#trigger", "ff/");
    await fill("#expansion", "Firefox test");
    await click("#saveBtn");
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 6, 5000);
    await fill("#trigger", "ff/");
    await fill("#expansion", "Duplicate");
    await click("#saveBtn");
    assert.equal(await text("#formMsg"), "That trigger is already used.");
    await (await (await row("ff/")).findElement(By.css("button.secondary"))).click();
    await fill("#expansion", "Firefox persisted");
    await click("#saveBtn");
    await driver.wait(async () => (await row("ff/")).getText().then((s) => s.includes("Firefox persisted")), 5000);
    await driver.navigate().refresh();
    // Navigation completes before the asynchronous stored library is rendered.
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 6, 5000);
    assert.ok((await (await row("ff/")).getText()).includes("Firefox persisted"));
    await (await (await row("ff/")).findElement(By.css("button.danger"))).click();
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 5, 5000);
  });

  await t.test("options search matches expansion text", async () => {
    await fill("#search", "right back");
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 1, 5000);
    assert.equal(await text("td.trigger"), "brb/");
    await fill("#search", "");
  });

  await t.test("exports and safely merges the shared JSON format", async () => {
    await click("#exportBtn");
    const exported = path.join(app.downloads, "shorthands.json");
    await driver.wait(() => fs.existsSync(exported), 10000);
    assert.deepEqual(JSON.parse(fs.readFileSync(exported, "utf8")), { version: 1, shorthands: DEFAULT_SHORTHANDS });
    const imported = path.join(app.temporaryDir, "import.json");
    fs.writeFileSync(imported, JSON.stringify({ version: 1, shorthands: [{ trigger: "new/", expansion: "Imported in Firefox" }] }));
    await keys("#importFile", imported);
    await driver.wait(until.elementIsVisible(await element("#importPreview")), 5000);
    assert.equal(await text("#addCount"), "1");
    await click("#mergeBtn");
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 6, 5000);
    const data = await driver.executeScript("return self.ShorthandStorage.getAll()");
    assert.ok(data.shorthands.some((s) => s.trigger === "cool/"));
    assert.ok(data.shorthands.some((s) => s.trigger === "new/"));
  });

  await t.test("global disable stops expansion and updates the real badge", async () => {
    await click("#enabled");
    await driver.wait(async () => (await driver.executeScript("return chrome.action.getBadgeText({})")) === "off", 5000);
    await app.openFixture();
    await keys("#inp", "cool/");
    assert.equal(await value("#inp"), "cool/");
    await app.settings({ enabled: true });
  });

  await t.test("excluded sites disable expansion and can be re-enabled", async () => {
    await app.openOptions();
    await fill("#excluded", "http://127.0.0.1/example");
    await keys("#excluded", Key.TAB);
    await driver.wait(async () => (await driver.executeScript("return self.ShorthandStorage.getAll()")).settings.excludedHosts.includes("127.0.0.1"), 5000);
    await app.openFixture();
    await keys("#inp", "cool/");
    assert.equal(await value("#inp"), "cool/");
    await app.settings({ excludedHosts: [] });
    await app.openFixture();
    await keys("#inp", "cool/");
    await waitValue("#inp", "That is really cool!");
  });

  await t.test("picker trigger changes and can be disabled", async () => {
    await app.settings({ pickerTrigger: "//" });
    await app.openFixture();
    await keys("#inp", "//");
    await driver.wait(pickerVisible, 5000);
    await keys("#inp", Key.ESCAPE);
    await app.settings({ pickerTrigger: "" });
    await app.openFixture();
    await keys("#inp", ";; //");
    assert.equal(await pickerVisible(), false);
    await app.settings({ pickerTrigger: ";;" });
  });

  await t.test("popup document searches and copies via the real clipboard", async () => {
    // Opening the popup document as a tab verifies its JS and clipboard action;
    // the browser toolbar's positioning and site toggle need a manual review.
    await driver.get(`${app.extensionURL}/src/popup.html`);
    await driver.wait(until.elementLocated(By.css(".result")), 5000);
    await fill("#search", "brb");
    await click(".result");
    await driver.wait(async () => (await text("#toast")) === "Copied brb/", 5000);
    await app.openFixture();
    await keys("#inp", Key.chord(Key.CONTROL, "v"));
    await waitValue("#inp", "be right back");
  });

  await t.test("edits and settings remain local without writing Firefox Sync", async () => {
    await app.openOptions();
    assert.deepEqual(await driver.executeScript("return chrome.storage.sync.get(null)"), {});
    const stored = await driver.executeScript("return chrome.storage.local.get(null)");
    assert.equal(Object.keys(stored).filter((key) => key.startsWith("sh:")).length, 6);
    assert.equal(stored.settings.pickerTrigger, ";;");
    assert.equal(stored.settings.enabled, true);
    assert.deepEqual(stored.settings.excludedHosts, []);
  });
});
