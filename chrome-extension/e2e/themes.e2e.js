// The Style setting: every look stays readable on the real extension pages,
// a choice saves and survives reload, and open overlays follow a change.
const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");
const { assertReadable } = require("./contrast.js");
const { THEMES } = require("../src/themes.js");

const ENTRIES = [
  { trigger: "thx/", expansion: "Thanks for reaching out about your order." },
  { trigger: "ship/", expansion: "Your parcel ships tomorrow." },
  { trigger: "hello/", expansion: "Hello [[name]]" },
];

async function openPage(app, name, scheme, width) {
  const page = await app.context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`chrome-extension://${app.extensionId}/src/${name}.html`);
  await page.waitForSelector(name === "options" ? "#list tbody tr" : ".result");
  return { page, errors };
}

// The suggestion list lives in a closed shadow root; keep a handle to it from
// the playground page, where the content script shares the page's prototypes.
function observeSuggestions() {
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (options) {
    const root = original.call(this, options);
    if (this.id === "actle-suggestions-host") window.suggestionRoot = root;
    return root;
  };
}

function panelStyle(page) {
  return page.evaluate(() => {
    const panel = window.suggestionRoot && window.suggestionRoot.querySelector(".panel");
    if (!panel || !panel.isConnected) return null;
    const style = getComputedStyle(panel);
    return { radius: style.borderTopLeftRadius, background: style.backgroundColor, font: style.fontFamily };
  });
}

test("every style keeps library and toolbar text readable in light and dark", async (t) => {
  const app = await launch({ shorthands: ENTRIES });
  t.after(() => app.close());
  for (const theme of THEMES) {
    await app.worker.evaluate((id) => self.ShorthandStorage.saveSettings({ theme: id }), theme.id);
    for (const scheme of ["light", "dark"]) {
      await t.test(`${theme.name}, ${scheme}`, async () => {
        const options = await openPage(app, "options", scheme, 980);
        await options.page.waitForFunction((id) => document.documentElement.dataset.actleTheme === id, theme.id);
        assert.equal(await options.page.inputValue("#theme"), theme.id);
        await options.page.fill("#expansion", "Hello [[name]]");
        await assertReadable(options.page, "#saveBtn, #importBtn, .hint, small, .eyebrow, button.secondary, button.danger, .sidebar-note, .sidebar-note-label, .sidebar-nav a, .brand-subtitle, .actle-brand, .actle-brand__completion, .field-chip, #templateFieldCount, .template-badge, .library-note, td.trigger, #themeHint");
        assert.deepEqual(options.errors, []);
        await options.page.close();

        const popup = await openPage(app, "popup", scheme, 360);
        await popup.page.waitForFunction((id) => document.documentElement.dataset.actleTheme === id, theme.id);
        assert.equal(await popup.page.inputValue("#theme"), theme.id);
        await assertReadable(popup.page, ".status, .trigger, .copy, .expansion, .sub, .muted, .key, button.link, #themeNote");
        assert.deepEqual(popup.errors, []);
        await popup.page.close();
      });
    }
  }
});

test("choosing a style saves it, restyles the library and keeps other settings", async (t) => {
  const app = await launch({ shorthands: ENTRIES });
  t.after(() => app.close());
  const legacySettings = { enabled: false, excludedHosts: ["example.com"], pickerTrigger: "//", retained: "keep" };
  await app.worker.evaluate((settings) => chrome.storage.sync.set({ settings }), legacySettings);
  const original = await app.worker.evaluate(() => chrome.storage.sync.get(null));
  const { page, errors } = await openPage(app, "options", "light", 1280);

  assert.equal(await page.getByLabel("Style", { exact: true }).count(), 1);
  assert.deepEqual(await page.locator("#theme option").evaluateAll((options) =>
    options.map((option) => [option.value, option.textContent])), THEMES.map((theme) => [theme.id, theme.name]));
  assert.equal(await page.inputValue("#theme"), "classic", "a library without a saved style shows Classic");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".card")).borderTopLeftRadius), "20px");
  assert.deepEqual(await app.worker.evaluate(() => chrome.storage.sync.get(null)), original, "showing Classic writes nothing");

  await page.locator("#theme").focus();
  await page.selectOption("#theme", "swiss");
  await page.waitForFunction(() => document.getElementById("themeMsg").textContent === "Style saved: Swiss Grid.");
  assert.equal(await page.evaluate(() => document.activeElement.id), "theme");
  assert.deepEqual(await app.worker.evaluate(() => chrome.storage.sync.get(null)),
    { ...original, settings: { ...legacySettings, animationMode: "expand", suggestionsEnabled: true, theme: "swiss" } });
  const swiss = await page.evaluate(() => ({
    theme: document.documentElement.dataset.actleTheme,
    radius: getComputedStyle(document.querySelector(".card")).borderTopLeftRadius,
    font: getComputedStyle(document.body).fontFamily,
    hint: document.getElementById("themeHint").textContent,
  }));
  assert.equal(swiss.theme, "swiss");
  assert.equal(swiss.radius, "0px");
  assert.match(swiss.font, /^"?Archivo"?, "Helvetica Neue"/);
  assert.match(swiss.hint, /^Black on white/);

  await page.reload();
  await page.waitForSelector("#list tbody tr");
  assert.equal(await page.inputValue("#theme"), "swiss");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".card")).borderTopLeftRadius), "0px");

  // Back to Classic restores the built-in look exactly.
  await page.selectOption("#theme", "classic");
  await page.waitForFunction(() => document.getElementById("themeMsg").textContent === "Style saved: Classic.");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".card")).borderTopLeftRadius), "20px");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".sidebar")).backgroundColor), "rgb(16, 33, 61)");
  assert.deepEqual(errors, []);
});

