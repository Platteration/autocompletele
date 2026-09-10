// Runs the shared conformance suite (../../shared/conformance.json).
// The Windows and Android test suites run the same file, so a change to the
// matching rules that is applied to only one platform fails everywhere else.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { findMatch, render, sanitizeList } = require("../src/expander.js");

const suite = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "shared", "conformance.json"), "utf8")
);

test("conformance: findMatch", async (t) => {
  for (const c of suite.match) {
    await t.test(c.name, () => {
      const actual = findMatch(c.input, suite.shorthands);
      if (c.expect === null) {
        assert.equal(actual, null);
        return;
      }
      assert.notEqual(actual, null, "expected a match");
      assert.equal(actual.shorthand.trigger, c.expect.trigger);
      assert.equal(actual.start, c.expect.start);
    });
  }
});

test("conformance: render", async (t) => {
  for (const c of suite.render) {
    await t.test(c.name, () => {
      const [y, mo, d, h, mi] = c.now;
      const actual = render(c.expansion, new Date(y, mo - 1, d, h, mi));
      assert.equal(actual.text, c.expectText);
      assert.equal(actual.cursorOffset, c.expectCursor);
    });
  }
});

test("conformance: sanitize", async (t) => {
  for (const c of suite.sanitize) {
    await t.test(c.name, () => {
      assert.deepEqual(sanitizeList(c.input), c.expect);
    });
  }
});
