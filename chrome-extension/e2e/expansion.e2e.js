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

test("a page left open when actle reloads stops expanding and asks once for a reload", { timeout: 60000 }, async (t) => {
  // Chrome does not re-inject content scripts after an update or reload; the
  // old script stays in open pages, cut off from storage and settings.
  const app = await launch({ settings: { animationMode: "off" } });
  t.after(() => app.close());
  const { page } = app;
  await page.click("#inp");
  await page.keyboard.type("cool/");
  assert.equal(await page.inputValue("#inp"), "That is really cool!");
  await app.worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await page.waitForTimeout(1000);
  await page.fill("#inp", "");
  await page.click("#inp");
  await page.keyboard.type("brb/");
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue("#inp"), "brb/", "a stale page must not expand with a library it can no longer check");
  const notice = () => page.evaluate(() => {
    const host = document.getElementById("actle-usage-notice");
    return host ? host.getAttribute("id") : null;
  });
  assert.equal(await notice(), "actle-usage-notice", "the person is told why");
  // Recovery after reloading the page is not checked here: under Playwright the
  // reloaded unpacked extension does not start again.
});

test("triggers on a new line and after a corrected typo expand", { timeout: 60000 }, async (t) => {
  const app = await launch({ settings: { animationMode: "off" } });
  t.after(() => app.close());
  const { page } = app;

  await t.test("a trigger typed first on a new line of a rich editor expands", async () => {
    await page.click("#ce");
    await page.evaluate(() => { document.querySelector("#ce").textContent = ""; });
    await page.click("#ce");
    await page.keyboard.type("Hello");
    await page.keyboard.press("Enter");
    await page.keyboard.type("cool/");
    await page.waitForFunction(() => document.querySelector("#ce").innerText.includes("That is really cool!"));
    assert.equal(await page.evaluate(() => document.querySelector("#ce").innerText.replace(/\n+/g, "|")), "Hello|That is really cool!");
  });

  await t.test("a typo fixed with Backspace still lets the trigger expand in every field type", async () => {
    for (const selector of ["#inp", "#ta", "#ce"]) {
      await page.evaluate((s) => { const el = document.querySelector(s); if ("value" in el) el.value = ""; else el.textContent = ""; }, selector);
      await page.click(selector);
      await page.keyboard.type("cox");
      await page.keyboard.press("Backspace");
      await page.keyboard.type("ol/");
      const read = () => page.evaluate((s) => { const el = document.querySelector(s); return "value" in el ? el.value : el.textContent; }, selector);
      await page.waitForFunction((s) => { const el = document.querySelector(s); return ("value" in el ? el.value : el.textContent) === "That is really cool!"; }, selector, { timeout: 3000 })
        .catch(() => {});
      assert.equal(await read(), "That is really cool!", selector);
    }
  });

  await t.test("a page that rewrites the field during Backspace does not get the snippet", async () => {
    await page.evaluate(() => { const el = document.querySelector("#inp"); el.value = ""; });
    await page.click("#inp");
    await page.keyboard.type("zzzzz");
    await page.evaluate(() => {
      document.querySelector("#inp").addEventListener("keydown", (e) => {
        if (e.key !== "Backspace") return;
        e.preventDefault();
        const el = e.target; el.value = "coo"; el.setSelectionRange(3, 3);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }, { once: true });
    });
    await page.keyboard.press("Backspace");
    await page.keyboard.type("l/");
    await page.waitForTimeout(200);
    assert.equal(await page.inputValue("#inp"), "cool/");
  });
});
