const test = require("node:test");
const assert = require("node:assert/strict");
const animation = require("../src/animation-frames.js");

test("animation durations keep expansion shorter than casino settling", () => {
  assert.deepEqual(animation.DURATIONS, { expand: 480, casino: 600 });
  assert.equal(Object.isFrozen(animation.DURATIONS), true);
});

test("expand holds the exact trigger before the reveal begins", () => {
  const plan = animation.plan("yg;", "you got it");
  for (const elapsed of [0, 50, 99]) {
    assert.equal(animation.frame(plan, "expand", elapsed).text, "yg;");
    assert.equal(animation.frame(plan, "expand", elapsed).done, false);
  }
  assert.equal(animation.frame(plan, "expand", 100).text, "yg");
});

test("yg retains both anchors while missing letters appear from left to right", () => {
  const plan = animation.plan("yg", "you got it");
  assert.deepEqual(plan.anchors, [0, 4]);
  const expected = [
    ["yg", 1], ["yog", 2], ["youg", 3], ["you g", 5],
    ["you go", 6], ["you got", 7], ["you got ", 8], ["you got i", 9],
  ];
  for (let step = 0; step < expected.length; step++) {
    const elapsed = 100 + (step + 0.5) * 380 / 8;
    assert.deepEqual(animation.frame(plan, "expand", elapsed), {
      text: expected[step][0], locked: expected[step][1], done: false,
    }, `reveal step ${step}`);
  }
  assert.deepEqual(animation.frame(plan, "expand", 480), {
    text: "you got it", locked: 10, done: true,
  });
});

test("no shared letters reveals only final letters after the initial hold", () => {
  const plan = animation.plan("xyz", "ABC");
  assert.deepEqual(plan.anchors, []);
  assert.deepEqual(plan.missing, [0, 1, 2]);
  assert.equal(animation.frame(plan, "expand", 100).text, "");
  assert.equal(animation.frame(plan, "expand", 300).text, "A");
  assert.equal(animation.frame(plan, "expand", 400).text, "AB");
  assert.equal(animation.frame(plan, "expand", 480).text, "ABC");
});

test("matching is case-sensitive and drops unmatched trigger characters", () => {
  const plan = animation.plan("Yg!", "you got it");
  assert.deepEqual(plan.anchors, [4]);
  assert.equal(animation.frame(plan, "expand", 99).text, "Yg!");
  assert.equal(animation.frame(plan, "expand", 100).text, "g");
  assert.equal(animation.frame(plan, "expand", 480).text, "you got it");
});

test("deletion-only changes retain the full final text when reveal starts", () => {
  const plan = animation.plan("you got it!", "you got it");
  assert.deepEqual(plan.missing, []);
  assert.equal(animation.frame(plan, "expand", 99).text, "you got it!");
  assert.equal(animation.frame(plan, "expand", 100).text, "you got it");
  assert.equal(animation.frame(plan, "expand", 300).text, "you got it");
});

