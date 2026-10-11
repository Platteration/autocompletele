const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, FIXTURE } = require("./helper.js");

const CUE = "#actle-expansion-feedback";
const ENTRIES = [
  { trigger: "yg", expansion: "you got it" },
  { trigger: "mid/", expansion: "ab{cursor}cd" },
  { trigger: "unicode/", expansion: "A👩🏽‍💻e\u0301B" },
  { trigger: "hello/", expansion: "Hi [[name]]." },
];

// Passively observe the actual closed root in the extension's own playground.
// Its mode, animation clock, DOM, and editor value remain under production control.
function observeAnimation() {
  const editor = document.getElementById("tryit");
  const trace = window.animationTrace = { added: 0, samples: [], inputs: [] };
  editor.addEventListener("input", (event) => trace.inputs.push({ data: event.data, value: editor.value }));
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const root = original.call(this, options);
    if (this.id !== "actle-expansion-feedback") return root;
    trace.added++;
    const host = this;
    function sample() {
      const glyphs = root.querySelector(".glyphs");
      if (!host.isConnected || !glyphs) return;
      const mask = root.querySelector(".mask");
      const mirror = root.querySelector(".mirror");
      const style = getComputedStyle(mask);
      const bounds = mask.getBoundingClientRect();
      const editorBounds = editor.getBoundingClientRect();
      let opacity = 1;
      for (let node = glyphs; node && node.nodeType === 1; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      trace.samples.push({
        text: glyphs.textContent, mirror: mirror.textContent, value: editor.value,
        background: style.backgroundColor, opacity, display: style.display, visibility: style.visibility,
        width: bounds.width, height: bounds.height, closed: host.shadowRoot === null,
        geometry: [bounds.left, bounds.top, bounds.width, bounds.height],
        expectedGeometry: [editorBounds.left + editor.clientLeft, editorBounds.top + editor.clientTop, editor.clientWidth, editor.clientHeight],
      });
    }
    new MutationObserver(sample).observe(root, { childList: true, characterData: true, subtree: true });
    queueMicrotask(sample);
    return root;
  };
}

function assertCommitted(trace, expansion, trigger = "yg") {
  assert.ok(trace.samples.length > 2, "The actual glyph animation must have multiple rendered frames");
  assert.ok(trace.samples.every((sample) => sample.value === expansion), "Autosave must never observe the visual animation's temporary text");
  assert.equal(trace.inputs.filter((event) => event.data === expansion).length, 1, "Exactly one input event must commit the expansion");
  const committed = trace.inputs.findIndex((event) => event.value === expansion);
  assert.ok(committed >= 0);
  assert.ok(trace.inputs.slice(0, committed).every((event) => trigger.startsWith(event.value)), "Before committing, input observers may see only the user's typed trigger");
  assert.ok(trace.inputs.slice(committed).every((event) => event.value === expansion), "After committing, input observers may never see a scrambled or partial phrase");
  for (const sample of trace.samples) {
    assert.equal(sample.closed, true);
    assert.ok(sample.width > 0 && sample.height > 0 && sample.opacity === 1, "The mask must cover the committed glyphs throughout the animation");
    assert.notEqual(sample.display, "none");
    assert.notEqual(sample.visibility, "hidden");
    assert.match(sample.background, /^rgb\(/, "The mask must have a fully opaque background");
    assert.ok(sample.geometry.every((value, index) => Math.abs(value - sample.expectedGeometry[index]) < 0.5), "The opaque mask must cover the editor's full inner client box");
  }
}

async function playground(app, mode) {
  if (mode) await app.worker.evaluate((animationMode) => self.ShorthandStorage.saveSettings({ animationMode }), mode);
  const { page } = app;
  await page.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#tryit").scrollIntoViewIfNeeded();
  await page.click("#tryit");
  // Scrolling the playground intentionally dismisses existing feedback; settle it first.
  await page.waitForTimeout(150);
  await page.evaluate(observeAnimation);
}

async function rendered(page, inspectOutline = false) {
  const client = await page.context().newCDPSession(page);
  try {
    const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
    function find(node) {
      const attrs = node.attributes || [];
      if (attrs.some((item, i) => i % 2 === 0 && item === "id" && attrs[i + 1] === CUE.slice(1))) return node;
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
        const found = find(child);
        if (found) return found;
      }
    }
    const host = find(root);
    assert.ok(host && host.shadowRoots.length === 1, "The real content script must create its closed overlay");
    const { object } = await client.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId });
    const result = await client.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      arguments: [{ value: inspectOutline }],
      functionDeclaration: function (inspectOutline) {
        const mirror = this.querySelector(".mirror");
        const mask = this.querySelector(".mask");
        const frame = this.querySelector(".frame");
        const bounds = frame.getBoundingClientRect();
        return {
          mirror: mirror && mirror.textContent,
          glyphs: this.querySelector(".glyphs")?.textContent ?? null,
          background: mask && getComputedStyle(mask).backgroundColor,
          frame: !!this.querySelector(".frame"),
          ...(mirror ? { paint: {
            color: getComputedStyle(mirror).color,
            fill: getComputedStyle(mirror).getPropertyValue("-webkit-text-fill-color"),
            strokeWidth: getComputedStyle(mirror).getPropertyValue("-webkit-text-stroke-width"),
            strokeColor: getComputedStyle(mirror).getPropertyValue("-webkit-text-stroke-color"),
          } } : {}),
          ...(inspectOutline ? { outline: {
            opacity: Number(getComputedStyle(frame).opacity), width: bounds.width, height: bounds.height,
            border: getComputedStyle(frame).borderTopColor,
          } } : {}),
        };
      }.toString(),
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  } finally { await client.detach(); }
}

