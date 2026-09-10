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
