// Expansion behaviour in a real browser: the parts unit tests cannot reach,
// such as execCommand insertion, caret placement and key interception.
const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

test("expansion in real fields", async (t) => {
  const app = await launch();
  const { page } = app;
  t.after(() => app.close());

  await t.test("expands in a plain text input", async () => {
    await page.click("#inp");
    await page.keyboard.type("hey cool/ ok");
    assert.equal(await page.inputValue("#inp"), "hey That is really cool! ok");
  });

  await t.test("places the caret at {cursor} in a textarea", async () => {
    await page.click("#ta");
    await page.keyboard.type("sig/");
    await page.keyboard.type("X");
    assert.equal(await page.inputValue("#ta"), "Regards,\nX\nAlex");
  });

  await t.test("expands in a contenteditable editor", async () => {
    await page.click("#ce");
    await page.keyboard.type("a cool/ b");
    assert.equal(await page.textContent("#ce"), "a That is really cool! b");
  });

  await t.test("does not fire in the middle of a word", async () => {
    await page.fill("#inp", "");
    await page.keyboard.type("school/");
    assert.equal(await page.inputValue("#inp"), "school/");
  });

  await t.test("substitutes the date placeholder", async () => {
    await page.fill("#inp", "");
    await page.keyboard.type("td/");
    assert.match(await page.inputValue("#inp"), /^\d{4}-\d{2}-\d{2}$/);
  });

  await t.test("never expands in a password field", async () => {
    await page.click("#pw");
    await page.keyboard.type("cool/");
    assert.equal(await page.inputValue("#pw"), "cool/");
  });

  await t.test("never expands inside data-shorthand-ignore", async () => {
    await page.click("#ign");
    await page.keyboard.type("cool/");
    assert.equal(await page.inputValue("#ign"), "cool/");
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("undo restores the trigger", async (t) => {
  const app = await launch();
  const { page } = app;
  t.after(() => app.close());

  await t.test("Backspace straight after an expansion puts the trigger back", async () => {
    await page.click("#inp");
    await page.keyboard.type("hey cool/");
    assert.equal(await page.inputValue("#inp"), "hey That is really cool!");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "hey cool/");
  });

  await t.test("a second Backspace is an ordinary delete", async () => {
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "hey cool");
  });

  await t.test("undo works with {cursor} in the middle", async () => {
    await page.click("#ta");
    await page.keyboard.type("sig/");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#ta"), "sig/");
  });

  await t.test("typing anything else closes the undo window", async () => {
    await page.fill("#inp", "");
    await page.keyboard.type("cool/ x");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "That is really cool! ");
  });

  await t.test("undo works in a contenteditable editor", async () => {
    await page.click("#ce");
    await page.keyboard.type("z mid/");
    await page.keyboard.press("Backspace");
    assert.equal(await page.textContent("#ce"), "z mid/");
  });
});

test("the enabled setting is respected", async (t) => {
  const app = await launch({ settings: { enabled: false } });
  const { page } = app;
  t.after(() => app.close());

  await page.waitForTimeout(200);
  await page.click("#inp");
  await page.keyboard.type("cool/");
  assert.equal(await page.inputValue("#inp"), "cool/");
});
