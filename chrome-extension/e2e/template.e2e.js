const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launch, FIXTURE } = require("./helper.js");

const HOST = "#shorthand-template-host";
const TEMPLATES = [
  { trigger: "hello/", expansion: "Hello [[name]], about [[topic]]. Thanks, [[name]]!" },
  { trigger: "one/", expansion: "Hi [[name]]." },
  { trigger: "letter/", expansion: "Dear [[name]],\n[[topic]]\nThanks, [[name]]" },
  { trigger: "literal/", expansion: "[[answer]] | {date} | A{cursor}B" },
];

async function opened(page) {
  await page.waitForSelector(HOST, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.activeElement.id), HOST.slice(1));
}

async function answer(page, values) {
  for (let i = 0; i < values.length; i++) {
    if (i) await page.keyboard.press("Tab");
    await page.keyboard.type(values[i]);
  }
}

async function insert(page, values) {
  await answer(page, values);
  await page.keyboard.press("Enter");
  await page.waitForSelector(HOST, { state: "detached", timeout: 5000 });
}

test("templates in real Chrome fields", { timeout: 120000 }, async (t) => {
  const app = await launch({ shorthands: TEMPLATES });
  t.after(() => app.close());
  const { page } = app;
  async function start(selector = "#inp", text = "one/") {
    await page.goto(FIXTURE);
    await page.waitForTimeout(150);
    await page.click(selector);
    await page.keyboard.type(text);
    await opened(page);
  }

  await t.test("asks once for repeated blanks, traps Tab, and restores the trigger on undo", async () => {
    await start("#inp", "hello/");
    assert.equal(await page.inputValue("#inp"), "hello/");
    // Two answers, two action buttons, and the selected view tab form one cycle.
    for (let i = 0; i < 5; i++) await page.keyboard.press("Tab");
    await insert(page, ["Alex", "the launch"]);
    assert.equal(await page.inputValue("#inp"), "Hello Alex, about the launch. Thanks, Alex!");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "hello/");
  });

  await t.test("keeps tokens in answers literal while rendering template dates and the caret", async () => {
    await start("#inp", "literal/");
    const date = await page.evaluate(() => {
      const now = new Date();
      return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    });
    await insert(page, ["{date} {cursor} [[other]] <b>literal</b>"]);
    assert.equal(await page.inputValue("#inp"), `{date} {cursor} [[other]] <b>literal</b> | ${date} | AB`);
    await page.keyboard.type("X");
    assert.equal(await page.inputValue("#inp"), `{date} {cursor} [[other]] <b>literal</b> | ${date} | AXB`);
  });

  await t.test("inserts a multiline script into a textarea", async () => {
    await start("#ta", "letter/");
    await insert(page, ["Morgan", "Your appointment is tomorrow."]);
    assert.equal(await page.inputValue("#ta"), "Dear Morgan,\nYour appointment is tomorrow.\nThanks, Morgan");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#ta"), "letter/");
  });

  await t.test("inserts plain answers into a rich editor and supports undo", async () => {
    await start("#ce", "Note: one/");
    await insert(page, ["<b>Alex</b>"]);
    assert.equal(await page.textContent("#ce"), "Note: Hi <b>Alex</b>.");
    assert.equal(await page.locator("#ce b").count(), 0);
    await page.keyboard.press("Backspace");
    assert.equal(await page.textContent("#ce"), "Note: one/");
  });

  await t.test("Escape and the Cancel button leave the original text and caret intact", async () => {
    await start("#inp", "Before one/");
    await answer(page, ["Discard me"]);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(HOST).count(), 0);
    assert.equal(await page.inputValue("#inp"), "Before one/");
    await page.keyboard.type(" after");
    assert.equal(await page.inputValue("#inp"), "Before one/ after");
    await start();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(HOST).count(), 0);
    assert.equal(await page.inputValue("#inp"), "one/");
  });

  await t.test("requires every answer before inserting", async () => {
    await start("#inp", "hello/");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(HOST).count(), 1);
    assert.equal(await page.inputValue("#inp"), "hello/");
    await answer(page, ["Alex"]);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(HOST).count(), 1);
    assert.equal(await page.inputValue("#inp"), "hello/");
    // Native required-field validation focuses the missing second answer.
    await insert(page, ["a follow-up"]);
    assert.equal(await page.inputValue("#inp"), "Hello Alex, about a follow-up. Thanks, Alex!");
  });

  await t.test("search selection opens the form before replacing the picker trigger", async () => {
    await page.goto(FIXTURE);
    await page.waitForTimeout(150);
    await page.click("#inp");
    await page.keyboard.type("Note: ;;");
    await page.waitForSelector("#shorthand-picker-host");
    await page.keyboard.type("hello");
    await page.keyboard.press("Enter");
    await opened(page);
    assert.equal(await page.inputValue("#inp"), "Note: ;;");
    assert.equal(await page.locator("#shorthand-picker-host").count(), 0);
    await insert(page, ["Sam", "plans"]);
    assert.equal(await page.inputValue("#inp"), "Note: Hello Sam, about plans. Thanks, Sam!");
    await page.keyboard.press("Backspace");
    assert.equal(await page.inputValue("#inp"), "Note: ;;");
  });

  await t.test("does not overwrite text changed by the page while the form is open", async () => {
    await start();
    await page.evaluate(() => { document.getElementById("inp").value = "Newer page draft"; });
    await answer(page, ["Alex"]);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#inp"), "Newer page draft");
    assert.equal(await page.locator(HOST).count(), 1);
    await page.keyboard.press("Escape");
  });

  await t.test("does not write to a replacement for a removed target", async () => {
    await start();
    await page.evaluate(() => {
      const original = document.getElementById("inp");
      const replacement = original.cloneNode();
      replacement.value = "Replacement draft";
      original.replaceWith(replacement);
    });
    await answer(page, ["Alex"]);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#inp"), "Replacement draft");
    assert.equal(await page.locator(HOST).count(), 1);
    await page.keyboard.press("Escape");
  });

  await t.test("preserves rich-editor markup rebuilt while the form is open", async () => {
    await start("#ce", "one/");
    await page.evaluate(() => { document.getElementById("ce").innerHTML = "<strong>one/</strong>"; });
    await answer(page, ["Alex"]);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert.equal(await page.textContent("#ce"), "one/");
    assert.equal(await page.locator("#ce strong").count(), 1);
    assert.equal(await page.locator(HOST).count(), 1);
    await page.keyboard.press("Escape");
  });

  await t.test("rejects a submission after expansion is paused", async () => {
    await start();
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ enabled: false }));
    await answer(page, ["Alex"]);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#inp"), "one/");
    assert.equal(await page.locator(HOST).count(), 1);
    await page.keyboard.press("Escape");
    await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ enabled: true }));
  });

  await t.test("uses a styled, working form under strict CSP", async () => {
    await page.goto("file://" + path.join(__dirname, "fixtures", "strict-csp.html"));
    await page.evaluate(() => {
      window.templateViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.templateViolations.push(event.violatedDirective));
    });
    await page.waitForTimeout(150);
    await page.click("#inp");
    await page.keyboard.type("one/");
    await opened(page);
    const layout = await page.evaluate(() => {
      const host = document.getElementById("shorthand-template-host");
      const box = host.getBoundingClientRect();
      return { position: getComputedStyle(host).position, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.equal(layout.position, "fixed");
    assert.equal(layout.width, layout.viewportWidth);
    assert.equal(layout.height, layout.viewportHeight);
    await insert(page, ["Casey"]);
    assert.equal(await page.inputValue("#inp"), "Hi Casey.");
    assert.deepEqual(await page.evaluate(() => window.templateViolations), []);
  });

  await t.test("the popup copies a completed template to the real clipboard", async () => {
    const popup = await app.context.newPage();
    popup.on("pageerror", (error) => app.errors.push(String(error)));
    await popup.goto(`chrome-extension://${app.extensionId}/src/popup.html`);
    await popup.fill("#search", "hello/");
    await popup.locator(".result").click();
    await opened(popup);
    await insert(popup, ["Avery", "next steps"]);
    await popup.waitForFunction(() => document.getElementById("toast").textContent === "Copied hello/");
    await page.goto(FIXTURE);
    await page.bringToFront();
    await page.click("#inp");
    await page.keyboard.press("Control+v");
    assert.equal(await page.inputValue("#inp"), "Hello Avery, about next steps. Thanks, Avery!");
    await popup.close();
  });

  await t.test("answers remain ephemeral and do not change stored templates", async () => {
    const saved = await app.worker.evaluate(async () => (await self.ShorthandStorage.getAll()).shorthands);
    assert.deepEqual(saved.map(({ trigger, expansion }) => ({ trigger, expansion })), TEMPLATES);
    assert.deepEqual(app.errors, []);
  });
});

