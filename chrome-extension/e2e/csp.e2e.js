// Many sites ship a strict Content Security Policy. Expansion and the overlay
// both have to keep working there, and neither may trip a violation.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { launch, pickerVisible } = require("./helper.js");

test("works on a page with a strict CSP", async (t) => {
  const app = await launch({ shorthands: [{ trigger: "brb/", expansion: "be right back" }] });
  const { page } = app;
  t.after(() => app.close());

  const violations = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    window.__shorthandCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__shorthandCspViolations.push(event.violatedDirective);
    });
  });

  await page.goto("file://" + path.join(__dirname, "fixtures", "strict-csp.html"));
  await page.waitForTimeout(400);

  await t.test("expansion still happens", async () => {
    await page.click("#inp");
    await page.keyboard.type("brb/");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#inp"), "be right back");
  });

  await t.test("the overlay still opens and is laid out", async () => {
    await page.keyboard.type(" ;;");
    await page.waitForTimeout(250);
    assert.equal(await pickerVisible(page), true);
    // An unstyled block can also have large dimensions. Check the stylesheet's
    // actual fixed positioning and bounded width, not only a nonempty box.
    const box = await page.evaluate(() => {
      const host = document.getElementById("shorthand-picker-host");
      const rect = host.getBoundingClientRect();
      return { width: rect.width, height: rect.height, position: getComputedStyle(host).position };
    });
    assert.equal(box.position, "fixed");
    assert.ok(box.width >= 340 && box.width <= 342, `expected a 340px panel plus border, got width ${box.width}`);
    assert.ok(box.height > 50, `expected a laid-out panel, got height ${box.height}`);
  });

  await t.test("the extension trips no CSP violation", async () => {
    assert.deepEqual(violations, []);
    assert.deepEqual(await page.evaluate(() => window.__shorthandCspViolations), []);
  });
});
