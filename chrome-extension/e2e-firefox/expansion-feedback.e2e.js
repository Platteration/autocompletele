const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, Key, By } = require("./helper.js");

const CUE = "#actle-expansion-feedback";
const FORM = "#shorthand-template-host";
const ENTRIES = [
  { trigger: "yg", expansion: "you got it" },
  { trigger: "mid/", expansion: "ab{cursor}cd" },
  { trigger: "hello/", expansion: "Hi [[name]]." },
];

async function motion(driver, reduce) {
  await driver.setContext("chrome");
  await driver.executeScript((value) => Services.prefs.setIntPref("ui.prefersReducedMotion", value), Number(reduce));
  await driver.setContext("content");
  await driver.wait(async () => await driver.executeScript("return matchMedia('(prefers-reduced-motion: reduce)').matches") === reduce, 5000);
}

async function watch(driver) {
  await driver.executeScript(() => {
    window.feedbackAdded = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.id === "actle-expansion-feedback") window.feedbackAdded++;
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
}

test("Firefox: successful expansion feedback respects editing and motion preferences", { timeout: 120000 }, async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const { driver, element, value, text, fill } = app;
  const keys = (...values) => driver.actions().sendKeys(...values).perform();
  const count = async () => (await driver.findElements(By.css(CUE))).length;
  const events = () => driver.executeScript("return window.feedbackAdded");
  const gone = () => driver.wait(async () => await count() === 0, 2000, "Feedback must be removed");
  const contents = (selector) => selector === "#ce" ? text(selector) : value(selector);
  async function fixture(file = "page.html") {
    await motion(driver, false);
    await app.openFixture(file);
    await driver.sleep(150);
    await watch(driver);
  }
  async function frame() {
    const shadow = await (await element(CUE)).getShadowRoot();
    const rendered = await shadow.findElement(By.css(".frame"));
    return driver.executeScript((element) => {
      const animations = element.getAnimations({ subtree: true });
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 340;
      }
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        animations: animations.map((animation) => ({ name: animation.animationName, duration: animation.effect.getTiming().duration })),
        width: bounds.width, height: bounds.height, opacity: Number(style.opacity),
        borderColor: style.borderTopColor,
        focusable: element.getRootNode().querySelectorAll("button, input, select, textarea, a[href], [tabindex]").length,
      };
    }, rendered);
  }
  await app.openOptions();
  await driver.executeScript((entries) => self.ShorthandStorage.replaceAll(entries), ENTRIES);

  await t.test("successful yg replacement shows a brief blue noninteractive animation", async () => {
    await fixture();
    const before = await driver.executeScript(() => {
      const style = getComputedStyle(document.getElementById("inp"));
      return [style.color, style.backgroundColor, style.borderColor];
    });
    await (await element("#inp")).sendKeys("yg");
    assert.equal(await value("#inp"), "you got it");
    assert.equal(await count(), 1, "Successful replacement must show its feedback cue");
    const effect = await frame();
    assert.deepEqual(effect.animations.map(({ name }) => name).sort(), ["actle-expansion-fade", "actle-expansion-sweep"]);
    assert.ok(effect.animations.every(({ duration }) => duration === 680));
    assert.ok(effect.width > 0 && effect.height > 0 && effect.opacity > 0);
    const channels = effect.borderColor.match(/[\d.]+/g).map(Number);
    assert.ok(channels[2] > channels[0] && channels[2] > channels[1], `The border should be blue: ${effect.borderColor}`);
    assert.equal(effect.focusable, 0);
    const surface = await driver.executeScript(() => {
      const host = document.getElementById("actle-expansion-feedback");
      const target = document.getElementById("inp");
      const box = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return {
        pointer: getComputedStyle(host).pointerEvents,
        hidden: host.getAttribute("aria-hidden"), active: document.activeElement.id,
        caret: [target.selectionStart, target.selectionEnd],
        hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2).id,
        colors: [style.color, style.backgroundColor, style.borderColor],
      };
    });
    assert.deepEqual(surface, { pointer: "none", hidden: "true", active: "inp", caret: [10, 10], hit: "inp", colors: before });
    await gone();
    assert.equal(await events(), 1, "Paused CSS must still be removed by the finite cleanup fallback");
  });

  await t.test("inputs, textareas, and rich editors keep immediate undo, typing, and cursor placement", async () => {
    await fixture();
    for (const selector of ["#inp", "#ta", "#ce"]) {
      await (await element(selector)).sendKeys("yg");
      assert.equal(await contents(selector), "you got it");
      assert.equal(await count(), 1);
      await keys(Key.BACK_SPACE);
      assert.equal(await contents(selector), "yg");
      assert.equal(await count(), 0);
      await fill(selector, "mid/");
      assert.equal(await contents(selector), "abcd");
      assert.equal(await count(), 1);
      await keys("X");
      assert.equal(await contents(selector), "abXcd");
      assert.equal(await count(), 0);
    }
    assert.equal(await events(), 6);
  });

  await t.test("picker choices and confirmed templates animate only after insertion", async () => {
    await fixture();
    for (const selector of ["#inp", "#ce"]) {
      await (await element(selector)).sendKeys(";;");
      await driver.wait(async () => (await driver.findElements(By.css("#shorthand-picker-host"))).length === 1, 5000);
      assert.equal(await count(), 0);
      await keys("yg", Key.ENTER);
      assert.equal(await contents(selector), "you got it");
      assert.equal(await count(), 1);
      await keys(Key.BACK_SPACE);
      assert.equal(await contents(selector), ";;");
      assert.equal(await count(), 0);
      await fill(selector, "hello/");
      await driver.wait(async () => (await driver.findElements(By.css(FORM))).length === 1, 5000);
      assert.equal(await count(), 0);
      await keys("Sam", Key.ENTER);
      await driver.wait(async () => (await driver.findElements(By.css(FORM))).length === 0, 5000);
      assert.equal(await contents(selector), "Hi Sam.");
      assert.equal(await count(), 1);
      await keys(Key.BACK_SPACE);
      assert.equal(await contents(selector), "hello/");
      assert.equal(await count(), 0);
    }
    assert.equal(await events(), 4);
  });

  await t.test("cancelled, invalid, and stale template submissions never animate", async () => {
    await fixture();
    await (await element("#inp")).sendKeys("hello/");
    await driver.wait(async () => (await driver.findElements(By.css(FORM))).length === 1, 5000);
    await keys(Key.ENTER);
    assert.equal((await driver.findElements(By.css(FORM))).length, 1);
    await keys(Key.ESCAPE);
    assert.equal(await value("#inp"), "hello/");
    await fill("#inp", "hello/");
    await driver.wait(async () => (await driver.findElements(By.css(FORM))).length === 1, 5000);
    await driver.executeScript("document.getElementById('inp').value = 'New draft'");
    await keys("Sam", Key.ENTER);
    await driver.sleep(100);
    assert.equal(await value("#inp"), "New draft");
    assert.equal((await driver.findElements(By.css(FORM))).length, 1);
    assert.equal(await count(), 0);
    assert.equal(await events(), 0);
    await keys(Key.ESCAPE);
  });

  await t.test("unmatched text, password and ignored fields, and paused expansion never animate", async () => {
    await fixture();
    await (await element("#inp")).sendKeys("ordinary text");
    for (const selector of ["#pw", "#ign"]) {
      await (await element(selector)).sendKeys("yg");
      assert.equal(await value(selector), "yg");
    }
    await app.settings({ enabled: false });
    await driver.switchTo().window(app.fixtureHandle);
    await driver.sleep(150);
    await fill("#inp", "yg");
    assert.equal(await value("#inp"), "yg");
    assert.equal(await count(), 0);
    assert.equal(await events(), 0);
    await app.settings({ enabled: true });
  });

  await t.test("reduced motion suppresses creation and immediately disposes of active feedback", async () => {
    await fixture();
    await motion(driver, true);
    await (await element("#inp")).sendKeys("yg");
    assert.equal(await value("#inp"), "you got it");
    assert.equal(await count(), 0);
    assert.equal(await events(), 0);
    await motion(driver, false);
    await fill("#inp", "yg");
    assert.equal(await count(), 1);
    await motion(driver, true);
    await gone();
    await motion(driver, false);
    assert.equal(await count(), 0);
    assert.equal(await events(), 1);
  });

  await t.test("feedback disappears when its target moves or is removed", async () => {
    await fixture();
    await (await element("#inp")).sendKeys("yg");
    assert.equal(await count(), 1);
    await driver.executeScript("document.getElementById('inp').style.marginLeft = '30px'");
    await gone();
    await fill("#inp", "yg");
    assert.equal(await count(), 1);
    await driver.executeScript("document.getElementById('inp').remove()");
    await gone();
    assert.equal(await events(), 2);
  });

  await t.test("misaligned roots and decorative setup errors never interrupt expansion", async () => {
    await fixture();
    await driver.executeScript("document.documentElement.style.transform = 'translateX(50px)'");
    await (await element("#inp")).sendKeys("yg");
    assert.equal(await value("#inp"), "you got it");
    assert.equal(await count(), 0);
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#inp"), "yg");
    await app.openOptions();
    await driver.executeScript(() => {
      window.feedbackErrors = [];
      window.addEventListener("error", (event) => window.feedbackErrors.push(event.message));
      self.ShorthandExpansionFeedback.show = () => { throw new Error("Simulated decorative setup failure"); };
    });
    await fill("#tryit", "yg");
    assert.equal(await value("#tryit"), "you got it");
    await keys(Key.BACK_SPACE);
    assert.equal(await value("#tryit"), "yg");
    assert.deepEqual(await driver.executeScript("return window.feedbackErrors"), []);
  });

  await t.test("toolbar copying does not create an insertion cue", async () => {
    await driver.switchTo().window(app.optionsHandle);
    await driver.get(`${app.extensionURL}/src/popup.html`);
    await watch(driver);
    await fill("#search", "yg");
    await (await element(".result")).click();
    await driver.wait(async () => await text("#toast") === "Copied yg", 5000);
    assert.equal(await count(), 0);
    assert.equal(await events(), 0);
  });

  await t.test("the rendered cue works under strict CSP without a violation", async () => {
    await fixture("strict-csp.html");
    await driver.executeScript(() => {
      window.feedbackViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.feedbackViolations.push(event.violatedDirective));
    });
    await (await element("#inp")).sendKeys("yg");
    assert.equal(await value("#inp"), "you got it");
    assert.equal(await count(), 1);
    const effect = await frame();
    assert.ok(effect.width > 0 && effect.height > 0 && effect.opacity > 0);
    assert.deepEqual(await driver.executeScript("return window.feedbackViolations"), []);
  });
});