test("Expand visibly grows yg into you got it while committing the real value once", async (t) => {
  const app = await launch({ shorthands: ENTRIES });
  t.after(() => app.close());
  await playground(app);
  await app.page.keyboard.type("yg");
  assert.equal(await app.page.inputValue("#tryit"), "you got it");
  await app.page.waitForSelector(CUE, { state: "detached", timeout: 2000 });
  const trace = await app.page.evaluate(() => window.animationTrace);
  assertCommitted(trace, "you got it");
  const frames = [...new Set(trace.samples.map((sample) => sample.text))];
  assert.equal(frames[0], "yg", "The first visible frame must retain the typed trigger");
  assert.equal(frames.at(-1), "you got it");
  assert.ok(frames.some((text) => text.length > 2 && text.length < 10), `Missing intermediate growth: ${JSON.stringify(frames)}`);
  assert.ok(frames.every((text) => /^y.*g/.test(text)), "Both seed letters must stay in order throughout growth");
  assert.equal(trace.added, 1);
  assert.deepEqual(app.errors, []);
});

test("Chrome animation modes preserve the real editing transaction", { timeout: 120000 }, async (t) => {
  const app = await launch({ shorthands: ENTRIES });
  t.after(() => app.close());
  const { page } = app;
  const absent = () => page.locator(CUE).count();
  const contents = (selector) => selector === "#ce" ? page.textContent(selector) : page.inputValue(selector);
  async function fixture(mode) {
    await app.worker.evaluate((animationMode) => self.ShorthandStorage.saveSettings({ animationMode }), mode);
    await page.goto(FIXTURE);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(150);
  }

  await t.test("Casino visibly scrambles and progressively locks the final phrase", async () => {
    await playground(app, "casino");
    await page.keyboard.type("yg");
    await page.waitForSelector(CUE, { state: "detached", timeout: 2000 });
    const trace = await page.evaluate(() => window.animationTrace);
    assertCommitted(trace, "you got it");
    const frames = [...new Set(trace.samples.map((sample) => sample.text))];
    const final = "you got it";
    assert.equal(frames.at(-1), final);
    assert.ok(frames.some((text) => text.length === final.length && text !== final && !text.startsWith("you")), `Missing scrambled frame: ${JSON.stringify(frames)}`);
    assert.ok(frames.some((text) => text.startsWith("you got ") && text !== final), `Missing partially locked frame: ${JSON.stringify(frames)}`);
    assert.ok(frames.every((text) => text[3] === " " && text[7] === " "), "Whitespace must remain stable during scrambling");
    assert.equal(trace.added, 1);
  });

  await t.test("both animated modes cover inputs, textareas, and simple rich text without losing surrounding text or undo", async () => {
    for (const mode of ["expand", "casino"]) {
      await fixture(mode);
      for (const selector of ["#inp", "#ta", "#ce"]) {
        await page.fill(selector, "before |after");
        await page.locator(selector).evaluate((element) => {
          element.focus();
          if (element.isContentEditable) {
            const selection = getSelection();
            selection.collapse(element.firstChild, 7);
          } else element.setSelectionRange(7, 7);
        });
        await page.keyboard.type("yg");
        assert.equal(await contents(selector), "before you got it|after");
        const effect = await rendered(page);
        assert.ok(effect.glyphs, `${mode} must render glyphs on ${selector}`);
        assert.equal(effect.mirror, `before ${effect.glyphs}|after`);
        assert.match(effect.background, /^rgb\(/);
        await page.keyboard.press("Backspace");
        assert.equal(await contents(selector), "before yg|after");
        assert.equal(await absent(), 0);
        await page.fill(selector, "");
        await page.keyboard.type("mid/");
        assert.equal(await contents(selector), "abcd");
        assert.equal(await absent(), 1);
        await page.keyboard.type("X");
        assert.equal(await contents(selector), "abXcd");
        assert.equal(await absent(), 0, "Typing must immediately reveal the unchanged committed text and preserve its caret");
      }
    }
  });

  await t.test("Off creates no feedback while expansion, cursor placement, and undo still work", async () => {
    await playground(app, "off");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#tryit"), "you got it");
    assert.equal(await absent(), 0);
    assert.equal(await page.evaluate(() => window.animationTrace.added), 0);
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#tryit"), "yg");
    await page.fill("#tryit", "");
    await page.keyboard.type("mid/");
    await page.keyboard.type("X");
    assert.equal(await page.inputValue("#tryit"), "abXcd");
    assert.equal(await page.evaluate(() => window.animationTrace.added), 0);
  });

  await t.test("picker choices and completed templates use the selected glyph animation", async () => {
    await fixture("casino");
    await page.click("#inp");
    await page.keyboard.type(";;");
    await page.waitForSelector("#shorthand-picker-host");
    assert.equal(await absent(), 0);
    await page.keyboard.type("yg");
    await page.keyboard.press("Enter");
    assert.equal(await page.inputValue("#inp"), "you got it");
    const picked = await rendered(page);
    assert.equal(picked.glyphs.length, 10, "Picker insertion must pass the Casino mode and inserted phrase to the mirror");
    assert.equal(picked.mirror, picked.glyphs);
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), ";;");
    await page.click("#ce");
    await page.keyboard.type("hello/");
    await page.waitForSelector("#shorthand-template-host");
    assert.equal(await absent(), 0);
    await page.keyboard.type("Sam");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#shorthand-template-host", { state: "detached" });
    assert.equal(await page.textContent("#ce"), "Hi Sam.");
    const filled = await rendered(page);
    assert.equal(filled.glyphs.length, 7, "Completed templates must animate the rendered answer, not their blank syntax");
    assert.equal(filled.mirror, filled.glyphs);
    await page.keyboard.press("Backspace");
    assert.equal(await page.textContent("#ce"), "hello/");
  });

  await t.test("a picker trigger change preserves the pending insertion's original undo text", async () => {
    for (const selector of ["#inp", "#ce"]) {
      await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ pickerTrigger: ";;" }));
      await fixture("expand");
      await page.click(selector);
      await page.keyboard.type(";;");
      await page.waitForSelector("#shorthand-picker-host");
      await page.keyboard.type("yg");
      await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ pickerTrigger: "##" }));
      await page.waitForTimeout(150);
      await page.keyboard.press("Enter");
      assert.equal(await contents(selector), "you got it");
      await page.keyboard.press("Backspace");
      assert.equal(await contents(selector), ";;", "Undo must restore the trigger that opened this picker, even after settings change");
    }
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ pickerTrigger: ";;" }));
  });

  await t.test("grapheme growth keeps emoji and combining characters whole", async () => {
    await playground(app, "expand");
    await page.keyboard.type("unicode/");
    await page.waitForSelector(CUE, { state: "detached", timeout: 2000 });
    const trace = await page.evaluate(() => window.animationTrace);
    const final = ENTRIES[2].expansion;
    assertCommitted(trace, final, "unicode/");
    assert.equal(trace.samples.at(-1).text, final);
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const permitted = new Set([...segmenter.segment("unicode/" + final)].map(({ segment }) => segment));
    for (const sample of trace.samples) {
      for (const { segment } of segmenter.segment(sample.text)) {
        assert.ok(permitted.has(segment), `Split grapheme ${JSON.stringify(segment)} in ${JSON.stringify(sample.text)}`);
      }
    }
  });

  await t.test("composition and programmatic edits immediately discard the visual mirror", async () => {
    await playground(app, "casino");
    await page.evaluate(() => {
      const editor = document.getElementById("tryit");
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      editor.value = "yg";
      editor.setSelectionRange(2, 2);
      editor.dispatchEvent(new InputEvent("input", { data: "g", isComposing: true, bubbles: true }));
    });
    assert.equal(await page.inputValue("#tryit"), "yg");
    assert.equal(await page.evaluate(() => window.animationTrace.added), 0);
    await page.evaluate(() => {
      const editor = document.getElementById("tryit");
      editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      editor.dispatchEvent(new InputEvent("input", { data: "g", bubbles: true }));
    });
    assert.equal(await page.inputValue("#tryit"), "you got it");
    assert.equal(await absent(), 1);
    await page.evaluate(() => document.getElementById("tryit").dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    assert.equal(await absent(), 0);
    await page.fill("#tryit", "");
    await page.keyboard.type("yg");
    assert.equal(await absent(), 1);
    await page.evaluate(() => { document.getElementById("tryit").value = "App updated draft"; });
    await page.waitForSelector(CUE, { state: "detached", timeout: 1000 });
    assert.equal(await page.inputValue("#tryit"), "App updated draft");
  });

  await t.test("Casino obeys initial and live reduced motion, and unsupported rich markup keeps safe feedback", async () => {
    await playground(app, "casino");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#tryit"), "you got it");
    assert.equal(await page.evaluate(() => window.animationTrace.added), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.fill("#tryit", "");
    await page.keyboard.type("yg");
    assert.equal(await absent(), 1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForSelector(CUE, { state: "detached", timeout: 1000 });
    await fixture("casino");
    await page.locator("#ce").evaluate((element) => {
      element.innerHTML = "<strong>Before:</strong>";
      element.focus();
      getSelection().collapse(element.firstChild.firstChild, 7);
    });
    await page.keyboard.type("yg");
    assert.equal(await contents("#ce"), "Before:you got it");
    assert.deepEqual(await rendered(page), { mirror: null, glyphs: null, background: null, frame: true }, "Complex rich markup must receive only the safe border effect");
  });

  await t.test("the glyph mirror works under strict CSP without policy violations", async () => {
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ animationMode: "expand" }));
    await page.goto(FIXTURE.replace("page.html", "strict-csp.html"));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.animationViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.animationViolations.push(event.violatedDirective));
    });
    await page.click("#inp");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "you got it");
    assert.ok((await rendered(page)).glyphs, "Strict CSP must allow the real animated glyph mirror");
    assert.deepEqual(await page.evaluate(() => window.animationViolations), []);
  });

  await t.test("CSS text masking never exposes plaintext in a glyph mirror", async () => {
    await fixture("expand");
    await page.locator("#inp").evaluate((element) => element.style.setProperty("-webkit-text-security", "disc"));
    assert.equal(await page.locator("#inp").evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-text-security")), "disc");
    await page.fill("#inp", "private prefix ");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "private prefix you got it");
    assert.deepEqual(await rendered(page), { mirror: null, glyphs: null, background: null, frame: true }, "A visually masked text input must never be copied into a plaintext overlay");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "private prefix yg");
  });

  await t.test("enabling CSS text masking immediately removes an existing plaintext mirror", async () => {
    await fixture("casino");
    await page.fill("#inp", "private prefix ");
    await page.keyboard.type("yg");
    assert.ok((await rendered(page)).mirror);
    const visible = await page.evaluate(async () => {
      document.getElementById("inp").style.setProperty("-webkit-text-security", "disc");
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return !!document.getElementById("actle-expansion-feedback");
    });
    assert.equal(visible, false, "Masking an active editor must clear plaintext before the next rendered frames");
    assert.equal(await page.inputValue("#inp"), "private prefix you got it");
  });

  await t.test("glyph mirrors preserve visible text fill and stroke when CSS color is transparent", async () => {
    await fixture("expand");
    await page.locator("#inp").evaluate((element) => {
      element.style.color = "transparent";
      element.style.backgroundColor = "#223344";
      element.style.setProperty("-webkit-text-fill-color", "white");
      element.style.setProperty("-webkit-text-stroke-width", "1px");
      element.style.setProperty("-webkit-text-stroke-color", "#a4bdff");
    });
    await page.click("#inp");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "you got it");
    const effect = await rendered(page);
    assert.ok(effect.glyphs);
    assert.deepEqual(effect.paint, {
      color: "rgba(0, 0, 0, 0)", fill: "rgb(255, 255, 255)",
      strokeWidth: "1px", strokeColor: "rgb(164, 189, 255)",
    }, "The animated letters must retain the editor's actual opaque paint");
  });

  await t.test("rounded clipping gets safe fallback while an inset field still animates", async () => {
    await fixture("expand");
    await page.locator("#inp").evaluate((element) => {
      const wrapper = document.createElement("div");
      wrapper.id = "rounded-wrapper";
      wrapper.style.cssText = "width:320px;height:64px;overflow:hidden;border-radius:30px;background:#223344";
      element.replaceWith(wrapper);
      wrapper.appendChild(element);
      element.style.cssText = "box-sizing:border-box;width:100%;height:64px;border:0;border-radius:0;padding:12px;background:#223344;color:white";
    });
    await page.click("#inp");
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "you got it");
    assert.deepEqual(await rendered(page), { mirror: null, glyphs: null, background: null, frame: true }, "The overlay must not paint over a rounded clipping ancestor");
    await page.fill("#inp", "");
    await page.evaluate(() => { document.getElementById("rounded-wrapper").style.padding = "32px"; });
    await page.keyboard.type("yg");
    assert.equal(await page.inputValue("#inp"), "you got it");
    assert.ok((await rendered(page)).glyphs, "A field fully inset beyond the rounded corners should retain glyph animation");
  });

  await t.test("overflowing native inputs keep a visible outline without an inaccurate opaque mirror", async () => {
    await fixture("expand");
    const prefix = "Earlier text. ".repeat(7) + "Reply: ";
    const suffix = " ending.";
    await page.locator("#inp").evaluate(async (element, { prefix, suffix }) => {
      element.style.cssText = "box-sizing:border-box;width:254px;padding:14px;border:1px solid #999;font:16px/1.6 system-ui,sans-serif";
      element.value = prefix + "y" + suffix;
      element.focus();
      element.setSelectionRange(prefix.length + 1, prefix.length + 1);
      element.scrollLeft = element.scrollWidth;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      window.nativeAnimationScrolls = [];
      element.addEventListener("scroll", (event) => window.nativeAnimationScrolls.push({ trusted: event.isTrusted, value: element.value }));
    }, { prefix, suffix });
    await page.keyboard.type("g");
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    const expected = prefix + "you got it" + suffix;
    assert.equal(await page.inputValue("#inp"), expected);
    assert.ok(await page.evaluate((expected) => window.nativeAnimationScrolls.some((event) => event.trusted && event.value === expected), expected), "The browser must have delivered the queued native scroll caused by insertion");
    const effect = await rendered(page, true);
    assert.equal(effect.mirror, null, "Scrolled native input text must remain visible instead of being covered by an inaccurate mirror");
    assert.equal(effect.glyphs, null);
    assert.equal(effect.background, null);
    assert.equal(effect.frame, true);
    assert.ok(effect.outline.opacity > 0 && effect.outline.width > 0 && effect.outline.height > 0, "The native caret scroll must preserve a visible outline");
    assert.equal(effect.outline.border, "rgb(35, 87, 215)");
    assert.deepEqual(await page.locator("#inp").evaluate((element) => [element.selectionStart, element.selectionEnd]), [prefix.length + 10, prefix.length + 10]);
    const visible = await page.evaluate(async () => {
      document.getElementById("inp").scrollLeft = 0;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return !!document.getElementById("actle-expansion-feedback");
    });
    assert.equal(visible, false, "A later scroll that actually moves the text must remove the overlay");
    assert.equal(await page.inputValue("#inp"), expected);

    await fixture("expand");
    const longSuffix = " ending.".repeat(12);
    await page.locator("#inp").evaluate(async (element, suffix) => {
      element.style.cssText = "box-sizing:border-box;width:254px;padding:14px;border:1px solid #999;font:16px/1.6 system-ui,sans-serif";
      element.value = "y" + suffix;
      element.focus();
      element.setSelectionRange(1, 1);
      element.scrollLeft = 0;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, longSuffix);
    await page.keyboard.type("g");
    assert.equal(await page.inputValue("#inp"), "you got it" + longSuffix);
    const native = await page.locator("#inp").evaluate((element) => ({ left: element.scrollLeft, overflowing: element.scrollWidth > element.clientWidth, caret: [element.selectionStart, element.selectionEnd] }));
    assert.deepEqual(native, { left: 0, overflowing: true, caret: [10, 10] }, "The long-suffix case must reach overflow with an unscrolled caret");
    assert.deepEqual(await rendered(page), { mirror: null, glyphs: null, background: null, frame: true }, "Overflow at scrollLeft zero must also preserve the native input rendering");
  });
  assert.deepEqual(app.errors, []);
});
