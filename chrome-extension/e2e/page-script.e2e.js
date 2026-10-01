// What a page's own script can get out of the extension. An expansion is the
// person's text (an address, a signature), and the page can read whatever lands
// in its fields, so nothing the page does by itself may produce one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { launch } = require("./helper.js");

test("a page script cannot draw expansions out", async (t) => {
  const app = await launch();
  const { page } = app;
  t.after(() => app.close());

  const probe = () => page.evaluate(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const out = {};
    const field = document.createElement("input");
    document.body.append(field);
    field.value = "addr/";
    field.setSelectionRange(5, 5);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "/" }));
    await wait(50);
    out.dispatched = field.value;
    field.value = "";
    field.focus();
    document.execCommand("insertText", false, "addr/");
    await wait(50);
    out.execCommand = field.value;
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.append(editor);
    editor.focus();
    document.execCommand("insertText", false, "addr/");
    await wait(50);
    out.contentEditable = editor.textContent;
    field.remove();
    editor.remove();
    return out;
  });

  await t.test("by writing a trigger and announcing it, in any of three ways", async () => {
    assert.deepEqual(await probe(), { dispatched: "addr/", execCommand: "addr/", contentEditable: "addr/" });
  });

  await t.test("by setting the text before a key the person presses", async () => {
    // The page waits for a real key and puts the rest of a trigger in front of it.
    await page.evaluate(() => {
      const field = document.querySelector("#inp");
      field.addEventListener("keydown", () => { field.value = "addr"; field.setSelectionRange(4, 4); }, { once: true });
    });
    await page.fill("#inp", "");
    await page.click("#inp");
    await page.keyboard.type("/");
    assert.equal(await page.inputValue("#inp"), "addr/");
  });

  await t.test("by pressing keys in the picker for the person", async () => {
    await page.fill("#inp", "");
    await page.click("#inp");
    await page.keyboard.type(";;");
    await page.evaluate(() => {
      for (const key of ["ArrowDown", "Enter"]) document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    await page.waitForTimeout(50);
    assert.equal(await page.inputValue("#inp"), ";;");
  });

  await t.test("while the person's own typing still expands", async () => {
    await page.fill("#inp", "");
    await page.click("#inp");
    await page.keyboard.type("addr/");
    assert.equal(await page.inputValue("#inp"), "123 Example Street");
  });
});
