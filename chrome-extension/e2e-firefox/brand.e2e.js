const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, Key, By } = require("./helper.js");

const BRAND = "button[data-actle-brand]";

async function motionPreference(driver, reduce) {
  await driver.setContext("chrome");
  await driver.executeScript((value) => Services.prefs.setIntPref("ui.prefersReducedMotion", value), Number(reduce));
  await driver.setContext("content");
  await driver.wait(async () => await driver.executeScript(
    "return matchMedia('(prefers-reduced-motion: reduce)').matches"
  ) === reduce, 5000, "Firefox must apply the real reduced-motion preference");
}

async function snapshot(driver, time) {
  return driver.executeAsyncScript(function (time, done) {
    const brand = document.querySelector("button[data-actle-brand]");
    const animations = brand.getAnimations({ subtree: true });
    if (time !== null) {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = time;
      }
    }
    requestAnimationFrame(() => {
      const box = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const parts = [...brand.querySelector(".actle-brand__word").children].map((part) => {
        const range = document.createRange();
        range.selectNodeContents(part);
        return {
          text: part.textContent,
          width: part.getBoundingClientRect().width,
          textWidth: range.getBoundingClientRect().width,
          opacity: Number(getComputedStyle(part).opacity),
          completion: part.classList.contains("actle-brand__completion"),
        };
      });
      done({
        word: parts.filter((part) => part.width > 0 && part.opacity > 0).map((part) => part.text).join(""),
        completions: parts.filter((part) => part.completion),
        animations: animations.map((animation) => animation.animationName).sort(),
        brand: box(brand), search: box(document.getElementById("search")),
        width: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
        active: document.activeElement.id,
      });
    });
  }, time === undefined ? null : time);
}

function assertCollapsed(state) {
  assert.equal(state.word, "actle");
  assert.deepEqual(state.completions.map((part) => [part.text, part.width, part.opacity]), [
    ["uto", 0, 0], ["omple", 0, 0], ["e", 0, 0],
  ]);
}

function assertFits(state) {
  assert.ok(state.width <= state.viewport, `Narrow page must not scroll horizontally: ${JSON.stringify(state)}`);
  assert.ok(state.brand.x >= 0 && state.brand.x + state.brand.width <= state.viewport,
    `The whole wordmark must fit on screen: ${JSON.stringify(state.brand)}`);
}

test("Firefox: real actle wordmark animation and system motion preferences", { timeout: 90000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver } = app;
  const state = () => driver.executeScript("return document.querySelector('[data-actle-brand]').dataset.actleState");
  async function open(name, reduce) {
    await motionPreference(driver, reduce);
    await driver.get(`${app.extensionURL}/src/${name}.html`);
    assert.equal((await driver.findElements(By.css(BRAND))).length, 1, "The extension must expose its actle logo");
    await driver.wait(async () => (await driver.findElements(By.css(name === "options" ? "#list tbody tr" : ".result"))).length > 0, 5000);
    const targetWidth = name === "options" ? 320 : 360;
    // Firefox can enforce a minimum outer window width. Measure overflow
    // against its actual CSS viewport, with Chromium also checking 320px.
    await driver.manage().window().setRect({ width: targetWidth, height: 900 });
    return app.element(BRAND);
  }

  for (const name of ["options", "popup"]) {
    await t.test(`${name} visibly expands, settles, and replays without moving controls`, async () => {
      const brand = await open(name, false);
      assert.equal(await brand.getAccessibleName(), "actle — autocompletes to autocompletele. Replay logo animation");
      assert.equal(await (await app.element(".actle-brand__word")).getAttribute("aria-hidden"), "true");
      assert.equal(await brand.getAttribute("aria-disabled"), "false");
      const start = await snapshot(driver, 0);
      assertCollapsed(start);
      assert.deepEqual(start.animations, ["actle-caret", "actle-complete", "actle-complete", "actle-complete"]);
      assertFits(start);
      if (name === "popup") assert.equal(start.active, "search", "Autoplay must preserve search autofocus");
      const expanded = await snapshot(driver, 1800);
      assert.equal(expanded.word, "autocompletele");
      for (const part of expanded.completions) {
        assert.equal(part.opacity, 1);
        assert.ok(part.width >= part.textWidth - 0.1, `${part.text} must be fully visible, without clipping`);
      }
      assert.deepEqual(expanded.brand, start.brand);
      assert.deepEqual(expanded.search, start.search);
      assertFits(expanded);
      if (name === "popup") assert.equal(expanded.active, "search");
      await driver.executeScript("document.querySelector('[data-actle-brand]').getAnimations({subtree:true}).forEach(animation => animation.finish())");
      await driver.wait(async () => await state() === "idle", 5000, "The animation must stop after one pass");
      const end = await snapshot(driver);
      assertCollapsed(end);
      assert.deepEqual(end.animations, []);
      assert.deepEqual(end.brand, start.brand);
      assert.deepEqual(end.search, start.search);
      if (name === "popup") assert.equal(end.active, "search");
      await brand.click();
      assert.equal(await state(), "playing");
      assert.equal((await snapshot(driver, 1800)).word, "autocompletele");
      await brand.sendKeys(Key.ENTER);
      assertCollapsed(await snapshot(driver, 0));
      if (name === "options") {
        await driver.executeScript("document.querySelector('[data-actle-brand]').getAnimations({subtree:true}).forEach(animation => animation.play())");
        await driver.wait(async () => await state() === "idle", 6000, "A naturally completed animation must stop after one pass");
        assertCollapsed(await snapshot(driver));
      }
    });

    await t.test(`${name} stays static under reduced motion and cancels active motion`, async () => {
      const brand = await open(name, true);
      assert.equal(await brand.getAccessibleName(), "actle — autocompletes to autocompletele");
      assert.equal(await brand.getAttribute("aria-disabled"), "true");
      let measured = await snapshot(driver);
      assertCollapsed(measured);
      assert.deepEqual(measured.animations, []);
      await driver.executeScript("document.querySelector('[data-actle-brand]').click()");
      assert.equal(await state(), "idle");
      assert.deepEqual((await snapshot(driver)).animations, []);
      await motionPreference(driver, false);
      await driver.wait(async () => await brand.getAttribute("aria-disabled") === "false", 5000);
      assert.equal(await state(), "idle", "Preference changes must not unexpectedly replay the logo");
      await brand.click();
      assert.equal((await snapshot(driver, 1800)).word, "autocompletele");
      await motionPreference(driver, true);
      await driver.wait(async () => await state() === "idle", 5000);
      measured = await snapshot(driver);
      assertCollapsed(measured);
      assert.deepEqual(measured.animations, []);
      assertFits(measured);
    });
  }
});
