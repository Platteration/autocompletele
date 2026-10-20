// The business edition must honour the same matching, placeholder and
// validation contract as the personal apps. The suite runs twice: directly
// against the shared modules, and through the headless engine, so the engine's
// buffering cannot drift from the rules either.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { expander } = require("../core/personal.js");
const { createEngine } = require("../core/engine.js");

const suite = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "shared", "conformance.json"), "utf8"));

test("conformance: findMatch through the shared module", async (t) => {
  for (const c of suite.match) {
    await t.test(c.name, () => {
      const actual = expander.findMatch(c.input, suite.shorthands);
      if (c.expect === null) return assert.equal(actual, null);
      assert.notEqual(actual, null);
      assert.equal(actual.shorthand.trigger, c.expect.trigger);
      assert.equal(actual.start, c.expect.start);
    });
  }
});

test("conformance: findMatch through the engine, one key at a time", async (t) => {
  for (const c of suite.match) {
    await t.test(c.name, () => {
      const engine = createEngine({ library: suite.shorthands, policy: { capture: { defaultMode: "triggers" } } });
      engine.focusChanged({ process: "notepad" });
      let fired = null;
      for (const ch of Array.from(c.input)) {
        const actions = engine.keyTyped({ text: ch });
        const expand = actions.find((a) => a.type === "expand");
        // The suite's expectations describe the final caret position, so only
        // a match on the last key counts.
        fired = expand || null;
      }
      if (c.expect === null) return assert.equal(fired, null);
      assert.notEqual(fired, null, "expected an expansion");
      assert.equal(fired.trigger, c.expect.trigger);
    });
  }
});

test("conformance: render", async (t) => {
  for (const c of suite.render) {
    await t.test(c.name, () => {
      const [y, mo, d, h, mi] = c.now;
      const actual = expander.render(c.expansion, new Date(y, mo - 1, d, h, mi));
      assert.equal(actual.text, c.expectText);
      assert.equal(actual.cursorOffset, c.expectCursor);
    });
  }
});

test("conformance: sanitize", async (t) => {
  for (const c of suite.sanitize) {
    await t.test(c.name, () => {
      assert.deepEqual(expander.sanitizeList(c.input), c.expect);
    });
  }
});
