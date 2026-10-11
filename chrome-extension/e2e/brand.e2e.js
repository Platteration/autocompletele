const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

const BRAND = "button[data-actle-brand]";

async function openBrand(app, name, reducedMotion = "no-preference") {
  const page = await app.context.newPage();
  await page.setViewportSize({ width: name === "options" ? 320 : 360, height: 900 });
  await page.emulateMedia({ reducedMotion });
  await page.goto(`chrome-extension://${app.extensionId}/src/${name}.html`);
  assert.equal(await page.locator(BRAND).count(), 1, "The extension must expose its actle logo");
  await page.waitForSelector(name === "options" ? "#list tbody tr" : ".result");
  return page;
}

// Measure rendered clipping, not just textContent (which always includes the
// concealed completion letters). Seeking the actual CSS animations avoids
// depending on scheduling speed to catch the short expanded frame.
async function snapshot(page, time) {
  return page.evaluate(async (time) => {
    const brand = document.querySelector("button[data-actle-brand]");
    const animations = brand.getAnimations({ subtree: true });
    if (time !== undefined) {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = time;
      }
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
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
    return {
      word: parts.filter((part) => part.width > 0 && part.opacity > 0).map((part) => part.text).join(""),
      completions: parts.filter((part) => part.completion),
      animations: animations.map((animation) => animation.animationName).sort(),
      brand: box(brand), search: box(document.getElementById("search")),
      width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      active: document.activeElement.id,
    };
  }, time);
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

for (const name of ["options", "popup"]) {
  test(`${name}: actle visibly autocompletes, settles, and replays without moving controls`, async (t) => {
    const app = await launch();
    t.after(() => app.close());
    const page = await openBrand(app, name);
    const brand = page.locator(BRAND);
    assert.equal(await page.getByRole("button", { name: "actle — autocompletes to autocompletele. Replay logo animation", exact: true }).count(), 1);
    assert.equal(await brand.locator(".actle-brand__word").getAttribute("aria-hidden"), "true");
    assert.equal(await brand.getAttribute("aria-disabled"), "false");
    const start = await snapshot(page, 0);
    assertCollapsed(start);
    assert.deepEqual(start.animations, ["actle-caret", "actle-complete", "actle-complete", "actle-complete"]);
    assertFits(start);
    if (name === "popup") assert.equal(start.active, "search", "Autoplay must preserve the popup's search autofocus");

    const expanded = await snapshot(page, 1800);
    assert.equal(expanded.word, "autocompletele");
    for (const part of expanded.completions) {
      assert.equal(part.opacity, 1);
      assert.ok(part.width >= part.textWidth - 0.1, `${part.text} must be fully visible, without clipping`);
    }
    assert.deepEqual(expanded.brand, start.brand, "Expansion must reserve its width before playing");
    assert.deepEqual(expanded.search, start.search, "Expansion must not move the search control");
    assertFits(expanded);
    if (name === "popup") assert.equal(expanded.active, "search");

    await brand.evaluate((element) => element.getAnimations({ subtree: true }).forEach((animation) => animation.finish()));
    await page.waitForFunction(() => document.querySelector("[data-actle-brand]").dataset.actleState === "idle");
    const end = await snapshot(page);
    assertCollapsed(end);
    assert.deepEqual(end.animations, [], "The logo must stop after one pass");
    assert.deepEqual(end.brand, start.brand);
    assert.deepEqual(end.search, start.search);
    if (name === "popup") assert.equal(end.active, "search");

    await brand.click();
    assert.equal(await brand.getAttribute("data-actle-state"), "playing", "The logo button must replay the animation");
    assert.equal((await snapshot(page, 1800)).word, "autocompletele");
    await brand.focus();
    await page.keyboard.press("Enter");
    assertCollapsed(await snapshot(page, 0));
    if (name === "options") {
      await brand.evaluate((element) => element.getAnimations({ subtree: true }).forEach((animation) => animation.play()));
      await page.waitForFunction(() => document.querySelector("[data-actle-brand]").dataset.actleState === "idle", null, { timeout: 6000 });
      assertCollapsed(await snapshot(page));
    }
  });

  test(`${name}: reduced motion is static, accessible, and stops an active animation`, async (t) => {
    const app = await launch();
    t.after(() => app.close());
    const page = await openBrand(app, name, "reduce");
    const brand = page.locator(BRAND);
    assert.equal(await page.getByRole("button", { name: "actle — autocompletes to autocompletele", exact: true }).count(), 1);
    assert.equal(await brand.getAttribute("aria-disabled"), "true");
    let state = await snapshot(page);
    assertCollapsed(state);
    assert.deepEqual(state.animations, []);
    // Dispatch the same native click event while aria-disabled: it must still
    // respect the preference even if activated by assistive technology.
    await brand.evaluate((element) => element.click());
    assert.equal(await brand.getAttribute("data-actle-state"), "idle");
    assert.deepEqual((await snapshot(page)).animations, []);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => document.querySelector("[data-actle-brand]").getAttribute("aria-disabled") === "false");
    assert.equal(await brand.getAttribute("data-actle-state"), "idle", "Preference changes must not unexpectedly replay the logo");
    await brand.click();
    assert.equal((await snapshot(page, 1800)).word, "autocompletele");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector("[data-actle-brand]").dataset.actleState === "idle");
    state = await snapshot(page);
    assertCollapsed(state);
    assert.deepEqual(state.animations, [], "Changing the system preference must cancel all logo motion");
    assertFits(state);
  });
}
