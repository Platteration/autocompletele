const test = require("node:test");
const assert = require("node:assert/strict");
const detector = require("../core/variable-detector.js");

test("detect proposes a template with named slots and overlay segments", () => {
  const result = detector.detect([
    "Hi John, thanks for your order #12345. We will ship it on Monday.",
    "Hi Mary Ann, thanks for your order #99881. We will ship it on Friday.",
    "Hi Priya, thanks for your order #10001. We will ship it on 2026-10-21.",
  ]);
  assert.equal(result.template, "Hi [[name]], thanks for your order #[[reference]]. We will ship it on [[date]].");
  assert.deepEqual(result.slots.map((s) => s.name), ["name", "reference", "date"]);
  assert.deepEqual(result.slots[0].values, ["John", "Mary Ann", "Priya"]);
  assert.deepEqual(result.slots[2].values, ["Monday", "Friday", "2026-10-21"]);
  assert.equal(result.count, 3);
  assert.deepEqual(result.segments.map((s) => s.type), ["same", "slot", "same", "slot", "same", "slot", "same"]);
  assert.equal(result.segments[0].text, "Hi ");
});

test("detect names email, amount and generic slots and keeps names unique", () => {
  const result = detector.detect([
    "Send the invoice of $120.50 to bob@example.com before noon please",
    "Send the invoice of $99 to alice@example.org before noon please",
  ]);
  assert.equal(result.template, "Send the invoice of $[[amount]] to [[email]] before noon please");
  assert.deepEqual(result.slots[1].values, ["bob@example.com", "alice@example.org"]);
  const generic = detector.detect([
    "we prefer apples over pears in autumn, and we prefer apples in winter",
    "we prefer grapes over pears in autumn, and we prefer grapes in winter",
  ]);
  assert.equal(generic.template, "we prefer [[detail]] over pears in autumn, and we prefer [[detail2]] in winter");
});

test("detect returns null for identical, dissimilar, too-few or too-variable texts", () => {
  assert.equal(detector.detect(["same text here", "same text here"]), null);
  assert.equal(detector.detect(["only one"]), null);
  assert.equal(detector.detect(["completely different words here", "nothing alike at all whatsoever"]), null);
  assert.equal(detector.detect(["a b c d e f g h i j", "1 b 2 d 3 f 4 h 5 j"], { maxSlots: 4 }), null);
  assert.equal(detector.detect([]), null);
  assert.equal(detector.detect(["   ", "  "]), null);
});

test("cluster groups similar texts and keeps unrelated ones apart", () => {
  const groups = detector.cluster([
    "Hi John, thanks for your order. It ships Monday.",
    "Totally unrelated note about the quarterly budget review meeting.",
    "Hi Mary, thanks for your order. It ships Friday.",
    "Totally unrelated note about the quarterly budget review agenda.",
  ]);
  assert.deepEqual(groups, [[0, 2], [1, 3]]);
  assert.deepEqual(detector.cluster([]), []);
});
