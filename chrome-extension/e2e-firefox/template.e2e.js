const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launch, Key, By, until } = require("./helper.js");

const HOST = "#shorthand-template-host";
const TEMPLATES = [
  { trigger: "hello/", expansion: "Hello [[name]], about [[topic]]. Thanks, [[name]]!" },
  { trigger: "one/", expansion: "Hi [[name]]." },
  { trigger: "letter/", expansion: "Dear [[name]],\n[[topic]]\nThanks, [[name]]" },
  { trigger: "literal/", expansion: "[[answer]] | {date} | A{cursor}B" },
];

test("Firefox: fill-in templates in the real add-on", { timeout: 120000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver, element, fill, value, text, waitValue } = app;
  const keys = (...values) => driver.actions().sendKeys(...values).perform();
  const click = async (selector) => (await element(selector)).click();
  const visible = async () => (await driver.findElements(By.css(HOST))).length === 1;
  async function opened() {
    await driver.wait(visible, 5000, "A named-blank template must open a fill-in form");
    assert.equal(await driver.executeScript("return document.activeElement.id"), HOST.slice(1));
  }
  async function answer(values) {
    for (let i = 0; i < values.length; i++) {
      if (i) await keys(Key.TAB);
      await keys(values[i]);
    }
  }
  async function insert(values) {
    await answer(values);
    await keys(Key.ENTER);
    await driver.wait(async () => !(await visible()), 5000, "Completed template should close after insertion");
  }
  async function start(selector = "#inp", trigger = "one/") {
    await app.openFixture();
    await driver.sleep(150);
    await (await element(selector)).sendKeys(trigger);
    await opened();
  }

  await app.openOptions();
  await driver.executeScript((items) => self.ShorthandStorage.replaceAll(items), TEMPLATES);

  await t.test("repeated blanks share an answer, Tab stays in the form, and undo restores the trigger", async () => {
    await start("#inp", "hello/");
    assert.equal(await value("#inp"), "hello/");
    // Two answers, two action buttons, and the selected view tab form one cycle.
    for (let i = 0; i < 5; i++) await keys(Key.TAB);
    await insert(["Alex", "the launch"]);
    await waitValue("#inp", "Hello Alex, about the launch. Thanks, Alex!");
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#inp"), "hello/");
  });

  await t.test("renders built-ins but leaves answers containing tokens and HTML literal", async () => {
    await start("#inp", "literal/");
    const date = await driver.executeScript(() => {
      const now = new Date();
      return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    });
    await insert(["{date} {cursor} [[other]] <b>literal</b>"]);
    assert.equal(await value("#inp"), `{date} {cursor} [[other]] <b>literal</b> | ${date} | AB`);
    await keys("X");
    assert.equal(await value("#inp"), `{date} {cursor} [[other]] <b>literal</b> | ${date} | AXB`);
  });

  await t.test("expands multiline templates in textareas and plain text in rich editors", async () => {
    await start("#ta", "letter/");
    await insert(["Morgan", "Your appointment is tomorrow."]);
    assert.equal(await value("#ta"), "Dear Morgan,\nYour appointment is tomorrow.\nThanks, Morgan");
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#ta"), "letter/");
    await start("#ce", "Note: one/");
    await insert(["<b>Alex</b>"]);
    assert.equal(await text("#ce"), "Note: Hi <b>Alex</b>.");
    assert.equal((await driver.findElements(By.css("#ce b"))).length, 0);
    await keys(Key.BACK_SPACE);
    assert.equal(await text("#ce"), "Note: one/");
  });

  await t.test("Escape and the Cancel button preserve the original draft and caret", async () => {
    await start("#inp", "Before one/");
    await answer(["Discard me"]);
    await keys(Key.ESCAPE);
    assert.equal(await visible(), false);
    assert.equal(await value("#inp"), "Before one/");
    await keys(" after");
    assert.equal(await value("#inp"), "Before one/ after");
    await start();
    await keys(Key.TAB, Key.ENTER);
    assert.equal(await visible(), false);
    assert.equal(await value("#inp"), "one/");
  });

  await t.test("requires every answer before inserting", async () => {
    await start("#inp", "hello/");
    await keys(Key.ENTER);
    assert.equal(await visible(), true);
    assert.equal(await value("#inp"), "hello/");
    await answer(["Alex"]);
    await keys(Key.ENTER);
    assert.equal(await visible(), true);
    assert.equal(await value("#inp"), "hello/");
    await insert(["a follow-up"]);
    assert.equal(await value("#inp"), "Hello Alex, about a follow-up. Thanks, Alex!");
  });

  await t.test("picker selection asks for answers and preserves the picker trigger for undo", async () => {
    await app.openFixture();
    await driver.sleep(150);
    await (await element("#inp")).sendKeys("Note: ;;");
    await driver.wait(until.elementLocated(By.css("#shorthand-picker-host")), 5000);
    await keys("hello", Key.ENTER);
    await opened();
    assert.equal(await value("#inp"), "Note: ;;");
    assert.equal((await driver.findElements(By.css("#shorthand-picker-host"))).length, 0);
    await insert(["Sam", "plans"]);
    assert.equal(await value("#inp"), "Note: Hello Sam, about plans. Thanks, Sam!");
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#inp"), "Note: ;;");
  });

  await t.test("rejects changed text and a replacement for the original field", async () => {
    await start();
    await driver.executeScript("document.getElementById('inp').value = 'Newer page draft'");
    await answer(["Alex"]);
    await keys(Key.ENTER);
    await driver.sleep(150);
    assert.equal(await value("#inp"), "Newer page draft");
    assert.equal(await visible(), true);
    await keys(Key.ESCAPE);
    await start();
    await driver.executeScript(() => {
      const original = document.getElementById("inp");
      const replacement = original.cloneNode();
      replacement.value = "Replacement draft";
      original.replaceWith(replacement);
    });
    await answer(["Alex"]);
    await keys(Key.ENTER);
    await driver.sleep(150);
    assert.equal(await value("#inp"), "Replacement draft");
    assert.equal(await visible(), true);
    await keys(Key.ESCAPE);
  });

  await t.test("rejects a submission after expansion is paused", async () => {
    await start();
    await app.settings({ enabled: false });
    await driver.switchTo().window(app.fixtureHandle);
    await answer(["Alex"]);
    await keys(Key.ENTER);
    await driver.sleep(150);
    assert.equal(await value("#inp"), "one/");
    assert.equal(await visible(), true);
    await keys(Key.ESCAPE);
    await app.settings({ enabled: true });
  });

  await t.test("preserves rich-editor markup rebuilt while the form is open", async () => {
    await start("#ce", "one/");
    await driver.executeScript("document.getElementById('ce').innerHTML = '<strong>one/</strong>'");
    await answer(["Alex"]);
    await keys(Key.ENTER);
    await driver.sleep(150);
    assert.equal(await text("#ce"), "one/");
    assert.equal((await driver.findElements(By.css("#ce strong"))).length, 1);
    assert.equal(await visible(), true);
    await keys(Key.ESCAPE);
  });

  await t.test("uses a styled, working form under strict CSP", async () => {
    await app.openFixture("strict-csp.html");
    await driver.executeScript("window.templateViolations=[]; document.addEventListener('securitypolicyviolation', e=>window.templateViolations.push(e.violatedDirective))");
    await driver.sleep(150);
    await (await element("#inp")).sendKeys("one/");
    await opened();
    const layout = await driver.executeScript(() => {
      const host = document.getElementById("shorthand-template-host");
      const box = host.getBoundingClientRect();
      return { position: getComputedStyle(host).position, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.equal(layout.position, "fixed");
    assert.equal(layout.width, layout.viewportWidth);
    assert.equal(layout.height, layout.viewportHeight);
    await insert(["Casey"]);
    assert.equal(await value("#inp"), "Hi Casey.");
    assert.deepEqual(await driver.executeScript("return window.templateViolations"), []);
  });

  await t.test("copies a completed template from the popup through the real clipboard", async () => {
    await driver.switchTo().window(app.optionsHandle);
    await driver.get(`${app.extensionURL}/src/popup.html`);
    await driver.wait(until.elementLocated(By.css(".result")), 5000);
    await fill("#search", "hello/");
    await click(".result");
    await opened();
    await insert(["Avery", "next steps"]);
    await driver.wait(async () => (await text("#toast")) === "Copied hello/", 5000);
    await app.openFixture();
    await (await element("#inp")).sendKeys(Key.chord(Key.CONTROL, "v"));
    await waitValue("#inp", "Hello Avery, about next steps. Thanks, Avery!");
  });

  await t.test("keeps answers ephemeral and persists and transfers named blanks", async () => {
    await app.openOptions();
    const saved = await driver.executeScript("return self.ShorthandStorage.getAll()");
    assert.deepEqual(saved.shorthands.map(({ trigger, expansion }) => ({ trigger, expansion })), TEMPLATES);
    assert.deepEqual(await driver.executeScript("return chrome.storage.sync.get(null)"), {});
    await fill("#trigger", "draft/");
    await fill("#expansion", "Hello ");
    await fill("#fieldName", "name");
    await click("#addFieldBtn");
    assert.equal(await value("#expansion"), "Hello [[name]]");
    const expansion = "Hello [[name]], about [[topic]]. Thanks, [[name]]!";
    await fill("#expansion", expansion);
    assert.match(await text("#templateFieldCount"), /2/);
    await click("#saveBtn");
    const row = () => driver.findElement(By.xpath("//table[@id='list']//tr[td[@class='trigger' and text()='draft/']]"));
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 5, 5000);
    await driver.navigate().refresh();
    await (await (await row()).findElement(By.css("button.secondary"))).click();
    assert.equal(await value("#expansion"), expansion);
    await click("#exportBtn");
    const exportedPath = path.join(app.downloads, "shorthands.json");
    await driver.wait(() => fs.existsSync(exportedPath), 10000);
    const exported = JSON.parse(fs.readFileSync(exportedPath, "utf8"));
    assert.equal(exported.version, 1);
    assert.deepEqual(exported.shorthands.find((entry) => entry.trigger === "draft/"), { trigger: "draft/", expansion });
    await (await (await row()).findElement(By.css("button.danger"))).click();
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 4, 5000);
    await (await element("#importFile")).sendKeys(exportedPath);
    await driver.wait(until.elementIsVisible(await element("#importPreview")), 5000);
    await click("#mergeBtn");
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === 5, 5000);
    await (await (await row()).findElement(By.css("button.secondary"))).click();
    assert.equal(await value("#expansion"), expansion);
  });
});