test("repeated letters use each trigger occurrence once in a longest subsequence", () => {
  const plan = animation.plan("aba", "aabba");
  assert.equal(plan.anchors.length, 3);
  assert.equal(plan.missing.length, 2);
  assert.equal(plan.anchors.map(index => plan.glyphs[index]).join(""), "aba");
  assert.deepEqual([...plan.anchors].sort((a, b) => a - b), plan.anchors);
  assert.deepEqual([...plan.anchors, ...plan.missing].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(animation.frame(plan, "expand", 100).text, "aba");
  assert.equal(animation.frame(plan, "expand", 480).text, "aabba");
});

test("anchors preserve ordered matching letters separated by several insertions", () => {
  const plan = animation.plan("abc", "aXbYc");
  assert.deepEqual(plan.anchors, [0, 2, 4]);
  assert.deepEqual(plan.missing, [1, 3]);
  assert.equal(animation.frame(plan, "expand", 150).text, "abc");
  assert.equal(animation.frame(plan, "expand", 350).text, "aXbc");
  assert.equal(animation.frame(plan, "expand", 480).text, "aXbYc");
});

test("the longest match keeps a later pair instead of greedily choosing the first letter", () => {
  const plan = animation.plan("ab", "babc");
  assert.deepEqual(plan.anchors, [1, 2]);
  assert.deepEqual(plan.missing, [0, 3]);
  assert.equal(animation.frame(plan, "expand", 100).text, "ab");
  assert.equal(animation.frame(plan, "expand", 350).text, "bab");
  assert.equal(animation.frame(plan, "expand", 480).text, "babc");
});

test("casino samples every unsettled letter or number and preserves punctuation", () => {
  const plan = animation.plan("x", "Hi, 2!\nOK.");
  const samples = [0, 0.25, 0.5, 0.75, 0.999];
  let calls = 0;
  const frame = animation.frame(plan, "casino", 0, () => samples[calls++]);
  assert.equal(calls, 5);
  assert.match(frame.text, /^[A-Za-z0-9]{2}, [A-Za-z0-9]!\n[A-Za-z0-9]{2}\.$/);
  assert.equal(new Set(frame.text.match(/[A-Za-z0-9]/g)).size, 5);
  assert.equal(frame.locked, 0);
  assert.equal(frame.done, false);
});

test("casino random samples change unsettled letters and preserve whitespace and punctuation", () => {
  const plan = animation.plan("x", "AB — cd\t7!");
  const low = animation.frame(plan, "casino", 0, () => 0);
  const high = animation.frame(plan, "casino", 0, () => 0.999);
  assert.notEqual(low.text, high.text);
  for (const frame of [low, high]) {
    assert.match(frame.text, /^[A-Za-z0-9]{2} — [A-Za-z0-9]{2}\t[A-Za-z0-9]!$/);
  }
});

test("casino locks a growing exact prefix and never resamples settled positions", () => {
  const plan = animation.plan("x", "Hi, 2!\nOK.");
  for (const [elapsed, locked, remainingLetters] of [[60, 1, 4], [300, 5, 2], [540, 9, 0]]) {
    let calls = 0;
    const frame = animation.frame(plan, "casino", elapsed, () => { calls++; return 0; });
    assert.equal(frame.locked, locked);
    assert.equal(frame.text.slice(0, locked), plan.text.slice(0, locked));
    assert.equal(calls, remainingLetters);
    assert.equal(frame.done, false);
  }
});

test("both modes finish with exact text and never sample randomness after completion", () => {
  const text = "<b>{date}</b> [[name]] $&\\\n😀";
  const plan = animation.plan("html/", text);
  for (const mode of ["expand", "casino"]) {
    for (const elapsed of [animation.DURATIONS[mode], 10000]) {
      assert.deepEqual(animation.frame(plan, mode, elapsed, () => { throw new Error("unexpected random sample"); }), {
        text, locked: plan.glyphs.length, done: true,
      });
    }
  }
});

test("emoji and combining marks remain complete grapheme anchors during expansion", () => {
  const emoji = "👩🏽‍💻";
  const accent = "e\u0301";
  const plan = animation.plan(emoji + accent, `${emoji} & ${accent}!`);
  assert.deepEqual(plan.glyphs, [emoji, " ", "&", " ", accent, "!"]);
  assert.deepEqual(plan.anchors, [0, 4]);
  assert.deepEqual(animation.frame(plan, "expand", 100), {
    text: emoji + accent, locked: 1, done: false,
  });
  assert.deepEqual(animation.frame(plan, "expand", 200), {
    text: emoji + " " + accent, locked: 2, done: false,
  });
  assert.deepEqual(animation.frame(plan, "expand", 480), {
    text: `${emoji} & ${accent}!`, locked: 6, done: true,
  });
});

test("casino locks whole graphemes instead of UTF-16 units or separate combining marks", () => {
  const plan = animation.plan("x", "👩🏽‍💻 e\u0301!");
  const frame = animation.frame(plan, "casino", 450, () => 0);
  assert.deepEqual(frame, { text: "👩🏽‍💻 e\u0301!", locked: 3, done: false });
});

test("animation bounds accept inclusive limits and count graphemes", () => {
  assert.ok(animation.plan("x".repeat(128), "y".repeat(512)));
  assert.equal(animation.plan("x".repeat(129), "y"), null);
  assert.equal(animation.plan("x", "y".repeat(513)), null);
  const emoji = "👩🏽‍💻";
  const accent = "e\u0301";
  const plan = animation.plan(emoji.repeat(128), accent.repeat(512));
  assert.ok(plan);
  assert.equal(plan.glyphs.length, 512);
  assert.equal(animation.plan(emoji.repeat(129), accent), null);
  assert.equal(animation.plan(emoji, accent.repeat(513)), null);
});

test("empty inputs and complete deletion still reach an exact final frame", () => {
  for (const [trigger, text] of [["", ""], ["", "hello"], ["erase", ""]]) {
    const plan = animation.plan(trigger, text);
    assert.ok(plan);
    assert.equal(animation.frame(plan, "expand", 0).text, trigger);
    for (const mode of ["expand", "casino"]) {
      assert.deepEqual(animation.frame(plan, mode, animation.DURATIONS[mode]), {
        text, locked: text.length, done: true,
      });
    }
  }
});
