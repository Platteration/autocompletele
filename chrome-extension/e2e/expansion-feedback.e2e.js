const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { launch, FIXTURE } = require("./helper.js");

const CUE = "#actle-expansion-feedback";
const FORM = "#shorthand-template-host";
const ENTRIES = [
  { trigger: "yg", expansion: "you got it" },
  { trigger: "mid/", expansion: "ab{cursor}cd" },
  { trigger: "hello/", expansion: "Hi [[name]]." },
];

async function watch(page) {
  await page.evaluate(() => {
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

async function fixture(page, file = FIXTURE) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(file);
  await page.waitForTimeout(150);
  await watch(page);
}

async function frame(page) {
  const client = await page.context().newCDPSession(page);
  try {
    const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
    function find(node) {
      const attributes = node.attributes || [];
      if (attributes.some((value, i) => i % 2 === 0 && value === "id" && attributes[i + 1] === CUE.slice(1))) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const result = find(child);
        if (result) return result;
      }
    }
    const host = find(root);
    assert.ok(host && host.shadowRoots && host.shadowRoots.length === 1, "Feedback must be rendered in its actual closed shadow root");
    const { object } = await client.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId });
    const result = await client.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        const element = this.querySelector(".frame");
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
          borderColor: style.borderTopColor, background: style.backgroundColor,
          focusable: this.querySelectorAll("button, input, select, textarea, a[href], [tabindex]").length,
        };
      }.toString(),
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  } finally {
    await client.detach();
  }
}

test("successful yg replacement shows a brief blue noninteractive animation", async (t) => {
  const app = await launch({ shorthands: ENTRIES });
  t.after(() => app.close());
  const { page } = app;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await watch(page);
  const before = await page.locator("#inp").evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.color, style.backgroundColor, style.borderColor];
  });
  await page.click("#inp");
  await page.keyboard.type("yg");
  assert.equal(await page.inputValue("#inp"), "you got it");
  assert.equal(await page.locator(CUE).count(), 1, "Successful replacement must show its feedback cue");
  const effect = await frame(page);
  assert.deepEqual(effect.animations.map(({ name }) => name).sort(), ["actle-expansion-fade", "actle-expansion-sweep"]);
  assert.ok(effect.animations.every(({ duration }) => duration === 680));
  assert.ok(effect.width > 0 && effect.height > 0 && effect.opacity > 0, "The effect must have a visible rendered frame");
  const channels = effect.borderColor.match(/[\d.]+/g).map(Number);
  assert.ok(channels[2] > channels[0] && channels[2] > channels[1], `The border should be blue: ${effect.borderColor}`);
  assert.equal(effect.focusable, 0);
  const surface = await page.locator(CUE).evaluate((element) => {
    const target = document.getElementById("inp");
    const box = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    return {
      pointer: getComputedStyle(element).pointerEvents,
      hidden: element.getAttribute("aria-hidden"),
      active: document.activeElement.id,
      caret: [target.selectionStart, target.selectionEnd],
      hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2).id,
      colors: [style.color, style.backgroundColor, style.borderColor],
    };
  });
  assert.deepEqual(surface, { pointer: "none", hidden: "true", active: "inp", caret: [10, 10], hit: "inp", colors: before });
  // Pausing CSS must not defeat the module's finite cleanup fallback.
  await page.waitForSelector(CUE, { state: "detached", timeout: 2000 });
  assert.equal(await page.evaluate(() => window.feedbackAdded), 1);
});

