const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { launch, FIXTURE } = require("./helper.js");

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
const clients = new WeakMap();

// Chrome's DevTools DOM protocol can inspect a closed shadow root without
// changing the production component. Interactions below still use real mouse
// and keyboard events; this helper only reads state and scrolls controls into view.
async function formRead(page, fn, argument) {
  let client = clients.get(page);
  if (!client) {
    client = await page.context().newCDPSession(page);
    clients.set(page, client);
  }
  const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
  function find(node) {
    const attributes = node.attributes || [];
    if (attributes.some((value, i) => i % 2 === 0 && value === "id" && attributes[i + 1] === HOST.slice(1))) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const found = find(child);
      if (found) return found;
    }
  }
  const host = find(root);
  assert.ok(host && host.shadowRoots && host.shadowRoots.length === 1, "The actual closed template form must be present");
  const { object } = await client.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId });
  const result = await client.send("Runtime.callFunctionOn", {
    objectId: object.objectId, functionDeclaration: fn.toString(),
    arguments: [{ value: argument === undefined ? null : argument }], returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + result.exceptionDetails.exception.description);
  return result.result.value;
}

async function formClick(page, selector) {
  const point = await formRead(page, function (selector) {
    const element = this.querySelector(selector);
    if (!element) throw new Error("Missing form control: " + selector);
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, selector);
  await page.mouse.click(point.x, point.y);
}

async function formFill(page, selector, value) {
  await formClick(page, selector);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value);
}

async function formSelect(page, value, selector = "#template-pronouns") {
  const index = await formRead(page, function ([value, selector]) {
    return [...this.querySelector(selector).options].findIndex((option) => option.value === value);
  }, [value, selector]);
  assert.ok(index >= 0, `Pronoun choice must exist: ${value}`);
  await formClick(page, selector);
  await page.keyboard.press("Home");
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
}

async function submit(page) {
  await formClick(page, "#template-submit");
  await page.waitForSelector(HOST, { state: "detached", timeout: 5000 });
}

async function start(app, trigger, selector = "#inp") {
  await app.page.goto(FIXTURE);
  await app.page.waitForTimeout(150);
  await app.page.click(selector);
  await app.page.keyboard.type(trigger);
  await app.page.waitForSelector(HOST, { timeout: 5000 });
}

async function weekday(page) {
  return page.evaluate(() => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()]);
}

test("weekday-only tokens expand and copy without opening a form", async (t) => {
  const app = await launch({ shorthands: TEMPLATES });
  t.after(() => app.close());
  const { page } = app;
  const day = await weekday(page);
  const expected = `Happy ${day}! ${day.toUpperCase()}; {subject}`;
  await page.click("#inp");
  await page.keyboard.type("day/");
  assert.equal(await page.inputValue("#inp"), expected);
  assert.equal(await page.locator(HOST).count(), 0);
  await page.keyboard.press("Backspace");
  assert.equal(await page.inputValue("#inp"), "day/");
  const popup = await app.context.newPage();
  await popup.goto(`chrome-extension://${app.extensionId}/src/popup.html`);
  await popup.fill("#search", "day/");
  await popup.locator(".result").click();
  await popup.waitForFunction(() => document.getElementById("toast").textContent === "Copied day/");
  assert.equal(await popup.locator(HOST).count(), 0);
  await page.bringToFront();
  await page.fill("#inp", "");
  await page.keyboard.press("Control+v");
  assert.equal(await page.inputValue("#inp"), expected);
});

