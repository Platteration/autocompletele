// Measure the rendered extension pages, including user-created text and both
// system themes. These checks intentionally do not depend on palette values.
const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

async function openPage(app, name, theme, width = 980) {
  const page = await app.context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`chrome-extension://${app.extensionId}/src/${name}.html`);
  await page.waitForSelector(name === "options" ? "#list tbody tr" : ".result");
  return page;
}

// Composite transparent ancestor backgrounds before applying the WCAG formula.
// Canvas normalizes computed rgb(), rgba(), and color() syntax to sRGB bytes.
async function textContrast(page, selector) {
  return page.locator(selector).evaluateAll((elements) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    function rgba(value) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const bytes = [...context.getImageData(0, 0, 1, 1).data];
      return [bytes[0], bytes[1], bytes[2], bytes[3] / 255];
    }
    function over(front, back) {
      return front.slice(0, 3).map((component, i) => component * front[3] + back[i] * (1 - front[3]));
    }
    function luminance(color) {
      const linear = color.map((component) => {
        const value = component / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    }
    return elements.filter((element) => element.getClientRects().length && element.textContent.trim()).map((element) => {
      const ancestors = [];
      for (let current = element; current; current = current.parentElement) ancestors.unshift(current);
      let background = [255, 255, 255];
      for (const ancestor of ancestors) background = over(rgba(getComputedStyle(ancestor).backgroundColor), background);
      const foreground = over(rgba(getComputedStyle(element).color), background);
      const light = luminance(foreground);
      const dark = luminance(background);
      return { text: element.textContent.trim().slice(0, 70), ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
    });
  });
}

async function assertReadable(page, selector) {
  const samples = await textContrast(page, selector);
  assert.ok(samples.length, `Expected visible text for ${selector}`);
  const failures = samples.filter(({ ratio }) => ratio < 4.5);
  assert.deepEqual(failures, [], `Text must meet 4.5:1 contrast: ${JSON.stringify(failures)}`);
}

async function assertKeyboardFocus(page, from, key, target) {
  const before = await page.locator(target).evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow, style.borderColor];
  });
  await page.locator(from).focus();
  await page.keyboard.press(key);
  const focused = await page.locator(target).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      active: document.activeElement === element,
      visible: element.matches(":focus-visible"),
      outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0,
      style: [style.outlineStyle, style.outlineWidth, style.outlineColor, style.boxShadow, style.borderColor],
    };
  });
  assert.ok(focused.active && focused.visible, `${target} should receive keyboard-visible focus`);
  assert.notDeepEqual(focused.style, before, `${target} needs a visible focus indicator`);
  assert.ok(focused.outline || focused.style[3] !== before[3] || focused.style[4] !== before[4], `${target} needs an outline, shadow, or border focus indicator`);
}

for (const theme of ["light", "dark"]) {
  test(`options text is readable in the ${theme} theme`, async (t) => {
    const app = await launch({ shorthands: [
      { trigger: "sig", expansion: "Alex" },
      { trigger: "sig/", expansion: "Regards, Alex" },
      { trigger: "hello/", expansion: "Hello [[name]]" },
    ] });
    t.after(() => app.close());
    const page = await openPage(app, "options", theme);
    await page.fill("#expansion", "Hello [[name]]");
    await assertReadable(page, "#saveBtn, #importBtn, .hint, small, th, .warning, .eyebrow, button.secondary, button.danger, .sidebar-note, .sidebar-note-label, .sidebar-nav a, .brand-subtitle, .actle-brand, .actle-brand__completion, .field-chip, #templateFieldCount, .template-badge, .library-note");
    await page.fill("#trigger", "sig/");
    await page.fill("#expansion", "Duplicate trigger");
    await page.click("#saveBtn");
    await page.waitForSelector("#formMsg.error");
    await assertReadable(page, "#formMsg.error");
  });

  test(`toolbar text is readable in the ${theme} theme`, async (t) => {
    const app = await launch();
    t.after(() => app.close());
    const page = await openPage(app, "popup", theme, 360);
    await assertReadable(page, ".status, .trigger, .copy, .expansion, .sub, .muted, .key, button.link");
    await page.locator("#enabled").uncheck();
    await page.waitForFunction(() => document.getElementById("status").textContent === "Paused");
    await assertReadable(page, ".status");
    await page.fill("#search", "no-matching-shorthand");
    await page.waitForSelector(".empty");
    await assertReadable(page, ".empty");
  });

  test(`keyboard focus is visible in the ${theme} theme`, async (t) => {
    const app = await launch();
    t.after(() => app.close());
    const options = await openPage(app, "options", theme);
    // Library rows precede the editor, and the blank builder sits between the
    // script and Save. Verify the complete new keyboard path, not the old layout.
    await assertKeyboardFocus(options, "#search", "Tab", "#list tbody tr:first-child button.secondary");
    await assertKeyboardFocus(options, "#expansion", "Tab", "#fieldName");
    await assertKeyboardFocus(options, "#fieldName", "Tab", "#addFieldBtn");
    await assertKeyboardFocus(options, "#addFieldBtn", "Tab", "#variableToken");
    await assertKeyboardFocus(options, "#variableToken", "Tab", "#addVariableBtn");
    await assertKeyboardFocus(options, "#addVariableBtn", "Tab", "#saveBtn");
    await options.fill("#expansion", "Hello [[name]]");
    await assertKeyboardFocus(options, "#addFieldBtn", "Tab", "#repeatFieldButtons button");
    await assertKeyboardFocus(options, "#repeatFieldButtons button", "Tab", "#variableToken");
    const popup = await openPage(app, "popup", theme, 360);
    await assertKeyboardFocus(popup, "#search", "ArrowDown", ".result:first-child");
  });
}