test("Chrome expansion feedback respects editing and motion preferences", { timeout: 120000 }, async (t) => {
  const app = await launch({ shorthands: ENTRIES });
  t.after(() => app.close());
  const { page } = app;
  const contents = (selector) => selector === "#ce" ? page.textContent(selector) : page.inputValue(selector);
  const absent = () => page.locator(CUE).count();

  await t.test("inputs, textareas, and rich editors keep immediate undo, typing, and cursor placement", async () => {
    await fixture(page);
    for (const selector of ["#inp", "#ta", "#ce"]) {
      await page.click(selector);
      await page.keyboard.type("yg");
      assert.equal(await contents(selector), "you got it");
      assert.equal(await absent(), 1);
      await page.keyboard.press("Backspace");
      assert.equal(await contents(selector), "yg");
      assert.equal(await absent(), 0, "Undo must clear the cue and must not create another one");
      await page.fill(selector, "");
      await page.keyboard.type("mid/");
      assert.equal(await contents(selector), "abcd");
      assert.equal(await absent(), 1);
      await page.keyboard.type("X");
      assert.equal(await contents(selector), "abXcd");
      assert.equal(await absent(), 0, "Continued typing must immediately dismiss the cue");
    }
    assert.equal(await page.evaluate(() => window.feedbackAdded), 6);
  });

  await t.test("picker choices and confirmed templates animate only after insertion", async () => {
    await fixture(page);
    for (const selector of ["#inp", "#ce"]) {
      await page.click(selector);
      await page.keyboard.type(";;");
      await page.waitForSelector("#shorthand-picker-host");
      assert.equal(await absent(), 0);
      await page.keyboard.type("yg");
      await page.keyboard.press("Enter");
      assert.equal(await contents(selector), "you got it");
      assert.equal(await absent(), 1);
      await page.keyboard.press("Backspace");
      assert.equal(await contents(selector), ";;");
      assert.equal(await absent(), 0);
      await page.fill(selector, "");
      await page.keyboard.type("hello/");
      await page.waitForSelector(FORM);
      assert.equal(await absent(), 0);
      await page.keyboard.type("Sam");
      await page.keyboard.press("Enter");
      await page.waitForSelector(FORM, { state: "detached" });
      assert.equal(await contents(selector), "Hi Sam.");
      assert.equal(await absent(), 1);
      await page.keyboard.press("Backspace");
      assert.equal(await contents(selector), "hello/");
      assert.equal(await absent(), 0);
    }
    assert.equal(await page.evaluate(() => window.feedbackAdded), 4);
  });

  await t.test("cancelled, invalid, and stale template submissions never animate", async () => {
    await fixture(page);
    await page.click("#inp");
    await page.keyboard.type("hello/");
    await page.waitForSelector(FORM);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(FORM).count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await page.inputValue("#inp"), "hello/");
    await page.fill("#inp", "");
    await page.keyboard.type("hello/");
    await page.waitForSelector(FORM);
    await page.evaluate(() => { document.getElementById("inp").value = "New draft"; });
    await page.keyboard.type("Sam");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
    assert.equal(await page.inputValue("#inp"), "New draft");
    assert.equal(await page.locator(FORM).count(), 1);
    assert.equal(await absent(), 0);
    assert.equal(await page.evaluate(() => window.feedbackAdded), 0);
    await page.keyboard.press("Escape");
  });

  await t.test("unmatched text, password and ignored fields, and paused expansion never animate", async () => {
    await fixture(page);
    await page.click("#inp");
    await page.keyboard.type("ordinary text");
    for (const selector of ["#pw", "#ign"]) {
      await page.click(selector);
      await page.keyboard.type("yg");
      assert.equal(await page.inputValue(selector), "yg");
    }
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ enabled: false }));
    await page.waitForTimeout(150);
    await page.fill("#inp", "");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "yg");
    assert.equal(await absent(), 0);
    assert.equal(await page.evaluate(() => window.feedbackAdded), 0);
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ enabled: true }));
  });

  await t.test("reduced motion suppresses creation and immediately disposes of active feedback", async () => {
    await fixture(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.click("#inp");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "you got it");
    assert.equal(await absent(), 0);
    assert.equal(await page.evaluate(() => window.feedbackAdded), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.fill("#inp", "");
    await page.keyboard.type("yg");
    assert.equal(await absent(), 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForSelector(CUE, { state: "detached", timeout: 1000 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    assert.equal(await absent(), 0, "Changing the preference back must not replay an old expansion");
    assert.equal(await page.evaluate(() => window.feedbackAdded), 1);
  });

  await t.test("feedback disappears when its target moves or is removed", async () => {
    await fixture(page);
    await page.click("#inp");
    await page.keyboard.type("yg");
    assert.equal(await absent(), 1);
    await page.evaluate(() => { document.getElementById("inp").style.marginLeft = "30px"; });
    await page.waitForSelector(CUE, { state: "detached", timeout: 1000 });
    await page.fill("#inp", "");
    await page.keyboard.type("yg");
    assert.equal(await absent(), 1);
    await page.evaluate(() => document.getElementById("inp").remove());
    await page.waitForSelector(CUE, { state: "detached", timeout: 1000 });
    assert.equal(await page.evaluate(() => window.feedbackAdded), 2);
  });

  await t.test("misaligned roots and decorative setup errors never interrupt expansion", async () => {
    await fixture(page);
    await page.evaluate(() => { document.documentElement.style.transform = "translateX(50px)"; });
    await page.click("#inp");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "you got it");
    assert.equal(await absent(), 0, "A cue with incorrect page coordinates must be discarded");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "yg");
    const options = await app.context.newPage();
    const errors = [];
    options.on("pageerror", (error) => errors.push(String(error)));
    await options.goto(`chrome-extension://${app.extensionId}/src/options.html`);
    await options.waitForSelector("#list tbody tr");
    await options.evaluate(() => {
      self.ShorthandExpansionFeedback.show = () => { throw new Error("Simulated decorative setup failure"); };
    });
    await options.locator("#tryit").fill("yg");
    assert.equal(await options.inputValue("#tryit"), "you got it");
    await options.keyboard.press("Backspace");
    assert.equal(await options.inputValue("#tryit"), "yg");
    assert.deepEqual(errors, []);
    await options.close();
  });

  await t.test("toolbar copying does not create an insertion cue", async () => {
    const popup = await app.context.newPage();
    await popup.goto(`chrome-extension://${app.extensionId}/src/popup.html`);
    await watch(popup);
    await popup.fill("#search", "yg");
    await popup.locator(".result").click();
    await popup.waitForFunction(() => document.getElementById("toast").textContent === "Copied yg");
    assert.equal(await popup.locator(CUE).count(), 0);
    assert.equal(await popup.evaluate(() => window.feedbackAdded), 0);
    await popup.close();
  });

  await t.test("the rendered cue works under strict CSP without a violation", async () => {
    await fixture(page, "file://" + path.join(__dirname, "fixtures", "strict-csp.html"));
    await page.evaluate(() => {
      window.feedbackViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.feedbackViolations.push(event.violatedDirective));
    });
    await page.click("#inp");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "you got it");
    assert.equal(await absent(), 1);
    const effect = await frame(page);
    assert.ok(effect.width > 0 && effect.height > 0 && effect.opacity > 0);
    assert.deepEqual(await page.evaluate(() => window.feedbackViolations), []);
    assert.deepEqual(app.errors, []);
  });
});