test("template editor persists and transfers named blanks", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "plain/", expansion: "Plain text" }] });
  t.after(() => app.close());
  const page = await app.context.newPage();
  page.on("pageerror", (error) => app.errors.push(String(error)));
  await page.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  await page.waitForSelector("#list tbody tr");
  await page.fill("#trigger", "draft/");
  await page.fill("#expansion", "Hello ");
  await page.fill("#fieldName", "name");
  await page.click("#addFieldBtn");
  assert.equal(await page.inputValue("#expansion"), "Hello [[name]]");
  const expansion = "Hello [[name]], about [[topic]]. Thanks, [[name]]!";
  await page.fill("#expansion", expansion);
  assert.match(await page.textContent("#templateFieldCount"), /2/);
  assert.match(await page.textContent("#templatePreview"), /Hello/);
  await page.click("#saveBtn");
  const row = page.locator("#list tbody tr").filter({ has: page.locator("td.trigger", { hasText: "draft/" }) });
  await row.waitFor();
  await page.reload();
  await row.locator("button.secondary").click();
  assert.equal(await page.inputValue("#expansion"), expansion);
  const downloadPromise = page.waitForEvent("download");
  await page.click("#exportBtn");
  const download = await downloadPromise;
  const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  assert.deepEqual(exported.shorthands.find((entry) => entry.trigger === "draft/"), { trigger: "draft/", expansion });
  assert.equal(exported.version, 1);
  await row.locator("button.danger").click();
  await row.waitFor({ state: "detached" });
  await page.setInputFiles("#importFile", { name: "templates.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported)) });
  await page.waitForSelector("#importPreview", { state: "visible" });
  await page.click("#mergeBtn");
  await row.waitFor();
  await row.locator("button.secondary").click();
  assert.equal(await page.inputValue("#expansion"), expansion);
  assert.deepEqual(app.errors, []);
});