test("a failed style save restores the saved style with a visible error", async (t) => {
  const app = await launch({ shorthands: ENTRIES, settings: { theme: "paper" } });
  t.after(() => app.close());
  const { page, errors } = await openPage(app, "options", "light", 1280);
  await page.waitForFunction(() => document.documentElement.dataset.actleTheme === "paper");
  const before = await app.worker.evaluate(() => chrome.storage.sync.get(null));
  await page.evaluate(() => {
    self.ShorthandStorage.saveSettings = () => new Promise((_resolve, reject) => {
      self.rejectThemeSave = () => reject(new Error("Test storage write rejected"));
    });
  });
  await page.locator("#theme").focus();
  await page.selectOption("#theme", "pro");
  assert.equal(await page.locator("#theme").isDisabled(), true);
  assert.equal(await page.textContent("#themeMsg"), "Saving style…");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.actleTheme), "pro", "the choice shows while saving");
  await page.evaluate(() => self.rejectThemeSave());
  await page.waitForFunction(() => document.getElementById("themeMsg").classList.contains("error"));
  assert.equal(await page.textContent("#themeMsg"), "Could not save style: Test storage write rejected. Previous style kept.");
  assert.equal(await page.inputValue("#theme"), "paper");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.actleTheme), "paper");
  assert.equal(await page.locator("#theme").isEnabled(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "theme");
  assert.deepEqual(await app.worker.evaluate(() => chrome.storage.sync.get(null)), before);
  assert.deepEqual(errors, []);
});

test("the toolbar popup switches styles and suggestions on an open page follow", async (t) => {
  const app = await launch({ shorthands: ENTRIES });
  t.after(() => app.close());
  const { page: library, errors } = await openPage(app, "options", "light", 1280);
  // Any page scroll closes suggestions. Taller than the page, the playground
  // needs no scrolling, so a late layout change cannot close the list.
  await library.setViewportSize({ width: 1280, height: 3000 });
  assert.ok(await library.evaluate(() => document.documentElement.scrollHeight <= innerHeight));
  await library.evaluate(observeSuggestions);
  await library.locator("#tryit").click();
  await library.keyboard.type("th");
  await library.waitForFunction(() => window.suggestionRoot && window.suggestionRoot.querySelector(".item")
    && window.suggestionRoot.querySelector(".panel").isConnected);
  const classic = await panelStyle(library);
  assert.equal(classic.radius, "12px");
  assert.equal(classic.background, "rgb(255, 255, 255)");

  const { page: popup, errors: popupErrors } = await openPage(app, "popup", "light", 360);
  await popup.selectOption("#theme", "playful");
  await popup.waitForFunction(() => document.documentElement.dataset.actleTheme === "playful");
  await popup.waitForFunction(() => document.getElementById("toast").textContent === "Style: Bright Playful");
  assert.equal(await app.worker.evaluate(async () => (await chrome.storage.sync.get("settings")).settings.theme), "playful");

  // A settings change closes the list; reopened in the same shadow root, it
  // uses the new style. Bright Playful overlays are a dark violet bubble.
  await library.waitForFunction(() => document.documentElement.dataset.actleTheme === "playful");
  await library.locator("#tryit").fill("");
  await library.locator("#tryit").focus();
  await library.keyboard.type("sh");
  await library.waitForFunction(() => {
    const panel = window.suggestionRoot && window.suggestionRoot.querySelector(".panel");
    return panel && getComputedStyle(panel).backgroundColor === "rgb(36, 21, 65)";
  });
  const playful = await panelStyle(library);
  assert.equal(playful.radius, "14px");
  assert.match(playful.font, /Nunito/);
  assert.deepEqual(errors, []);
  assert.deepEqual(popupErrors, []);
});