const longEntry = { trigger: "long-trigger-".repeat(16) + "/", expansion: "LongExpansionWithoutSpaces".repeat(30) };

test("the 320px options layout keeps long entries and their actions on screen", async (t) => {
  const app = await launch({ shorthands: [longEntry] });
  t.after(() => app.close());
  const page = await openPage(app, "options", "light", 320);
  assert.equal(await page.getByRole("table").count(), 1, "Responsive layout must preserve the library table role");
  assert.equal(await page.getByRole("row").count(), 2, "Header and entry remain accessible rows");
  assert.equal(await page.getByRole("cell").count(), 3, "Entry content and actions remain accessible cells");
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    cells: [...document.querySelectorAll("#list td, #list button")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { name: element.className || element.tagName, left: rect.left, right: rect.right };
    }),
  }));
  assert.ok(geometry.width <= geometry.viewport, `Options page overflows: ${JSON.stringify(geometry)}`);
  for (const rect of geometry.cells) {
    assert.ok(rect.left >= 0 && rect.right <= geometry.viewport, `Library content must be reachable without horizontal scrolling: ${JSON.stringify(rect)}`);
  }
});

test("long toolbar results preserve the copy affordance inside the popup", async (t) => {
  const app = await launch({ shorthands: [longEntry] });
  t.after(() => app.close());
  const page = await openPage(app, "popup", "light", 360);
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const { left, right, width } = document.querySelector(selector).getBoundingClientRect();
      return { left, right, width };
    };
    return {
      viewport: document.documentElement.clientWidth,
      width: document.documentElement.scrollWidth,
      result: rect(".result"), copy: rect(".copy"), trigger: rect(".trigger"),
      scrollWidth: document.getElementById("results").scrollWidth,
      clientWidth: document.getElementById("results").clientWidth,
    };
  });
  assert.ok(geometry.width <= geometry.viewport, `Popup page overflows: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.scrollWidth <= geometry.clientWidth, `Results must not require horizontal scrolling: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.copy.width > 0 && geometry.copy.right <= geometry.result.right, `Copy affordance must remain visible: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.trigger.right <= geometry.copy.left, `Long triggers must not overlap Copy: ${JSON.stringify(geometry)}`);
});

// The Writing pad, with drafts, a deleted draft, a status message and the
// read-only notice on screen, so every kind of text is measured.
async function openFilledPad(app, theme, width) {
  const seed = await app.context.newPage();
  await seed.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
  await seed.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
  await seed.evaluate(async () => {
    const store = self.ActlePadStore;
    await store.createDraft({ title: "Notes", body: "Agenda for Monday" });
    const gone = await store.createDraft({ title: "Old idea", body: "No longer needed" });
    await store.deleteDraft(gone.id);
    const letter = await store.createDraft({ title: "Reply to Sam", body: "Hi Sam,\n\nThanks for the plan." });
    await store.savePrefs({ lastDraftId: letter.id });
  });
  await seed.close();
  const page = await app.context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
  await page.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
  await page.click("#padTrashSummary");
  return page;
}

for (const theme of ["light", "dark"]) {
  test(`writing pad text and focus are readable in the ${theme} theme`, async (t) => {
    const app = await launch();
    t.after(() => app.close());
    const page = await openFilledPad(app, theme, 1280);
    await assertReadable(page, ".pad-tagline, .pad-library-link, .rail-title, .count-pill, .draft-title, .draft-meta, .new-draft, .trash summary, .trash-note, .trash-title, .trash-preview, .trash-time, .save-state, .pad-words, .side-title, .toggle-row strong, .toggle-row small, button.secondary, button.danger");
    await page.click("#copyBtn");
    await page.waitForSelector("#padMsg:not(:empty)");
    await assertReadable(page, ".pad-msg");
    // A failed save is the message that matters most.
    await page.evaluate(() => { chrome.storage.local.set = () => Promise.reject(new Error("QUOTA_BYTES quota exceeded")); });
    await page.click("#padBody");
    await page.keyboard.type(" More");
    await page.waitForSelector("#padSave.error");
    await assertReadable(page, "#padSave.error");
    await assertKeyboardFocus(page, "#newDraftBtn", "Tab", ".draft-item[aria-current]");
    await assertKeyboardFocus(page, "#padBody", "Tab", "#copyBtn");
    const other = await app.context.newPage();
    await other.emulateMedia({ colorScheme: theme });
    await other.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
    await other.waitForSelector("#padLockNotice:not([hidden])");
    await assertReadable(other, "#padLockText, #padTakeOver");
    await assertKeyboardFocus(other, "#padTitle", "Shift+Tab", "#padTakeOver");
  });
}

test("the 320px writing pad keeps long drafts and every action on screen", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openFilledPad(app, "light", 320);
  await page.fill("#padTitle", "LongTitleWithoutSpaces".repeat(12));
  await page.fill("#padBody", "LongWordWithoutSpaces".repeat(40));
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    boxes: [...document.querySelectorAll("button, select, input, textarea, .pad-library-link, .trash summary")]
      .filter((element) => element.getClientRects().length)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { name: element.id || element.className || element.tagName, left: rect.left, right: rect.right };
      }),
  }));
  assert.ok(geometry.width <= geometry.viewport, `Writing pad overflows: ${JSON.stringify(geometry)}`);
  for (const box of geometry.boxes) {
    assert.ok(box.left >= 0 && box.right <= geometry.viewport, `Pad controls must be reachable without horizontal scrolling: ${JSON.stringify(box)}`);
  }
  assert.equal(await page.isVisible("#draftSelect"), true, "narrow screens choose drafts from a list box");
  assert.equal(await page.isVisible("#draftList"), false);
});
