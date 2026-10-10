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
    await assertReadable(page, "#saveBtn, #importBtn, .hint, small, th, .warning, .eyebrow, button.secondary, button.danger, .sidebar-note, .sidebar-note-label, .sidebar-nav a, .brand-subtitle, .field-chip, #templateFieldCount, .template-badge, .library-note");
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
    await assertKeyboardFocus(options, "#addFieldBtn", "Tab", "#saveBtn");
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
