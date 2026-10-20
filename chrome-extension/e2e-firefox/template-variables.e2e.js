const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launch, Key, By } = require("./helper.js");
const { Select } = require("selenium-webdriver/lib/select");

const HOST = "#shorthand-template-host";
const TEMPLATES = [
  { trigger: "day/", expansion: "Happy {weekday}! {WEEKDAY}; {{subject}}" },
  { trigger: "repeat/", expansion: "[[name]] met [[name]] about [[topic]]." },
  { trigger: "pron/", expansion: "[[name]] said {subject} would bring {possessive} notes for {object}; {Subject} kept {possessivepronoun} and reminded {reflexive}. {SUBJECT} arrives on {weekday}." },
  { trigger: "only/", expansion: "{Subject} thanked {object}." },
  { trigger: "custom/", expansion: "{subject} / {object} / {possessive} / {possessivepronoun} / {reflexive}; [[name]]; {subject}" },
  { trigger: "unicode/", expansion: "[[name]]{cursor}{subject}" },
  { trigger: "two/", expansion: "{Subject} gave {possessive2} keys to {object2}; {Subject2} thanked {object}." },
];

test("Firefox: template variables, synchronized views, and editor tools", { timeout: 120000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver, element, fill, value, text, waitValue } = app;
  const keys = (...values) => driver.actions().sendKeys(...values).perform();
  const visible = async () => (await driver.findElements(By.css(HOST))).length === 1;
  async function formElement(selector) {
    const shadow = await (await element(HOST)).getShadowRoot();
    return shadow.findElement(By.css(selector));
  }
  const formRead = async (fn, argument) => driver.executeScript(fn, await formElement("form"), argument === undefined ? null : argument);
  const formClick = async (selector) => (await formElement(selector)).click();
  async function formFill(selector, answer) {
    const input = await formElement(selector);
    await input.clear();
    if (answer) await input.sendKeys(answer);
  }
  async function select(control, choice) {
    // WebDriver selects the real option; keys sent after opening Firefox's
    // native popup do not reliably reach that operating-system control.
    await new Select(control).selectByValue(choice);
    assert.equal(await control.getAttribute("value"), choice);
  }
  const formSelect = async (choice) => select(await formElement("#template-pronouns"), choice);
  async function submit() {
    await formClick("#template-submit");
    await driver.wait(async () => !(await visible()), 5000, "A completed template should close after confirmation");
  }
  async function start(trigger, selector = "#inp") {
    await app.openFixture();
    await driver.sleep(150);
    await (await element(selector)).sendKeys(trigger);
    await driver.wait(visible, 5000, "This script should open its fill-in form");
  }
  const weekday = () => driver.executeScript(() => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()]);
  await app.openOptions();
  await driver.executeScript((items) => self.ShorthandStorage.replaceAll(items), TEMPLATES);
  const originalStorage = await driver.executeScript("return chrome.storage.local.get(null)");

  await t.test("weekday-only tokens expand and copy without opening a form", async () => {
    await app.openFixture();
    await driver.sleep(150);
    const day = await weekday();
    const expected = `Happy ${day}! ${day.toUpperCase()}; {subject}`;
    await (await element("#inp")).sendKeys("day/");
    await waitValue("#inp", expected);
    assert.equal(await visible(), false);
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#inp"), "day/");
    await driver.switchTo().window(app.optionsHandle);
    await driver.get(`${app.extensionURL}/src/popup.html`);
    await fill("#search", "day/");
    await (await element(".result")).click();
    await driver.wait(async () => await text("#toast") === "Copied day/", 5000);
    assert.equal(await visible(), false);
    await app.openFixture();
    await (await element("#inp")).sendKeys(Key.chord(Key.CONTROL, "v"));
    await waitValue("#inp", expected);
  });

  await t.test("repeated inline blanks synchronize both ways and retain answers across views", async () => {
    await start("repeat/");
    assert.equal(await formRead((form) => form.querySelector("#template-view-fields").getAttribute("aria-selected")), "true");
    assert.equal(await formRead((form) => form.querySelectorAll("table tbody tr").length), 2);
    await formFill("#template-field-0", "Alex");
    await formFill("#template-field-1", "plans");
    await formClick("#template-view-message");
    assert.deepEqual(await formRead((form) => [...form.querySelectorAll("#template-message-panel input")].map((input) => input.value)), ["Alex", "Alex", "plans"]);
    assert.deepEqual(await formRead((form) => [...form.querySelectorAll("#template-message-panel input")].map((input) => input.tabIndex)), [0, -1, 0]);
    await formFill("#template-inline-1", "Bea");
    assert.deepEqual(await formRead((form) => [...form.querySelectorAll("#template-message-panel input")].map((input) => input.value)), ["Bea", "Bea", "plans"]);
    await keys(Key.TAB);
    assert.equal(await formRead((form) => form.getRootNode().activeElement.id), "template-inline-2", "Tab from a repeated occurrence should reach the next unique blank");
    await formClick("#template-view-fields");
    assert.deepEqual(await formRead((form) => [...form.querySelectorAll("#template-fields-panel input")].map((input) => input.value)), ["Bea", "plans"]);
    await submit();
    assert.equal(await value("#inp"), "Bea met Bea about plans.");
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#inp"), "repeat/");
  });

  await t.test("requires an explicit pronoun choice, including pronoun-only scripts", async () => {
    await start("only/");
    assert.equal(await formRead((form) => form.querySelector("#template-pronouns").value), "");
    await formClick("#template-submit");
    assert.equal(await visible(), true);
    assert.equal(await value("#inp"), "only/");
    assert.equal(await formRead((form) => form.getRootNode().activeElement.id), "template-pronouns");
    await formSelect("they/them");
    await submit();
    assert.equal(await value("#inp"), "They thanked them.");
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#inp"), "only/");
  });

  await t.test("renders every preset form, repeated pronouns, capitalization, and weekday", async () => {
    await start("pron/");
    const day = await weekday();
    await formFill("#template-field-0", "Alex");
    await formSelect("she/her");
    const expected = `Alex said she would bring her notes for her; She kept hers and reminded herself. SHE arrives on ${day}.`;
    assert.equal(await formRead((form) => form.querySelector("#template-preview").textContent), expected);
    await submit();
    assert.equal(await value("#inp"), expected);
  });

  await t.test("custom pronouns survive view and preset switches and insert token-looking values literally", async () => {
    await start("custom/", "#ce");
    await formFill("#template-field-0", "{subject}");
    await formSelect("custom");
    const forms = { subject: "{weekday} [[next]] <b>literal</b>", object: "zem", possessive: "zir", possessivepronoun: "zirs", reflexive: "zirself" };
    await formFill("#template-pronoun-subject", forms.subject);
    await formClick("#template-submit");
    assert.equal(await visible(), true, "Every referenced custom pronoun form is required");
    assert.equal(await text("#ce"), "custom/");
    for (const [name, answer] of Object.entries(forms).slice(1)) await formFill("#template-pronoun-" + name, answer);
    await formSelect("he/him");
    await formSelect("custom");
    assert.deepEqual(await formRead((form) => [...form.querySelectorAll(".custom-pronouns input")].map((input) => input.value)), Object.values(forms));
    await formClick("#template-view-message");
    assert.equal(await formRead((form) => form.querySelector("#template-inline-0").value), "{subject}");
    await submit();
    assert.equal(await text("#ce"), `${forms.subject} / zem / zir / zirs / zirself; {subject}; ${forms.subject}`);
    assert.equal((await driver.findElements(By.css("#ce b"))).length, 0, "Custom pronoun text must never become markup");
  });

  for (const [label, tail] of [["emoji", "😀"], ["combining character", "e\u0301"]]) {
    await t.test(`custom ${label} pronouns preserve the rich-editor cursor position`, async () => {
      await start("unicode/", "#ce");
      await formFill("#template-field-0", "A");
      await formSelect("custom");
      await formFill("#template-pronoun-subject", tail);
      await submit();
      assert.equal(await text("#ce"), "A" + tail);
      await keys("X");
      assert.equal(await text("#ce"), "AX" + tail, "Typing must continue at {cursor}, before the complete Unicode answer");
    });
  }

  await t.test("cancel preserves the draft and each new session starts with no answers or pronoun choice", async () => {
    await app.openOptions();
    // Earlier subtests inserted seven completions. Firefox now stores that
    // separate usage record locally alongside its unchanged snippet library.
    const usageBefore = await driver.executeScript(async () => {
      await self.ActlePremium.status();
      const date = new Date();
      return { version: 1, day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        used: 7, pending: {}, licenseToken: "" };
    });
    const expectedStorage = { ...originalStorage, "actle-premium": usageBefore };
    // The same insertions, plus one toolbar copy, also recorded local
    // per-snippet use counts for ranking. That separate record is checked
    // on its own so the library comparison below stays exact.
    const storedBefore = await driver.executeScript("return chrome.storage.local.get(null)");
    const usageCounts = storedBefore["shorthand-usage-counts"];
    delete storedBefore["shorthand-usage-counts"];
    assert.deepEqual(storedBefore, expectedStorage);
    assert.ok(usageCounts && Object.keys(usageCounts).length > 0
      && Object.keys(usageCounts).every((id) => originalStorage["sh:" + id])
      && Object.values(usageCounts).every((count) => Number.isInteger(count) && count > 0),
    "use counts must be positive integers keyed by saved snippet ids");
    assert.equal(Object.values(usageCounts).reduce((sum, count) => sum + count, 0), usageBefore.used + 1,
      "seven insertions plus one toolbar copy");
    expectedStorage["shorthand-usage-counts"] = usageCounts;
    assert.deepEqual(await driver.executeScript("return chrome.storage.local.get(null)"), expectedStorage);
    await start("Before pron/");
    await formFill("#template-field-0", "Private answer");
    await formSelect("he/him");
    await formClick("#template-cancel");
    assert.equal(await value("#inp"), "Before pron/");
    await keys(" after");
    assert.equal(await value("#inp"), "Before pron/ after");
    await start("pron/");
    assert.deepEqual(await formRead((form) => [form.querySelector("#template-field-0").value, form.querySelector("#template-pronouns").value]), ["", ""]);
    await keys(Key.ESCAPE);
    await app.openOptions();
    assert.deepEqual(await driver.executeScript("return chrome.storage.local.get(null)"), expectedStorage);
    assert.deepEqual(await driver.executeScript("return chrome.storage.sync.get(null)"), {});
  });

  await t.test("the toolbar copies the completed repeated-pronoun script to the real clipboard", async () => {
    await driver.switchTo().window(app.optionsHandle);
    await driver.get(`${app.extensionURL}/src/popup.html`);
    await fill("#search", "pron/");
    await (await element(".result")).click();
    await driver.wait(visible, 5000);
    const day = await weekday();
    await formFill("#template-field-0", "Avery");
    await formSelect("they/them");
    await submit();
    await driver.wait(async () => await text("#toast") === "Copied pron/", 5000);
    await app.openFixture();
    await (await element("#inp")).sendKeys(Key.chord(Key.CONTROL, "v"));
    await waitValue("#inp", `Avery said they would bring their notes for them; They kept theirs and reminded themself. THEY arrives on ${day}.`);
  });

  await t.test("each numbered person in a script gets their own required pronoun choice", async () => {
    await start("two/");
    assert.deepEqual(await formRead((form) => [...form.querySelectorAll(".pronouns > label")].map((label) => label.firstChild.textContent)),
      ["Pronouns for person 1", "Pronouns for person 2"]);
    await formSelect("she/her");
    await formClick("#template-submit");
    assert.equal(await visible(), true, "Every person needs a pronoun choice");
    assert.equal(await value("#inp"), "two/");
    assert.equal(await formRead((form) => form.getRootNode().activeElement.id), "template-pronouns-2");
    await select(await formElement("#template-pronouns-2"), "he/him");
    const expected = "She gave his keys to him; He thanked her.";
    assert.equal(await formRead((form) => form.querySelector("#template-preview").textContent), expected);
    assert.equal(await formRead((form) => form.querySelector(".count").textContent), "2 of 2 filled");
    await submit();
    assert.equal(await value("#inp"), expected);
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#inp"), "two/");
  });

  await t.test("the editor inserts another person's pronoun only for pronoun variables", async () => {
    await app.openOptions();
    assert.equal(await (await element("#variablePerson")).isEnabled(), false, "Weekday has no person");
    await fill("#expansion", "");
    await select(await element("#variableToken"), "{possessive}");
    assert.equal(await (await element("#variablePerson")).isEnabled(), true);
    await select(await element("#variablePerson"), "3");
    await (await element("#addVariableBtn")).click();
    await select(await element("#variableToken"), "{date}");
    assert.equal(await (await element("#variablePerson")).isEnabled(), false);
    await (await element("#addVariableBtn")).click();
    assert.equal(await value("#expansion"), "{possessive3}{date}");
    await fill("#expansion", "");
  });

  await t.test("editor tools insert variables and reuse blanks at the remembered caret and export the script", async () => {
    await app.openOptions();
    const outer = await driver.manage().window().getRect();
    const viewport = await driver.executeScript("return {width: innerWidth, height: innerHeight}");
    await driver.manage().window().setRect({ width: outer.width + 1280 - viewport.width, height: outer.height + 800 - viewport.height });
    assert.deepEqual(await driver.executeScript("return [innerWidth, innerHeight]"), [1280, 800]);
    await fill("#trigger", "build/");
    await fill("#expansion", "Dear ");
    await fill("#fieldName", "name");
    await (await element("#addFieldBtn")).click();
    await fill("#expansion", "Dear [[name]], ");
    await select(await element("#variableToken"), "{subject}");
    await (await element("#addVariableBtn")).click();
    await (await driver.findElement(By.css('#repeatFieldButtons button[aria-label="Reuse blank: name"]'))).click();
    assert.equal(await value("#expansion"), "Dear [[name]], {subject}[[name]]");
    await (await element("#expansion")).sendKeys(Key.chord(Key.CONTROL, Key.HOME));
    await select(await element("#variableToken"), "{weekday}");
    await (await element("#addVariableBtn")).click();
    const expansion = "{weekday}Dear [[name]], {subject}[[name]]";
    assert.equal(await value("#expansion"), expansion);
    assert.equal((await driver.findElements(By.css("#repeatFieldButtons button"))).length, 1);
    assert.equal((await driver.findElements(By.css("#templatePreview .variable-chip"))).length, 2);
    await (await element("#saveBtn")).click();
    await driver.wait(async () => (await driver.findElements(By.css("#list tbody tr"))).length === TEMPLATES.length + 1, 5000);
    await (await element("#exportBtn")).click();
    const exportedPath = path.join(app.downloads, "shorthands.json");
    await driver.wait(() => fs.existsSync(exportedPath), 10000);
    const exported = JSON.parse(fs.readFileSync(exportedPath, "utf8"));
    assert.equal(exported.version, 1);
    assert.deepEqual(exported.shorthands.find((entry) => entry.trigger === "build/"), { trigger: "build/", expansion });
    assert.deepEqual(exported.shorthands.filter((entry) => entry.trigger !== "build/"), TEMPLATES, "Form sessions must not save their answers or choices");
    await fill("#expansion", "Hello [[name]],\n\n{Subject} can join on {weekday}.\nPlease send {object} a reply.\nThanks, [[name]]!");
    const save = await driver.executeScript(() => {
      window.scrollTo(0, 0);
      const { top, bottom } = document.getElementById("saveBtn").getBoundingClientRect();
      return { top, bottom, height: innerHeight };
    });
    assert.ok(save.top >= 0 && save.bottom <= save.height, `The desktop editor must keep Save in view for a five-line template: ${JSON.stringify(save)}`);
  });
});
