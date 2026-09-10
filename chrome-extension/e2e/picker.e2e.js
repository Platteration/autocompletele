// The search overlay. Most of what matters here cannot be unit tested: that
// keystrokes are swallowed rather than reaching the page, and that focus never
// leaves the page's own field.
const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, pickerVisible } = require("./helper.js");

test("picker overlay", async (t) => {
  const app = await launch();
  const { page } = app;
  t.after(() => app.close());

  await t.test("opens on the trigger and leaves the typed text in place", async () => {
    await page.click("#inp");
    await page.keyboard.type(";;");
    await page.waitForTimeout(200);
    assert.equal(await pickerVisible(page), true);
    assert.equal(await page.inputValue("#inp"), ";;");
  });

  await t.test("filter keystrokes do not reach the page", async () => {
    await page.keyboard.type("brb");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#inp"), ";;");
  });

  await t.test("focus never leaves the page's own field", async () => {
    const active = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.equal(active, "inp");
  });

  await t.test("Enter inserts the choice over the trigger and closes", async () => {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    assert.equal(await page.inputValue("#inp"), "be right back");
    assert.equal(await pickerVisible(page), false);
  });

  await t.test("Backspace after inserting restores the trigger", async () => {
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#inp"), ";;");
  });

  await t.test("Escape cancels and leaves what was typed", async () => {
    await page.fill("#inp", "");
    await page.keyboard.type("hello ;;");
    await page.waitForTimeout(200);
    assert.equal(await pickerVisible(page), true);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    assert.equal(await pickerVisible(page), false);
    assert.equal(await page.inputValue("#inp"), "hello ;;");
  });

  await t.test("arrow keys move the selection", async () => {
    await page.fill("#inp", "");
    await page.keyboard.type(";;");
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    // Second entry of the seeded list.
    assert.equal(await page.inputValue("#inp"), "Extremely cool!");
  });

  await t.test("works in a contenteditable editor", async () => {
    await page.click("#ce");
    await page.keyboard.type("note ;;");
    await page.waitForTimeout(200);
    assert.equal(await pickerVisible(page), true);
    await page.keyboard.type("addr");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    assert.equal(await page.textContent("#ce"), "note 123 Example Street");
  });

  await t.test("a real shorthand still takes precedence", async () => {
    await page.fill("#inp", "");
    await page.keyboard.type("cool/");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#inp"), "That is really cool!");
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("an empty picker trigger turns the overlay off", async (t) => {
  const app = await launch({ settings: { pickerTrigger: "" } });
  const { page } = app;
  t.after(() => app.close());

  await page.waitForTimeout(200);
  await page.click("#inp");
  await page.keyboard.type(";;");
  await page.waitForTimeout(200);
  assert.equal(await pickerVisible(page), false);
  assert.equal(await page.inputValue("#inp"), ";;");
});

test("the picker trigger can be changed", async (t) => {
  const app = await launch({ settings: { pickerTrigger: "//" } });
  const { page } = app;
  t.after(() => app.close());

  await page.waitForTimeout(200);
  await page.click("#inp");
  await page.keyboard.type("//");
  await page.waitForTimeout(200);
  assert.equal(await pickerVisible(page), true);
});
