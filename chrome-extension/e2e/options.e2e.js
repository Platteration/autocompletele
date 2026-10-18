// The options page: managing shorthands, searching, and the conflict warnings.
const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

async function openOptions(app) {
  const page = await app.context.newPage();
  page.on("pageerror", (e) => app.errors.push("options: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") app.errors.push("options: " + m.text());
  });
  await page.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  await page.waitForSelector("#list tbody tr");
  return page;
}

const rowCount = (page) => page.$$eval("#list tbody tr", (rows) => rows.length);

test("managing shorthands", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "cool/", expansion: "That is really cool!" }] });
  const page = await openOptions(app);
  t.after(() => app.close());

  await t.test("adds a shorthand", async () => {
    await page.fill("#trigger", "brb/");
    await page.fill("#expansion", "Be right back");
    await page.click("#saveBtn");
    await page.waitForFunction(() => document.querySelectorAll("#list tbody tr").length === 2);
  });

  await t.test("refuses a duplicate trigger", async () => {
    await page.fill("#trigger", "brb/");
    await page.fill("#expansion", "something else");
    await page.click("#saveBtn");
    assert.equal(await page.textContent("#formMsg"), "That trigger is already used.");
    assert.equal(await rowCount(page), 2);
  });

  await t.test("edits an existing shorthand", async () => {
    const rows = await page.$$("#list tbody tr");
    await (await rows[rows.length - 1].$("button.secondary")).click();
    await page.fill("#expansion", "Be right back!");
    await page.click("#saveBtn");
    await page.waitForFunction(() =>
      [...document.querySelectorAll("td.expansion")].some((td) => td.textContent.startsWith("Be right back!"))
    );
  });

  await t.test("deletes a shorthand", async () => {
    const before = await rowCount(page);
    const rows = await page.$$("#list tbody tr");
    await (await rows[0].$("button.danger")).click();
    await page.waitForFunction((n) => document.querySelectorAll("#list tbody tr").length === n - 1, before);
  });

  await t.test("normalises the excluded hosts list", async () => {
    await page.fill("#excluded", "https://Example.com/path\nmail.google.com");
    await page.dispatchEvent("#excluded", "change");
    await page.waitForTimeout(250);
    const settings = await app.worker.evaluate(() => chrome.storage.sync.get("settings"));
    assert.deepEqual(settings.settings.excludedHosts, ["example.com", "mail.google.com"]);
  });

  await t.test("keeps search-trigger validation beside its settings field", async () => {
    await page.fill("#pickerTrigger", "has spaces");
    await page.dispatchEvent("#pickerTrigger", "change");
    const message = page.locator("#pickerMsg");
    assert.equal(await message.textContent(), "The search trigger cannot contain spaces.");
    assert.equal(await message.getAttribute("role"), "status");
    assert.equal(await page.locator("#pickerTrigger").getAttribute("aria-describedby"), "pickerMsg");
    assert.equal(await page.inputValue("#pickerTrigger"), ";;");
    const bounds = await message.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height,
      "The validation message should be visible alongside the field");
    await page.fill("#pickerTrigger", ";;");
    await page.dispatchEvent("#pickerTrigger", "change");
    assert.equal(await message.textContent(), "");
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("search filters the list", async (t) => {
  const app = await launch({
    shorthands: [
      { trigger: "cool/", expansion: "That is really cool!" },
      { trigger: "brb/", expansion: "Be right back" },
      { trigger: "addr/", expansion: "123 Example Street" },
    ],
  });
  const page = await openOptions(app);
  t.after(() => app.close());

  assert.equal(await rowCount(page), 3);

  await page.fill("#search", "brb");
  await page.waitForFunction(() => document.querySelectorAll("#list tbody tr").length === 1);

  // Searching matches the expansion too, not just the trigger.
  await page.fill("#search", "Example Street");
  await page.waitForFunction(() => document.querySelectorAll("#list tbody tr").length === 1);
  assert.equal(await page.textContent("#list tbody tr td.trigger"), "addr/");

  await page.fill("#search", "zzzz");
  await page.waitForFunction(() => document.querySelectorAll("#list tbody tr").length === 0);
  assert.equal(await page.isVisible("#noMatches"), true);

  await page.fill("#search", "");
  await page.waitForFunction(() => document.querySelectorAll("#list tbody tr").length === 3);
});

test("conflict warnings appear in the list", async (t) => {
  const app = await launch({
    shorthands: [
      { trigger: "sig", expansion: "Alex" },
      { trigger: "sig/", expansion: "Best regards, Alex" },
      { trigger: "brb/", expansion: "Be right back" },
    ],
  });
  const page = await openOptions(app);
  t.after(() => app.close());

  const warned = await page.$$eval("tr.has-warning td.trigger", (tds) => tds.map((td) => td.textContent.trim()));
  assert.deepEqual(warned.sort(), ["sig", "sig/"]);

  const texts = await page.$$eval(".warning", (els) => els.map((e) => e.textContent));
  assert.ok(texts.some((s) => s.includes('"sig/" can never fire')), "expected the unreachable warning");
  assert.ok(texts.some((s) => s.includes("fires inside ordinary words")), "expected the mid-word warning");

  // A healthy trigger is not flagged.
  const healthy = await page.$$eval("#list tbody tr", (rows) =>
    rows.filter((r) => r.querySelector("td.trigger").textContent.trim() === "brb/")
      .map((r) => r.className)
  );
  assert.deepEqual(healthy, [""]);
});

test("two shorthands with one trigger are flagged on both rows, each warning once", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "brb/", expansion: "Be right back" }] });
  t.after(() => app.close());
  // Chrome sync merging two devices' libraries produces this; the editor and
  // import never do, so write the records directly.
  await app.worker.evaluate(() => chrome.storage.sync.set({
    "sh:dup-a": { trigger: "sig", expansion: "Alex", order: 5 },
    "sh:dup-b": { trigger: "sig", expansion: "A.", order: 6 },
  }));
  const page = await openOptions(app);
  await page.waitForFunction(() => document.querySelectorAll("#list tbody tr").length === 3);
  const rows = await page.$$eval("#list tbody tr", (trs) => trs.map((tr) =>
    [tr.querySelector("td.trigger").textContent, [...tr.querySelectorAll(".warning")].map((w) => w.textContent)]));
  const warnings = [
    'Two shorthands use "sig". Typing it expands only one of them: the one used most in this browser, or the first in the list when they are tied. Rename or delete the other.',
    '"sig" is only letters and digits, so it fires inside ordinary words. Ending it with a symbol, like "sig/", avoids that.',
  ];
  assert.deepEqual(rows, [["brb/", []], ["sig", warnings], ["sig", warnings]]);
  assert.deepEqual(app.errors, []);
});

