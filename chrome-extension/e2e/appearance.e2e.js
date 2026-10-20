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

// The Writing pad's Suggestions panel with a shortcut idea and a fill-in
// template on screen.
const SUGGEST_LETTER = "Hi Sam,\n\nThanks for the call on Tuesday. As you can see in the attached plan, the kickoff is on "
  + "October 28, 2026 at 3:30 pm, and the deposit of $1,200.50 is due by then. Please send questions to support@example.com.\n\nBest regards,\nAlex";

async function openSuggestingPad(app, theme, width, height = 900, letter = SUGGEST_LETTER) {
  const seed = await app.context.newPage();
  await seed.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
  await seed.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
  await seed.evaluate(async (body) => {
    const store = self.ActlePadStore;
    await store.createDraft({ title: "Launch notes", body: "As you can see, the numbers are up. As you can see, retention held. As you can see, we are on time." });
    const draft = await store.createDraft({ title: "Follow up with Sam", body });
    await store.savePrefs({ lastDraftId: draft.id });
  }, letter);
  await seed.close();
  const page = await app.context.newPage();
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
  await page.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
  await page.waitForSelector(".template-card");
  await page.waitForSelector('.suggest-card[data-phrase="as you can see"]');
  return page;
}

for (const theme of ["light", "dark"]) {
  test(`writing pad suggestions are readable in the ${theme} theme`, async (t) => {
    const app = await launch();
    t.after(() => app.close());
    const page = await openSuggestingPad(app, theme, 1280);
    await page.evaluate(() => self.ActlePadStore.dismissPhrase("a phrase not to suggest"));
    await page.waitForSelector("#padDismissed:not([hidden])");
    // One chip left as written, so both chip states are measured.
    await page.locator(".blank-chip").nth(1).click();
    await page.mouse.move(0, 0);
    await assertReadable(page, ".suggest-eyebrow, .suggest-text, .suggest-phrase, .suggest-title, .suggest-hint, .suggest-label, .suggest-note, .blank-value, #padDismissedText, .pad-side button");
    assert.deepEqual(await page.locator(".blank-chip").evaluateAll((all) => all.map((chip) => chip.getAttribute("aria-pressed"))).then((states) => [...new Set(states)].sort()), ["false", "true"]);
    await assertKeyboardFocus(page, ".blank-chip >> nth=0", "Tab", ".blank-chip >> nth=1");
    await assertKeyboardFocus(page, "#suggestToggle", "Tab", '.suggest-card[data-phrase="as you can see"] .suggest-trigger');

    await page.fill('.suggest-card[data-phrase="as you can see"] .suggest-trigger', "cool/");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".suggest-msg.error");
    await assertReadable(page, ".suggest-msg.error");
    await page.fill('.suggest-card[data-phrase="as you can see"] .suggest-trigger', "aycs/");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent.startsWith("Saved aycs/"));
    await assertReadable(page, ".suggest-notice, .suggest-notice a");

    await page.click("#newDraftBtn");
    await page.waitForSelector(".suggest-empty", { state: "visible" });
    await assertReadable(page, ".suggest-empty p");
  });
}

test("on wide screens long suggestions scroll in their own column", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestingPad(app, "light", 1280, 720);
  const layout = await page.evaluate(() => {
    const side = document.querySelector(".pad-side");
    return {
      page: [document.documentElement.scrollHeight, innerHeight],
      side: [side.scrollHeight, side.clientHeight],
      trash: document.getElementById("padTrashSummary").getBoundingClientRect().bottom,
    };
  });
  assert.ok(layout.page[0] <= layout.page[1], `The page must not grow past the window: ${JSON.stringify(layout)}`);
  assert.ok(layout.side[0] > layout.side[1], `The suggestions column scrolls instead: ${JSON.stringify(layout)}`);
  assert.ok(layout.trash <= 720, `Recently deleted drafts stays in view: ${JSON.stringify(layout)}`);
});

// Where the pad's columns and the editor's actions sit in a wide window.
function padLayout(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), middle: Math.round((rect.top + rect.bottom) / 2) };
    };
    return {
      window: innerHeight,
      page: document.documentElement.scrollHeight,
      trash: box("#padTrashSummary"),
      actions: box(".pad-actions"),
      railHead: box(".rail-head"),
      railTitle: box(".rail-title"),
      sideTitle: box(".side-title"),
      editorTitle: box("#padTitle"),
      railRule: box(".draft-list"),
      sideRule: box(".toggle-row"),
    };
  });
}

