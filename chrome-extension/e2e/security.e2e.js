const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, pickerVisible } = require("./helper.js");

test("page-fabricated events cannot extract snippets", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "secret/", expansion: "private snippet" }] });
  t.after(() => app.close());
  const { page } = app;
  await page.evaluate(() => {
    const field = document.querySelector("#inp");
    field.focus();
    field.value = "secret/";
    field.setSelectionRange(7, 7);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  assert.equal(await page.inputValue("#inp"), "secret/");
  await page.evaluate(() => {
    const field = document.querySelector("#inp");
    field.value = "";
    field.focus();
    document.execCommand("insertText", false, "secret/");
  });
  assert.equal(await page.inputValue("#inp"), "secret/", "scripted editor commands cannot release stored text");
  await page.evaluate(() => {
    const field = document.querySelector("#inp");
    field.value = ";;";
    field.setSelectionRange(2, 2);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  });
  assert.equal(await pickerVisible(page), false);
  assert.equal(await page.inputValue("#inp"), ";;");

  await page.fill("#inp", "");
  await page.keyboard.type(";;");
  assert.equal(await pickerVisible(page), true);
  await page.evaluate(() => document.querySelector("#inp").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
  assert.equal(await pickerVisible(page), true);
  assert.equal(await page.inputValue("#inp"), ";;");
  await page.keyboard.press("Enter");
  assert.equal(await page.inputValue("#inp"), "private snippet");
});

test("a page changing an open picker target cannot receive its stored snippet", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "secret/", expansion: "private snippet" }] });
  t.after(() => app.close());
  await app.page.click("#inp");
  await app.page.keyboard.type(";;");
  assert.equal(await pickerVisible(app.page), true);
  await app.page.evaluate(() => { document.querySelector("#inp").value = "xx"; });
  await app.page.keyboard.press("Enter");
  assert.equal(await app.page.inputValue("#inp"), "xx");
});

for (const mode of ["merge", "replace"]) {
  test(`an oversized ${mode} import retains the synced library`, async (t) => {
    const app = await launch({ shorthands: [{ trigger: "old/", expansion: "keep me" }] });
    t.after(() => app.close());
    const options = await app.context.newPage();
    await options.goto(`chrome-extension://${app.extensionId}/src/options.html`);
    await options.waitForSelector("#list tbody tr");
    await options.setInputFiles("#importFile", { name: "large.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ version: 1, shorthands: [{ trigger: "huge/", expansion: "x".repeat(9000) }] })) });
    await options.click(`#${mode}Btn`);
    await options.waitForFunction(() => document.getElementById("ioMsg").textContent.includes("Skipped"));
    const current = await app.worker.evaluate(() => self.ShorthandStorage.getAll());
    assert.deepEqual(current.shorthands.map((s) => ({ trigger: s.trigger, expansion: s.expansion })), [{ trigger: "old/", expansion: "keep me" }]);
  });
}

for (const selector of ["#inp", "#ce"]) {
  test(`a fresh physical key cannot authorize scripted extraction in ${selector}`, async (t) => {
    const app = await launch({ shorthands: [{ trigger: "secret/", expansion: "private snippet" }] });
    t.after(() => app.close());
    await app.page.click(selector);
    await app.page.evaluate((target) => {
      document.querySelector(target).addEventListener("keydown", (event) => {
        event.preventDefault();
        document.execCommand("insertText", false, "secret/");
      }, { once: true });
    }, selector);
    await app.page.keyboard.press("a");
    assert.equal(selector === "#inp" ? await app.page.inputValue(selector) : await app.page.textContent(selector), "secret/");
    assert.equal(await pickerVisible(app.page), false);
  });
}

test("a page-prefilled trigger prefix is not a user shortcut", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "secret/", expansion: "private snippet" }] });
  t.after(() => app.close());
  await app.page.fill("#inp", "secret");
  await app.page.keyboard.press("/");
  assert.equal(await app.page.inputValue("#inp"), "secret/");
  await app.page.fill("#inp", "");
  await app.page.keyboard.type("secret/");
  assert.equal(await app.page.inputValue("#inp"), "private snippet");
});
