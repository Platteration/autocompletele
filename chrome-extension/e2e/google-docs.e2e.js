const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

// Google is not reachable from the test environment, so this stand-in plays
// the part of the Docs editor the bridge relies on: a hidden same-origin
// typing frame, a document model the page keeps itself (nothing stays in the
// frame), Backspace and ArrowLeft read from keyCode, and plain-text paste.
// It checks the extension's side of the contract, not Google's.
const DOCS_URL = "https://docs.google.com/document/d/actle-test/edit";
const MOCK_DOCS = `<!doctype html><meta charset="utf-8"><title>Mock Docs</title>
<pre id="doc"></pre>
<iframe class="docs-texteventtarget-iframe"></iframe>
<script>
  const model = { text: "", caret: 0 };
  const inner = document.querySelector("iframe").contentDocument;
  inner.body.innerHTML = '<div contenteditable="true" role="textbox" style="min-height:20px"></div>';
  const box = inner.querySelector("div");
  const render = () => { document.getElementById("doc").textContent = model.text.slice(0, model.caret) + "|" + model.text.slice(model.caret); };
  const insert = (text) => { model.text = model.text.slice(0, model.caret) + text + model.text.slice(model.caret); model.caret += text.length; render(); };
  box.addEventListener("keydown", (e) => {
    if (e.keyCode === 8) {
      if (model.caret) { model.text = model.text.slice(0, model.caret - 1) + model.text.slice(model.caret); model.caret--; render(); }
      e.preventDefault();
    } else if (e.keyCode === 37) {
      model.caret = Math.max(0, model.caret - 1); render(); e.preventDefault();
    } else if (e.keyCode === 39) {
      model.caret = Math.min(model.text.length, model.caret + 1); render(); e.preventDefault();
    } else if (e.key === "Enter") {
      insert("\\n"); e.preventDefault();
    }
  });
  box.addEventListener("beforeinput", (e) => { if (e.inputType === "insertText") insert(e.data); e.preventDefault(); });
  box.addEventListener("paste", (e) => { insert(e.clipboardData.getData("text/plain")); e.preventDefault(); });
  window.fakeTyping = (text) => { for (const key of text) box.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); insert(text); };
  render();
</script>`;

const SHORTHANDS = [
  { trigger: "cool/", expansion: "That is really cool!" },
  { trigger: "sig/", expansion: "Regards,\n{cursor}\nAlex" },
  { trigger: "hi/", expansion: "Hi [[name]]!" },
];

async function open(app) {
  await app.page.goto(DOCS_URL);
  await app.page.frameLocator("iframe.docs-texteventtarget-iframe").locator("div").click();
  // Wait for the bridge to find the typing frame.
  await app.page.waitForTimeout(300);
}

const docText = (page) => page.textContent("#doc");
const typeSlowly = (page, text) => page.keyboard.type(text, { delay: 90 });

test("experimental Google Docs bridge", { timeout: 120000 }, async (t) => {
  const app = await launch({ shorthands: SHORTHANDS });
  t.after(() => app.close());
  await app.context.route("https://docs.google.com/**", (route) => route.fulfill({ contentType: "text/html", body: MOCK_DOCS }));

  await t.test("a typed trigger is replaced by its expansion", async () => {
    await open(app);
    await typeSlowly(app.page, "Hi cool/");
    await app.page.waitForFunction(() => document.querySelector("#doc").textContent.includes("really"));
    assert.equal(await docText(app.page), "Hi That is really cool!|");
    await typeSlowly(app.page, " ok");
    assert.equal(await docText(app.page), "Hi That is really cool! ok|");
  });

  await t.test("multi-line expansions place the caret at the cursor marker", async () => {
    await open(app);
    await typeSlowly(app.page, "sig/");
    await app.page.waitForFunction(() => document.querySelector("#doc").textContent.includes("Alex"));
    assert.equal(await docText(app.page), "Regards,\n|\nAlex");
  });

  await t.test("word boundaries, caret moves and page-made keystrokes do not expand", async () => {
    await open(app);
    await typeSlowly(app.page, "xcool/");
    await app.page.waitForTimeout(200);
    assert.equal(await docText(app.page), "xcool/|", "a trigger inside a word stays");
    await open(app);
    await typeSlowly(app.page, "coo");
    await app.page.keyboard.press("ArrowLeft");
    await app.page.keyboard.press("ArrowRight");
    await typeSlowly(app.page, "l/");
    await app.page.waitForTimeout(200);
    assert.equal(await docText(app.page), "cool/|", "after the caret moves, earlier characters are unknown");
    await open(app);
    await app.page.evaluate(() => window.fakeTyping("cool/"));
    await app.page.waitForTimeout(200);
    assert.equal(await docText(app.page), "cool/|", "keystrokes the page dispatches are not typing");
  });

  await t.test("a fill-in template inserts its answers in the document", async () => {
    await open(app);
    await typeSlowly(app.page, "hi/");
    await app.page.waitForSelector("#shorthand-template-host");
    await app.page.keyboard.type("Sam");
    await app.page.keyboard.press("Enter");
    await app.page.waitForSelector("#shorthand-template-host", { state: "detached" });
    await app.page.waitForFunction(() => document.querySelector("#doc").textContent.includes("Sam"));
    assert.equal(await docText(app.page), "Hi Sam!|");
    await typeSlowly(app.page, " cool/");
    await app.page.waitForFunction(() => document.querySelector("#doc").textContent.includes("really"));
    assert.equal(await docText(app.page), "Hi Sam! That is really cool!|", "typing continues in the document after the form");
  });

  await t.test("pause and per-site exclusion turn the bridge off", async () => {
    for (const settings of [{ enabled: false }, { excludedHosts: ["docs.google.com"] }]) {
      await app.worker.evaluate((s) => self.ShorthandStorage.saveSettings(s), settings);
      await open(app);
      await typeSlowly(app.page, "cool/");
      await app.page.waitForTimeout(200);
      assert.equal(await docText(app.page), "cool/|", JSON.stringify(settings));
      await app.worker.evaluate(() => self.ShorthandStorage.saveSettings({ enabled: true, excludedHosts: [] }));
    }
  });

  assert.deepEqual(app.errors, []);
});
