const test = require("node:test");
const assert = require("node:assert/strict");
const { launch, FIXTURE } = require("./helper.js");
const { HOST, LIBRARY, inspectMenu, runCases } = require("./suggestion-cases.js");

test("saved shortcut suggestions and protected fields in Chrome", { timeout: 180000 }, async (t) => {
  const app = await launch({ shorthands: LIBRARY, settings: { animationMode: "off" } });
  t.after(() => app.close());
  const { page } = app;
  async function inMenu(fn) {
    const client = await page.context().newCDPSession(page);
    try {
      const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
      function find(node) {
        const attrs = node.attributes || [];
        if (attrs.some((item, i) => i % 2 === 0 && item === "id" && attrs[i + 1] === HOST.slice(1))) return node;
        for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
          const found = find(child);
          if (found) return found;
        }
      }
      const host = find(root);
      assert.ok(host && host.shadowRoots.length === 1, "Inspect the actual closed extension menu");
      const { object } = await client.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId });
      const result = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true, functionDeclaration: fn.toString(),
      });
      assert.equal(result.exceptionDetails, undefined);
      return result.result.value;
    } finally { await client.detach(); }
  }
  await runCases(t, {
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    pause: (ms) => page.waitForTimeout(ms),
    fixture: (file = "page.html") => page.goto(FIXTURE.replace(/page\.html$/, file)),
    options: () => page.goto(`chrome-extension://${app.extensionId}/src/options.html`),
    reload: () => page.reload(),
    click: (selector) => page.click(selector),
    type: (text) => page.keyboard.type(text),
    key: (key) => page.keyboard.press(key),
    pointer: (x, y) => page.mouse.click(x, y),
    settings: (patch) => app.worker.evaluate((patch) => self.ShorthandStorage.saveSettings(patch), patch),
    menu: () => inMenu(inspectMenu),
    fabricatedPick: () => inMenu(function () {
      const row = this.querySelector(".item");
      for (const type of ["mousedown", "click"]) row.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, button: 0 }));
    }),
  });
  assert.deepEqual(app.errors, []);
});