test("Chrome template variable forms and editor", { timeout: 120000 }, async (t) => {
  const app = await launch({ shorthands: TEMPLATES });
  t.after(() => app.close());
  const { page } = app;
  const originalStorage = await app.worker.evaluate(() => chrome.storage.sync.get(null));

  await t.test("repeated inline blanks synchronize both ways and retain answers across views", async () => {
    await start(app, "repeat/");
    assert.equal(await formRead(page, function () { return this.querySelector("#template-view-fields").getAttribute("aria-selected"); }), "true");
    assert.equal(await formRead(page, function () { return this.querySelectorAll("table tbody tr").length; }), 2);
    await formFill(page, "#template-field-0", "Alex");
    await formFill(page, "#template-field-1", "plans");
    await formClick(page, "#template-view-message");
    assert.deepEqual(await formRead(page, function () { return [...this.querySelectorAll("#template-message-panel input")].map((input) => input.value); }), ["Alex", "Alex", "plans"]);
    assert.deepEqual(await formRead(page, function () { return [...this.querySelectorAll("#template-message-panel input")].map((input) => input.tabIndex); }), [0, -1, 0]);
    await formFill(page, "#template-inline-1", "Bea");
    assert.deepEqual(await formRead(page, function () { return [...this.querySelectorAll("#template-message-panel input")].map((input) => input.value); }), ["Bea", "Bea", "plans"]);
    await page.keyboard.press("Tab");
    assert.equal(await formRead(page, function () { return this.activeElement.id; }), "template-inline-2", "Tab from a repeated occurrence should reach the next unique blank");
    await formClick(page, "#template-view-fields");
    assert.deepEqual(await formRead(page, function () { return [...this.querySelectorAll("#template-fields-panel input")].map((input) => input.value); }), ["Bea", "plans"]);
    await submit(page);
    assert.equal(await page.inputValue("#inp"), "Bea met Bea about plans.");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "repeat/");
  });

  await t.test("requires an explicit pronoun choice, including pronoun-only scripts", async () => {
    await start(app, "only/");
    assert.equal(await formRead(page, function () { return this.querySelector("#template-pronouns").value; }), "");
    await formClick(page, "#template-submit");
    assert.equal(await page.locator(HOST).count(), 1);
    assert.equal(await page.inputValue("#inp"), "only/");
    assert.equal(await formRead(page, function () { return this.activeElement.id; }), "template-pronouns");
    await formSelect(page, "they/them");
    await submit(page);
    assert.equal(await page.inputValue("#inp"), "They thanked them.");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "only/");
  });

  await t.test("renders every preset form, repeated pronouns, capitalization, and weekday", async () => {
    await start(app, "pron/");
    const day = await weekday(page);
    await formFill(page, "#template-field-0", "Alex");
    await formSelect(page, "she/her");
    const expected = `Alex said she would bring her notes for her; She kept hers and reminded herself. SHE arrives on ${day}.`;
    assert.equal(await formRead(page, function () { return this.querySelector("#template-preview").textContent; }), expected);
    await submit(page);
    assert.equal(await page.inputValue("#inp"), expected);
  });

  await t.test("custom pronouns survive view and preset switches and insert token-looking values literally", async () => {
    await start(app, "custom/", "#ce");
    await formFill(page, "#template-field-0", "{subject}");
    await formSelect(page, "custom");
    const forms = { subject: "{weekday} [[next]] <b>literal</b>", object: "zem", possessive: "zir", possessivepronoun: "zirs", reflexive: "zirself" };
    await formFill(page, "#template-pronoun-subject", forms.subject);
    await formClick(page, "#template-submit");
    assert.equal(await page.locator(HOST).count(), 1, "Every referenced custom pronoun form is required");
    assert.equal(await page.textContent("#ce"), "custom/");
    for (const [name, value] of Object.entries(forms).slice(1)) await formFill(page, "#template-pronoun-" + name, value);
    await formSelect(page, "he/him");
    await formSelect(page, "custom");
    assert.deepEqual(await formRead(page, function () { return [...this.querySelectorAll(".custom-pronouns input")].map((input) => input.value); }), Object.values(forms));
    await formClick(page, "#template-view-message");
    assert.equal(await formRead(page, function () { return this.querySelector("#template-inline-0").value; }), "{subject}");
    await submit(page);
    assert.equal(await page.textContent("#ce"), `${forms.subject} / zem / zir / zirs / zirself; {subject}; ${forms.subject}`);
    assert.equal(await page.locator("#ce b").count(), 0, "Custom pronoun text must never become markup");
  });

  for (const [label, tail] of [["emoji", "😀"], ["combining character", "e\u0301"]]) {
    await t.test(`custom ${label} pronouns preserve the rich-editor cursor position`, async () => {
      await start(app, "unicode/", "#ce");
      await formFill(page, "#template-field-0", "A");
      await formSelect(page, "custom");
      await formFill(page, "#template-pronoun-subject", tail);
      await submit(page);
      assert.equal(await page.textContent("#ce"), "A" + tail);
      await page.keyboard.type("X");
      assert.equal(await page.textContent("#ce"), "AX" + tail, "Typing must continue at {cursor}, before the complete Unicode answer");
    });
  }

  await t.test("cancel preserves the draft and each new session starts with no answers or pronoun choice", async () => {
    await start(app, "Before pron/");
    await formFill(page, "#template-field-0", "Private answer");
    await formSelect(page, "he/him");
    await formClick(page, "#template-cancel");
    assert.equal(await page.inputValue("#inp"), "Before pron/");
    await page.keyboard.type(" after");
    assert.equal(await page.inputValue("#inp"), "Before pron/ after");
    await start(app, "pron/");
    assert.deepEqual(await formRead(page, function () { return [this.querySelector("#template-field-0").value, this.querySelector("#template-pronouns").value]; }), ["", ""]);
    await page.keyboard.press("Escape");
    assert.deepEqual(await app.worker.evaluate(() => chrome.storage.sync.get(null)), originalStorage);
    assert.deepEqual(await app.worker.evaluate(async () => (await self.ShorthandStorage.getAll()).shorthands.map(({ trigger, expansion }) => ({ trigger, expansion }))), TEMPLATES);
  });

  await t.test("the toolbar copies the completed repeated-pronoun script to the real clipboard", async () => {
    const popup = await app.context.newPage();
    await popup.goto(`chrome-extension://${app.extensionId}/src/popup.html`);
    await popup.fill("#search", "pron/");
    await popup.locator(".result").click();
    await popup.waitForSelector(HOST);
    const day = await weekday(popup);
    await formFill(popup, "#template-field-0", "Avery");
    await formSelect(popup, "they/them");
    await submit(popup);
    await popup.waitForFunction(() => document.getElementById("toast").textContent === "Copied pron/");
    await page.goto(FIXTURE);
    await page.bringToFront();
    await page.click("#inp");
    await page.keyboard.press("Control+v");
    assert.equal(await page.inputValue("#inp"), `Avery said they would bring their notes for them; They kept theirs and reminded themself. THEY arrives on ${day}.`);
    await popup.close();
  });

  await t.test("each numbered person in a script gets their own required pronoun choice", async () => {
    await start(app, "two/");
    assert.deepEqual(await formRead(page, function () {
      return [...this.querySelectorAll(".pronouns > label")].map((label) => label.firstChild.textContent);
    }), ["Pronouns for person 1", "Pronouns for person 2"]);
    await formSelect(page, "she/her");
    await formClick(page, "#template-submit");
    assert.equal(await page.locator(HOST).count(), 1, "Every person needs a pronoun choice");
    assert.equal(await page.inputValue("#inp"), "two/");
    assert.equal(await formRead(page, function () { return this.activeElement.id; }), "template-pronouns-2");
    await formSelect(page, "he/him", "#template-pronouns-2");
    const expected = "She gave his keys to him; He thanked her.";
    assert.equal(await formRead(page, function () { return this.querySelector("#template-preview").textContent; }), expected);
    assert.equal(await formRead(page, function () { return this.querySelector(".count").textContent; }), "2 of 2 filled");
    await submit(page);
    assert.equal(await page.inputValue("#inp"), expected);
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "two/");
  });

  await t.test("the editor inserts another person's pronoun only for pronoun variables", async () => {
    const options = await app.context.newPage();
    await options.goto(`chrome-extension://${app.extensionId}/src/options.html`);
    await options.waitForSelector("#list tbody tr");
    assert.equal(await options.isDisabled("#variablePerson"), true, "Weekday has no person");
    await options.fill("#expansion", "");
    await options.selectOption("#variableToken", "{possessive}");
    assert.equal(await options.isDisabled("#variablePerson"), false);
    await options.selectOption("#variablePerson", "3");
    await options.click("#addVariableBtn");
    await options.selectOption("#variableToken", "{date}");
    assert.equal(await options.isDisabled("#variablePerson"), true);
    await options.click("#addVariableBtn");
    assert.equal(await options.inputValue("#expansion"), "{possessive3}{date}");
    await options.close();
  });

  await t.test("editor tools insert variables and reuse blanks at the remembered caret and export the script", async () => {
    const options = await app.context.newPage();
    await options.setViewportSize({ width: 1280, height: 800 });
    await options.goto(`chrome-extension://${app.extensionId}/src/options.html`);
    await options.waitForSelector("#list tbody tr");
    await options.fill("#trigger", "build/");
    await options.fill("#expansion", "Dear ");
    await options.fill("#fieldName", "name");
    await options.click("#addFieldBtn");
    await options.fill("#expansion", "Dear [[name]], ");
    await options.selectOption("#variableToken", "{subject}");
    await options.click("#addVariableBtn");
    await options.getByRole("button", { name: "Reuse blank: name", exact: true }).click();
    assert.equal(await options.inputValue("#expansion"), "Dear [[name]], {subject}[[name]]");
    await options.locator("#expansion").focus();
    await options.keyboard.press("Control+Home");
    await options.selectOption("#variableToken", "{weekday}");
    await options.click("#addVariableBtn");
    const expansion = "{weekday}Dear [[name]], {subject}[[name]]";
    assert.equal(await options.inputValue("#expansion"), expansion);
    assert.equal(await options.locator("#repeatFieldButtons button").count(), 1, "Repeated occurrences must remain one reusable blank");
    assert.equal(await options.locator("#templatePreview .variable-chip").count(), 2);
    await options.click("#saveBtn");
    await options.waitForFunction(() => [...document.querySelectorAll("#list td.trigger")].some((cell) => cell.textContent === "build/"));
    const downloadReady = options.waitForEvent("download");
    await options.click("#exportBtn");
    const exported = JSON.parse(fs.readFileSync(await (await downloadReady).path(), "utf8"));
    assert.equal(exported.version, 1);
    assert.deepEqual(exported.shorthands.find((entry) => entry.trigger === "build/"), { trigger: "build/", expansion });
    assert.deepEqual(exported.shorthands.filter((entry) => entry.trigger !== "build/"), TEMPLATES, "Form sessions must not save their answers or choices");
    await options.fill("#expansion", "Hello [[name]],\n\n{Subject} can join on {weekday}.\nPlease send {object} a reply.\nThanks, [[name]]!");
    const save = await options.evaluate(() => {
      window.scrollTo(0, 0);
      const { top, bottom } = document.getElementById("saveBtn").getBoundingClientRect();
      return { top, bottom, height: innerHeight };
    });
    assert.ok(save.top >= 0 && save.bottom <= save.height, `The desktop editor must keep Save in view for a five-line template: ${JSON.stringify(save)}`);
    assert.deepEqual(app.errors, []);
  });
});