test("on wide screens a long drafts list scrolls in its own column", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const seed = await app.context.newPage();
  await seed.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
  await seed.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
  await seed.evaluate(async () => {
    for (let i = 1; i <= 20; i++) await self.ActlePadStore.createDraft({ title: "Draft " + i, body: "Words " + i });
  });
  await seed.close();
  for (const [width, height] of [[1280, 900], [1366, 768], [1100, 720]]) {
    const page = await app.context.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
    await page.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
    const layout = await padLayout(page);
    const at = `${width}x${height}: ${JSON.stringify(layout)}`;
    assert.ok(layout.page <= layout.window, `The page must not grow past the window at ${at}`);
    assert.ok(layout.trash.bottom <= layout.window, `Recently deleted drafts stays in view at ${at}`);
    assert.ok(layout.actions.bottom <= layout.window, `The editor's actions stay in view at ${at}`);
    assert.equal(await page.locator(".draft-list").evaluate((list) => list.scrollHeight > list.clientHeight), true, `The list scrolls at ${at}`);
    // Quiet Grid: the column headings share a line, and so do the first rules.
    assert.ok(Math.abs(layout.railTitle.middle - layout.sideTitle.middle) <= 1, `Drafts and Suggestions line up at ${at}`);
    assert.equal(layout.railRule.top, layout.sideRule.top, `The first rules line up at ${at}`);
    assert.equal(layout.editorTitle.top, layout.railHead.top, `The editor starts on the columns' top line at ${at}`);
    await page.close();
  }
});

test("the read-only notice keeps the editor's actions in view", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const first = await app.context.newPage();
  await first.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
  await first.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
  await first.evaluate(async () => {
    const draft = await self.ActlePadStore.createDraft({ title: "Shared", body: "Open in two tabs" });
    await self.ActlePadStore.savePrefs({ lastDraftId: draft.id });
  });
  await first.reload();
  await first.waitForFunction(() => document.getElementById("padTitle").value === "Shared");
  for (const [width, height] of [[1100, 720], [1280, 720], [1366, 768], [1440, 900]]) {
    const page = await app.context.newPage();
    await page.setViewportSize({ width, height });
    await page.goto(`chrome-extension://${app.extensionId}/src/pad.html`);
    await page.waitForSelector("#padLockNotice:not([hidden])");
    const layout = await padLayout(page);
    assert.ok(layout.actions.bottom <= layout.window && layout.page <= layout.window, `Actions in view at ${width}x${height}: ${JSON.stringify(layout)}`);
    await page.close();
  }
});

test("narrow pads put the drafts list box first in the tab order, as on screen", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openFilledPad(app, "light", 980);
  const boxes = await page.evaluate(() => ["draftSelect", "newDraftBtn"].map((id) => document.getElementById(id).getBoundingClientRect().left));
  assert.ok(boxes[0] < boxes[1], "the list box is left of New draft");
  await assertKeyboardFocus(page, ".pad-library-link", "Tab", "#draftSelect");
  await assertKeyboardFocus(page, "#draftSelect", "Tab", "#newDraftBtn");
});

test("the library sidebar scrolls when the window is too short for its links", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await app.context.newPage();
  await page.setViewportSize({ width: 980, height: 430 });
  await page.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  await page.waitForSelector("#list tbody tr");
  const link = page.locator(".sidebar-nav a", { hasText: "Writing pad" });
  await link.focus();
  const rect = await link.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, window: innerHeight };
  });
  assert.ok(rect.top >= 0 && rect.bottom <= rect.window, `The last link can be reached: ${JSON.stringify(rect)}`);
});

test("the 320px writing pad keeps suggestion cards and their controls on screen", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const letter = "Hi Bartholomew-Alexander,\n\nThe full report is at https://example.com/reports/2026/quarterly/without-any-breaks/"
    + "keeps-going-and-going?with=query&and=more and the contact is a.very.long.address.without.breaks@example-company-name.com, "
    + "so please check it before October 28, 2026 at 3:30 pm and confirm the amount of $1,200.50 for order #123456789.\n\nBest regards,\nAlex";
  const page = await openSuggestingPad(app, "light", 320, 640, letter);
  // Chips left as written show their long values.
  await page.locator(".blank-chip", { hasText: /^link$/ }).click();
  await page.locator(".blank-chip", { hasText: /^email$/ }).click();
  assert.equal(await page.locator('.blank-chip[aria-pressed="false"]').count(), 2);
  const chips = await page.locator(".template-preview, .blank-chip").evaluateAll((all) => all.map((element) =>
    ({ text: element.textContent.slice(0, 40), scroll: element.scrollWidth, width: element.clientWidth })));
  for (const chip of chips) assert.ok(chip.scroll <= chip.width, `Long values wrap inside the preview: ${JSON.stringify(chip)}`);
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    boxes: [...document.querySelectorAll(".pad-side button, .pad-side input, .template-preview")]
      .filter((element) => element.getClientRects().length)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { name: element.textContent || element.value || element.className, left: rect.left, right: rect.right };
      }),
  }));
  assert.ok(geometry.width <= geometry.viewport, `Writing pad overflows: ${JSON.stringify(geometry)}`);
  for (const box of geometry.boxes) {
    assert.ok(box.left >= 0 && box.right <= geometry.viewport, `Suggestion controls must be reachable without horizontal scrolling: ${JSON.stringify(box)}`);
  }
});