const triggers = (page) => page.$$eval("#list tbody tr td.trigger", (tds) => tds.map((td) => td.textContent));
const syncLibrary = (app) => app.worker.evaluate(() => chrome.storage.sync.get(null));
const localTrash = (app) => app.worker.evaluate(async () => (await chrome.storage.local.get("shorthand-trash"))["shorthand-trash"]);
const libraryRow = (page, trigger) => page.locator("#list tbody tr", { has: page.locator(`td.trigger:text-is("${trigger}")`) });
const trashEntry = (page, trigger) => page.locator("#trashList li", { has: page.locator(`.trash-trigger:text-is("${trigger}")`) });
const libraryMsg = (page, text) => page.waitForFunction((expected) => document.getElementById("libraryMsg").textContent === expected, text);

test("Recently deleted", async (t) => {
  const app = await launch({
    shorthands: [
      { trigger: "cool/", expansion: "That is really cool!" },
      { trigger: "brb/", expansion: "Be right back" },
      { trigger: "addr/", expansion: "123 Example Street\nSpringfield" },
    ],
  });
  const page = await openOptions(app);
  t.after(() => app.close());

  await t.test("starts collapsed, with a plain empty line inside", async () => {
    assert.equal(await page.$eval("#trash", (details) => details.open), false);
    assert.equal(await page.textContent("#trashCount"), "0");
    await page.click("#trashSummary");
    assert.equal(await page.textContent("#trashEmpty"), "No recently deleted shorthands.");
    assert.equal(await page.isVisible("#emptyTrashBtn"), false);
    await page.click("#trashSummary");
  });

  await t.test("Delete says so, and Undo puts the shorthand back in place under its id", async () => {
    const before = await triggers(page);
    const stored = await syncLibrary(app);
    const key = Object.keys(stored).find((k) => stored[k].trigger === "brb/");
    await libraryRow(page, "brb/").locator("button.danger").click();
    await libraryMsg(page, "Deleted brb/.");
    assert.deepEqual(await triggers(page), ["cool/", "addr/"]);
    assert.equal(await page.getAttribute("#libraryMsg", "role"), "status");
    assert.equal(await page.evaluate(() => document.activeElement.id), "undoBtn");
    assert.equal(await page.textContent("#trashCount"), "1");
    const trash = await localTrash(app);
    assert.deepEqual(trash.map(({ deletedAt, ...rest }) => rest),
      [{ id: key.slice(3), trigger: "brb/", expansion: "Be right back", order: stored[key].order }]);
    assert.equal((await syncLibrary(app))["shorthand-trash"], undefined, "the copy is never synced");
    // Other status messages clear after four seconds; this one waits for the next action.
    await page.waitForTimeout(4500);
    assert.equal(await page.textContent("#libraryMsg"), "Deleted brb/.");
    assert.equal(await page.isVisible("#undoBtn"), true);
    await page.keyboard.press("Enter");
    await libraryMsg(page, "Restored brb/.");
    assert.deepEqual(await triggers(page), before);
    assert.deepEqual((await syncLibrary(app))[key], stored[key]);
    assert.equal(await localTrash(app), undefined);
    assert.equal(await page.isVisible("#undoBtn"), false);
    assert.equal(await page.textContent("#trashCount"), "0");
    // The storage change events re-render the list after the restore; focus stays on the row.
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.textContent, document.activeElement.closest("tr")?.querySelector("td.trigger").textContent]), ["Edit", "brb/"]);
  });

  await t.test("Restore from Recently deleted", async () => {
    await libraryRow(page, "addr/").locator("button.danger").click();
    await libraryMsg(page, "Deleted addr/.");
    await page.click("#trashSummary");
    const entry = trashEntry(page, "addr/");
    assert.equal(await entry.locator(".trash-preview").textContent(), "123 Example Street Springfield");
    assert.match(await entry.locator(".trash-time").textContent(), /^Deleted \S/);
    assert.ok(Date.parse(await entry.locator("time").getAttribute("datetime")) > Date.now() - 60000);
    await entry.getByRole("button", { name: "Restore addr/" }).click();
    await libraryMsg(page, "Restored addr/.");
    assert.deepEqual(await triggers(page), ["cool/", "brb/", "addr/"]);
    assert.equal(await page.locator("#trashList li").count(), 0);
    assert.equal(await page.isVisible("#trashEmpty"), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "trashSummary");
  });

  await t.test("Delete for good", async () => {
    await libraryRow(page, "cool/").locator("button.danger").click();
    await libraryMsg(page, "Deleted cool/.");
    await trashEntry(page, "cool/").getByRole("button", { name: "Delete for good: cool/", exact: true }).click();
    await libraryMsg(page, "Deleted cool/ for good.");
    assert.equal(await page.locator("#trashList li").count(), 0);
    assert.deepEqual(await triggers(page), ["brb/", "addr/"]);
    assert.equal(await localTrash(app), undefined);
  });

  await t.test("restore is refused while the trigger is in use again, and the entry stays", async () => {
    await libraryRow(page, "brb/").locator("button.danger").click();
    await libraryMsg(page, "Deleted brb/.");
    await page.fill("#trigger", "brb/");
    await page.fill("#expansion", "Be right back, new text");
    await page.click("#saveBtn");
    await page.waitForFunction(() => document.querySelectorAll("#list tbody tr").length === 2);
    assert.equal(await page.isVisible("#undoBtn"), false, "saving was the next library action");
    await trashEntry(page, "brb/").getByRole("button", { name: "Restore brb/" }).click();
    await libraryMsg(page, "brb/ is already in your library. Rename or delete that one first.");
    assert.equal(await trashEntry(page, "brb/").count(), 1);
    assert.equal(await libraryRow(page, "brb/").locator(".expansion-text").textContent(), "Be right back, new text");
  });

  await t.test("Empty Recently deleted asks first", async () => {
    let asked = "";
    page.once("dialog", (dialog) => { asked = dialog.message(); dialog.dismiss(); });
    await page.click("#emptyTrashBtn");
    await page.waitForTimeout(200);
    assert.equal(asked, "Empty Recently deleted? The shorthand in it will be deleted for good.");
    assert.equal(await page.locator("#trashList li").count(), 1);
    page.once("dialog", (dialog) => dialog.accept());
    await page.click("#emptyTrashBtn");
    await libraryMsg(page, "Emptied Recently deleted.");
    assert.equal(await page.locator("#trashList li").count(), 0);
    assert.equal(await localTrash(app), undefined);
  });

  await t.test("keyboard focus stays on its row when another tab changes the library or Recently deleted", async () => {
    const focusedRow = (selector) => page.evaluate((s) => {
      const row = document.activeElement.closest(s);
      return row && [document.activeElement.textContent, row.querySelector("td.trigger, .trash-trigger").textContent];
    }, selector);
    await libraryRow(page, "brb/").locator("button.danger").click();
    await libraryMsg(page, "Deleted brb/.");
    await page.keyboard.press("Enter");
    await libraryMsg(page, "Restored brb/.");
    assert.deepEqual(await focusedRow("tr"), ["Edit", "brb/"]);
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ excludedHosts: ["focus.example"] }));
    await page.waitForFunction(() => document.getElementById("excluded").value === "focus.example");
    assert.deepEqual(await focusedRow("tr"), ["Edit", "brb/"], "the list was rebuilt around the focused button");

    await libraryRow(page, "brb/").locator("button.danger").click();
    await libraryMsg(page, "Deleted brb/.");
    await trashEntry(page, "brb/").getByRole("button", { name: "Restore brb/" }).focus();
    await app.worker.evaluate(async () => {
      const trash = (await chrome.storage.local.get("shorthand-trash"))["shorthand-trash"];
      await chrome.storage.local.set({ "shorthand-trash": [...trash, { id: "other", trigger: "other/", expansion: "x", order: 9, deletedAt: Date.now() }] });
    });
    await page.waitForFunction(() => document.querySelectorAll("#trashList li").length === 2);
    assert.deepEqual(await focusedRow("li"), ["Restore", "brb/"], "Recently deleted was rebuilt around the focused button");
    await page.keyboard.press("Enter");
    await libraryMsg(page, "Restored brb/.");
    await trashEntry(page, "other/").getByRole("button", { name: "Delete for good: other/", exact: true }).click();
    await libraryMsg(page, "Deleted other/ for good.");
    assert.deepEqual(await triggers(page), ["addr/", "brb/"]);
  });

  await t.test("a copy that cannot be kept is not deleted without asking", async () => {
    // Fail this page's local writes the way a full storage.local would.
    await page.evaluate(() => { chrome.storage.local.set = () => Promise.reject(new Error("QUOTA_BYTES quota exceeded")); });
    let asked = "";
    page.once("dialog", (dialog) => { asked = dialog.message(); dialog.dismiss(); });
    await libraryRow(page, "addr/").locator("button.danger").click();
    await libraryMsg(page, "addr/ was not deleted.");
    assert.equal(asked, "addr/ could not be kept in Recently deleted, so deleting it cannot be undone. Delete it anyway?");
    assert.deepEqual(await triggers(page), ["addr/", "brb/"]);
    page.once("dialog", (dialog) => dialog.accept());
    await libraryRow(page, "addr/").locator("button.danger").click();
    await libraryMsg(page, "Deleted addr/. It was not kept in Recently deleted.");
    assert.deepEqual(await triggers(page), ["brb/"]);
    assert.equal(await page.isVisible("#undoBtn"), false);
    assert.equal(await localTrash(app), undefined);
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});
