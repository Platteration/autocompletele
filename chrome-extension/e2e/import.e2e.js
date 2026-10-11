const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

async function openOptions(app) {
  const page = await app.context.newPage();
  page.on("pageerror", (error) => app.errors.push(String(error)));
  await page.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  await page.waitForSelector("#list tbody tr");
  return page;
}

async function preview(page, shorthands) {
  await page.setInputFiles("#importFile", {
    name: "shorthands.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ version: 1, shorthands })),
  });
  await page.waitForSelector("#importPreview", { state: "visible" });
}

const readStorage = (app) => app.worker.evaluate(() => chrome.storage.sync.get(null));

test("an oversized import keeps saved snippets and imports the good entries with a lasting warning", async (t) => {
  const app = await launch({ shorthands: [
    { trigger: "local/", expansion: "Keep this local snippet" },
    { trigger: "sig/", expansion: "Original signature" },
  ], settings: { enabled: false } });
  t.after(() => app.close());
  const page = await openOptions(app);
  const before = await readStorage(app);
  await preview(page, [
    { trigger: "sig/", expansion: "x".repeat(9000) },
    { trigger: "good/", expansion: "This entry fits" },
  ]);
  await page.click("#replaceBtn");
  await page.waitForFunction(() => document.getElementById("ioMsg").textContent.length > 0);
  const after = await readStorage(app);
  for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value);
  const warning = await page.textContent("#ioMsg");
  assert.equal(warning, "Skipped 1 shorthand(s) that exceed Chrome sync limits. Entries that fit were merged; existing snippets were retained. sig/: sync per-item limit");
  assert.equal(Object.values(after).some((item) => item.trigger === "good/" && item.expansion === "This entry fits"), true);
  assert.equal(await page.locator("#list tbody tr").count(), 3);
  // Warnings about incomplete restores must not disappear after the normal
  // four-second success-toast timeout, before the user can inspect them.
  await page.waitForTimeout(4200);
  assert.equal(await page.textContent("#ioMsg"), warning);
  await page.reload();
  await page.waitForSelector("#list tbody tr");
  assert.equal(await page.locator("#list tbody tr").count(), 3);
  assert.deepEqual(app.errors, []);
});

test("successful merge preserves local entries and replacement removes only superseded snippets", async (t) => {
  const app = await launch({ shorthands: [
    { trigger: "local/", expansion: "Keep this local snippet" },
    { trigger: "sig/", expansion: "Original signature" },
  ], settings: { enabled: false } });
  t.after(() => app.close());
  const page = await openOptions(app);
  const before = await readStorage(app);
  await preview(page, [
    { trigger: "sig/", expansion: "Updated signature" },
    { trigger: "new/", expansion: "New snippet" },
  ]);
  await page.click("#mergeBtn");
  await page.waitForFunction(() => document.getElementById("ioMsg").textContent.startsWith("Merged 2"));
  let after = await readStorage(app);
  for (const [key, value] of Object.entries(before)) {
    assert.deepEqual(after[key], value.trigger === "sig/" ? { ...value, expansion: "Updated signature" } : value);
  }
  assert.equal(Object.keys(after).filter((key) => key.startsWith("sh:")).length, 3);

  await preview(page, [{ trigger: "replacement/", expansion: "Replacement snippet" }]);
  await page.click("#replaceBtn");
  await page.waitForFunction(() => document.getElementById("ioMsg").textContent.startsWith("Replaced your library with 1"));
  after = await readStorage(app);
  const snippets = Object.entries(after).filter(([key]) => key.startsWith("sh:"));
  assert.equal(snippets.length, 1);
  assert.deepEqual(snippets[0][1], { trigger: "replacement/", expansion: "Replacement snippet", order: 0 });
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(app.errors, []);
});

test("invalid and duplicate import items are skipped with visible counts", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "local/", expansion: "Keep me" }] });
  t.after(() => app.close());
  const page = await openOptions(app);
  await preview(page, [
    null,
    { trigger: "good/", expansion: "First value wins" },
    { trigger: "good/", expansion: "Duplicate" },
    { trigger: "   ", expansion: "Missing trigger" },
  ]);
  assert.match(await page.textContent("#importSummary"), /3 invalid or duplicate item\(s\) skipped/);
  await page.click("#mergeBtn");
  await page.waitForFunction(() => document.getElementById("ioMsg").textContent.includes("skipped 3"));
  assert.equal(await page.textContent("#ioMsg"), "Imported 1 shorthand(s); skipped 3 invalid or duplicate item(s).");
  const items = await readStorage(app);
  const snippets = Object.values(items).filter((item) => item.trigger);
  assert.equal(snippets.length, 2);
  assert.equal(snippets.find((item) => item.trigger === "good/").expansion, "First value wins");
  assert.equal(snippets.find((item) => item.trigger === "local/").expansion, "Keep me");
  assert.deepEqual(app.errors, []);
});

test("import controls prevent overlapping replacements while storage is busy", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "local/", expansion: "Keep me" }] });
  t.after(() => app.close());
  const page = await openOptions(app);
  await preview(page, [{ trigger: "new/", expansion: "Replacement" }]);
  // Delay the real operation so the pending UI state is deterministic. The
  // wrapper still calls the actual storage implementation once released.
  await page.evaluate(() => {
    const replaceAll = self.ShorthandStorage.replaceAll;
    self.ShorthandStorage.replaceAll = async (items) => {
      await new Promise((resolve) => { self.finishImport = resolve; });
      return replaceAll(items);
    };
  });
  await page.click("#replaceBtn");
  for (const selector of ["#importBtn", "#mergeBtn", "#replaceBtn", "#cancelImportBtn"]) {
    assert.equal(await page.isDisabled(selector), true);
  }
  await page.evaluate(() => self.finishImport());
  await page.waitForFunction(() => document.getElementById("ioMsg").textContent.startsWith("Replaced your library with 1"));
  for (const selector of ["#importBtn", "#mergeBtn", "#replaceBtn", "#cancelImportBtn"]) {
    assert.equal(await page.isDisabled(selector), false);
  }
  const snippets = Object.values(await readStorage(app)).filter((item) => item.trigger);
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].trigger, "new/");
  assert.deepEqual(app.errors, []);
});
