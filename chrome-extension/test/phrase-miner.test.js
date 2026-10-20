const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { findRepeatedPhrases, normalizePhrase, uniqueTrigger } = require("../src/phrase-miner.js");

const phrases = (texts, options) => findRepeatedPhrases(texts, options).map((found) => found.phrase);

// The owner's example: three emails that each say "as you can see".
const asYouCanSee = [
  "As you can see, the totals went up.",
  "The chart is attached. As you can see it covers March.",
  "We are on track, as you can see from the plan.",
];

test("a phrase written three times is offered with an initials trigger", () => {
  assert.deepEqual(findRepeatedPhrases(asYouCanSee), [
    { phrase: "as you can see", display: "As you can see", count: 3, words: 4, trigger: "aycs/" },
  ]);
});

test("a phrase written twice is not offered", () => {
  assert.deepEqual(findRepeatedPhrases(asYouCanSee.slice(0, 2)), []);
  assert.deepEqual(findRepeatedPhrases(["As you can see, as you can see."]), []);
});

test("occurrences count within one draft as well as across drafts", () => {
  const found = findRepeatedPhrases(["As you can see. As you can see! And as you can see?"]);
  assert.deepEqual(found.map(({ phrase, count }) => [phrase, count]), [["as you can see", 3]]);
});

test("occurrences that overlap each other count once", () => {
  // "ping pong ping" starts at words 0, 2 and 4, but only 0 and 4 can both be typed.
  assert.deepEqual(findRepeatedPhrases(["ping pong ping pong ping pong ping"]), []);
  assert.deepEqual(phrases(["ping pong ping. ping pong ping. ping pong ping."]), ["ping pong ping"]);
});

test("a phrase never crosses . ! ? or a line break", () => {
  for (const separator of [". ", "! ", "? ", "\n", "\r\n", "\u2028"]) {
    const texts = [0, 1, 2].map((n) => `Draft ${n}: results are ready as you${separator}can see the attached file.`);
    assert.ok(!phrases(texts).some((phrase) => /you[\s\S]*can/.test(phrase)), JSON.stringify(separator));
  }
  const joined = [0, 1, 2].map((n) => `Draft ${n}: results are ready as you can see the attached file.`);
  assert.ok(phrases(joined).some((phrase) => /you[\s\S]*can/.test(phrase)), "control: spaces join words");
});

test("other punctuation between words also ends a phrase (stricter than . ! ? alone)", () => {
  // A shortcut that bakes in a comma, quote or bracket only fits one sentence shape.
  for (const separator of [", ", "; ", ": ", " (", ") ", " \u201c", "\u201d ", " - ", " \u2014 ", "/"]) {
    const texts = [0, 1, 2].map((n) => `Draft ${n}: results are ready as you${separator}can see the attached file.`);
    assert.ok(!phrases(texts).some((phrase) => /you[\s\S]*can/.test(phrase)), JSON.stringify(separator));
  }
});

test("words joined by spaces or one hyphen form a phrase, compared without case or extra spaces", () => {
  const found = findRepeatedPhrases(["Our follow-up meeting is Monday.", "The FOLLOW-UP  MEETING moved.", "A follow-up\tmeeting again."]);
  assert.deepEqual(found, [{ phrase: "follow-up meeting", display: "follow-up meeting", count: 3, words: 3, trigger: "fum/" }]);
});

test("only maximal phrases are kept: a shorter phrase seen no more often is dropped", () => {
  // "you can see" and "can see" only ever appear inside "as you can see".
  assert.deepEqual(phrases(asYouCanSee), ["as you can see"]);
  const texts = [
    "As you can see the growth is real.",
    "As you can see the growth slowed.",
    "As you can see the growth returned.",
    "As you can see, it works.",
    "Again, as you can see.",
  ];
  // "you can see the growth" (3) sits inside "as you can see the growth" (3)
  // and is dropped. The longer phrase itself is seen 3 times and the shorter
  // 5: every one of its occurrences is also one of the shorter phrase's, so
  // it is a piece of the same sentences and is not offered beside it.
  assert.deepEqual(findRepeatedPhrases(texts, { limit: 10 }).map(({ phrase, count }) => [phrase, count]), [
    ["as you can see", 5],
  ]);
  // Dismissing the shorter phrase does not bring the longer one back.
  assert.deepEqual(findRepeatedPhrases(texts, { dismissed: ["as you can see"] }), []);
});

test("pieces of one common sentence do not fill every card", () => {
  // Realistic drafts: closings that share "let me know if you have" crowded out
  // every other idea, including the owner's own example, "as you can see".
  const support = (name, line) => `Hi ${name},\n\nThank you for reaching out. ${line}\n\nPlease let me know if you have any other questions.\n\nBest regards,\nPriya`;
  const update = (week, line) => `Weekly update, week ${week}\n\nHi team,\n\nAs you can see, ${line} As you can see from the chart, we are on time.`
    + "\n\nNext steps:\n- Finish the pricing page by Friday\n\nLet me know if you have questions.\n\nThanks,\nAlex";
  const note = (name, topic) => `Hi ${name},\n\nPlease let me know if you have any questions about the ${topic}. `
    + "Feel free to reach out if you have any concerns.\n\nBest,\nChris";
  const texts = [
    support("Daniel", "A replacement ships this week."), support("Ana", "The refund was processed."), support("Tom", "The filter is back in stock."),
    update(42, "sign-ups grew."), update(43, "churn dropped."), update(44, "we closed 14 deals."),
    note("Lena", "proposal"), note("Omar", "contract"), note("Ruth", "timeline"),
  ];
  const found = findRepeatedPhrases(texts, { limit: 3 });
  assert.deepEqual(found.map(({ phrase, count }) => [phrase, count]), [
    ["let me know if you", 9],
    ["to reach out if you have any concerns", 3], // 3 x 8 words, tied with 6 x 4: longer first
    ["as you can see", 6],
  ]);
  // No two ideas share a word of any draft.
  for (const text of texts) {
    const lower = text.toLowerCase();
    const spans = found.flatMap(({ phrase }) => {
      const out = [];
      for (let at = lower.indexOf(phrase); at >= 0; at = lower.indexOf(phrase, at + 1)) out.push([at, at + phrase.length]);
      return out.map((span) => [...span, phrase]);
    });
    for (const a of spans) for (const b of spans) {
      if (a[2] !== b[2]) assert.ok(a[1] <= b[0] || b[1] <= a[0], `${a[2]} / ${b[2]} in ${JSON.stringify(text)}`);
    }
  }
});

test("a phrase that ends on a determiner, quantifier or auxiliary is a fragment", () => {
  for (const ending of ["any", "some", "other", "this", "that", "these", "those", "all", "every", "each", "no", "not", "more",
    "have", "has", "had", "can", "will", "would", "could", "should", "do", "does", "their", "his", "her", "its"]) {
    const texts = ["alpha", "bravo", "charlie"].map((word) => `We kept the plan ${ending} ${word}.`);
    assert.deepEqual(phrases(texts), ["we kept the plan"], ending);
  }
  // Ending a sentence or clause three times, such a phrase is whole.
  assert.deepEqual(phrases(["Reply as soon as you can.", "Call as soon as you can!", "Come as soon as you can, please."]), ["as soon as you can"]);
});

test("a phrase made only of the spec's function words is never offered", () => {
  assert.deepEqual(findRepeatedPhrases(["You can do it.", "you can do it!", "YOU CAN DO IT"]), []);
  assert.deepEqual(phrases(["You can do it now.", "you can do it now!", "YOU CAN DO IT NOW"]), ["you can do it now"]);
});

test("two-word phrases need at least 12 characters", () => {
  assert.deepEqual(findRepeatedPhrases(["Thank you.", "thank you!", "Thank you, Sam."]), []);
  assert.deepEqual(phrases(["Best regards.", "best regards!", "Best regards, Sam."]), ["best regards"]);
});

test("a phrase that ends on an article, preposition or conjunction is a fragment (beyond the spec)", () => {
  // Without this, "as you can see the" (seen 3 times) would hide "as you can see".
  const texts = ["As you can see the totals.", "As you can see the plan.", "As you can see the chart."];
  assert.deepEqual(phrases(texts), ["as you can see"]);
  assert.deepEqual(findRepeatedPhrases(["One of the best.", "One of the cases.", "One of the rest."]), []);
});

test("a phrase that ends a sentence on such a word is complete, not cut short to the word before", () => {
  const texts = ["That is what we are looking for.", "That is what we are looking for!", "that is what we are looking for"];
  assert.deepEqual(phrases(texts), ["that is what we are looking for"]);
  // Ending a sentence only twice out of three is not enough.
  assert.deepEqual(phrases(["Here it is.", "Here it is!", "Here it is now."]), []);
});

test("a phrase that starts with and, or, but or so is offered without that word (beyond the spec)", () => {
  // Without this, "and as you can see it" (seen 3 times) would hide "as you can see it".
  const texts = ["And as you can see it works.", "and as you can see it fails.", "AND as you can see it rains."];
  assert.deepEqual(phrases(texts), ["as you can see it"]);
  for (const word of ["or", "but", "so"]) {
    assert.deepEqual(phrases(texts.map((text) => text.replace(/^and/i, word))), ["as you can see it"], word);
  }
});

test("dismissed phrases are not offered, in any spelling, and do not resurface as a shorter phrase", () => {
  assert.deepEqual(findRepeatedPhrases(asYouCanSee, { dismissed: ["  As YOU can   see "] }), []);
  assert.deepEqual(findRepeatedPhrases(asYouCanSee, { dismissed: ["as you can see"] }), []);
  assert.deepEqual(phrases(asYouCanSee, { dismissed: ["as you can"] }), ["as you can see"]);
});

test("a phrase that is already a shortcut's expansion is not offered", () => {
  for (const expansion of ["As you can see", "as you can see, ", "AS YOU CAN SEE:"]) {
    assert.deepEqual(findRepeatedPhrases(asYouCanSee, { shorthands: [{ trigger: "seen/", expansion }] }), [], expansion);
  }
  assert.deepEqual(phrases(asYouCanSee, { shorthands: [{ trigger: "seen/", expansion: "As you can see in the chart" }] }),
    ["as you can see"]);
});

test("the trigger gets a number when an existing shortcut uses it or would be cut short by it", () => {
  const trigger = (shorthands) => findRepeatedPhrases(asYouCanSee, { shorthands })[0].trigger;
  assert.equal(trigger([{ trigger: "aycs/", expansion: "x" }]), "aycs2/");
  assert.equal(trigger([{ trigger: "aycs/", expansion: "x" }, { trigger: "aycs2/", expansion: "y" }]), "aycs3/");
  // aycs/ would fire as soon as "aycs/x" was half typed.
  assert.equal(trigger([{ trigger: "aycs/x", expansion: "x" }]), "aycs2/");
  // "aycs2" would fire before "aycs2/" could be finished.
  assert.equal(trigger([{ trigger: "aycs/", expansion: "x" }, { trigger: "aycs2", expansion: "y" }]), "aycs3/");
  assert.equal(trigger([{ trigger: "AYCS/", expansion: "x" }]), "aycs/", "triggers are case-sensitive");
});

test("two suggestions with the same initials get different triggers", () => {
  const texts = [
    "As you can see. Ask your colleague Sam. One.",
    "As you can see. Ask your colleague Sam. Two.",
    "As you can see. Ask your colleague Sam. Three.",
  ];
  assert.deepEqual(findRepeatedPhrases(texts).map(({ phrase, trigger }) => [phrase, trigger]), [
    ["as you can see", "aycs/"],
    ["ask your colleague sam", "aycs2/"],
  ]);
});

test("uniqueTrigger accepts shortcuts or plain triggers and cannot loop on a blocker inside the stem", () => {
  assert.equal(uniqueTrigger("ht", []), "ht/");
  assert.equal(uniqueTrigger("ht", ["ht/", "ht2/"]), "ht3/");
  assert.equal(uniqueTrigger("ht", [{ trigger: "ht/" }, null, 7, { trigger: "" }]), "ht2/");
  // An existing "h" fires before any "ht.../" can be typed; numbering cannot help,
  // so the proposal stands and the pad's save checks it with conflicts.js.
  assert.equal(uniqueTrigger("ht", ["h"]), "ht/");
});

test("words are Unicode-aware: accents in either form, other scripts and curly apostrophes", () => {
  const composed = "Caf\u00e9 cr\u00e8me br\u00fbl\u00e9e";
  const decomposed = "Cafe\u0301 cre\u0300me bru\u0302le\u0301e";
  const found = findRepeatedPhrases([`${composed} tonight.`, `${composed} again.`, `${decomposed} please.`]);
  assert.deepEqual(found, [{ phrase: "caf\u00e9 cr\u00e8me br\u00fbl\u00e9e", display: composed, count: 3, words: 3, trigger: "ccb/" }]);

  const russian = ["\u041a\u0430\u043a \u0432\u044b \u043c\u043e\u0436\u0435\u0442\u0435 \u0432\u0438\u0434\u0435\u0442\u044c, \u0432\u0441\u0451 \u0433\u043e\u0442\u043e\u0432\u043e.",
    "\u041a\u0430\u043a \u0432\u044b \u043c\u043e\u0436\u0435\u0442\u0435 \u0432\u0438\u0434\u0435\u0442\u044c.",
    "\u0438 \u043a\u0430\u043a \u0432\u044b \u043c\u043e\u0436\u0435\u0442\u0435 \u0432\u0438\u0434\u0435\u0442\u044c"];
  assert.deepEqual(findRepeatedPhrases(russian).map(({ phrase, trigger }) => [phrase, trigger]),
    [["\u043a\u0430\u043a \u0432\u044b \u043c\u043e\u0436\u0435\u0442\u0435 \u0432\u0438\u0434\u0435\u0442\u044c", "\u043a\u0432\u043c\u0432/"]]);

  const apostrophes = findRepeatedPhrases(["Don\u2019t worry about it.", "Don't worry about it.", "don\u2019t worry about it"]);
  assert.deepEqual(apostrophes.map(({ phrase, display, count }) => [phrase, display, count]),
    [["don't worry about it", "Don\u2019t worry about it", 3]]);
});

test("display is the most frequent spelling, ties going to the first seen, with single spaces", () => {
  const mostly = findRepeatedPhrases(["Best Regards.", "best  regards.", "best regards!"]);
  assert.equal(mostly[0].display, "best regards");
  const tied = findRepeatedPhrases(["Best regards.", "best Regards.", "BEST REGARDS."]);
  assert.equal(tied[0].display, "Best regards");
});

test("suggestions rank by count times words, then longer first, and stop at the limit", () => {
  const texts = [0, 1, 2, 3, 4, 5, 6].map((n) => `Item ${n}. Quarterly report.`
    + (n < 4 ? " See you soon." : "") + (n < 3 ? " Please find it attached." : ""));
  // 2 words x 7 = 14; 4 x 3 = 12; 3 x 4 = 12, so the 4-word phrase goes first of
  // the tie although "see you soon" is written first.
  assert.deepEqual(phrases(texts), ["quarterly report", "please find it attached", "see you soon"]);
  assert.deepEqual(phrases(texts, { limit: 2 }), ["quarterly report", "please find it attached"]);
  assert.deepEqual(phrases(texts, { limit: 0 }), []);

  const six = ["alpha beta gamma", "delta epsilon zeta", "eta theta iota", "kappa lambda mu", "nu xi omicron", "pi rho sigma"];
  const many = [0, 1, 2].map((n) => six.join(". ") + ".".repeat(n + 1));
  assert.equal(findRepeatedPhrases(many).length, 5, "default limit");
  assert.equal(findRepeatedPhrases(many, { limit: "9" }).length, 5, "a limit that is not a whole number is ignored");
  assert.equal(findRepeatedPhrases(many, { limit: 10 }).length, 6);
});

test("the same draft saved more than once counts once, even with different spacing", () => {
  const draft = "As you can see, the totals went up.";
  assert.deepEqual(findRepeatedPhrases([draft, draft, draft]), []);
  assert.deepEqual(findRepeatedPhrases([draft, draft + " ", " " + draft.replace(" ", "  ") + "\n"]), []);
  assert.deepEqual(phrases([draft, draft, draft + " Thanks.", "Note: " + draft]), ["as you can see", "the totals went up"]);
});

test("a phrase longer than eight words is offered once, not once per eight-word window", () => {
  // Ten words: three 8-word windows, and "further questions" sits in the last
  // window but outside the first, so only the maximal-phrase rule drops it.
  const texts = [
    "Please let me know if you have any further questions.",
    "Thanks! Please let me know if you have any further questions.",
    "please let me know if you have any further questions",
  ];
  const found = findRepeatedPhrases(texts);
  // "please let me know if you have any" ends on "any", so it is not a candidate.
  assert.deepEqual(found.map(({ phrase, words, count }) => [phrase, words, count]),
    [["let me know if you have any further", 8, 3]]);
  // Dismissing that window does not bring the other window back.
  assert.deepEqual(findRepeatedPhrases(texts, { dismissed: [found[0].phrase] }), []);
});

test("anything that is not text is ignored", () => {
  assert.deepEqual(findRepeatedPhrases(null), []);
  assert.deepEqual(findRepeatedPhrases("as you can see"), []);
  assert.deepEqual(phrases([42, null, ...asYouCanSee, { text: "as you can see" }], { dismissed: "x", shorthands: [null, 5] }),
    ["as you can see"]);
});

test("normalizePhrase is the form to store when a phrase is dismissed", () => {
  assert.equal(normalizePhrase("  As YOU can\u00a0 see: "), "as you can see");
  assert.equal(normalizePhrase("Don\u2019t \t stop"), "don't stop");
  assert.equal(normalizePhrase("Follow\u2010up"), "follow-up");
  assert.equal(normalizePhrase("Follow\u2011up"), "follow-up");
  assert.equal(normalizePhrase(null), "");
  for (const found of findRepeatedPhrases(asYouCanSee)) {
    assert.equal(normalizePhrase(found.display), found.phrase);
    assert.equal(normalizePhrase(found.phrase), found.phrase);
  }
});

test("phrase miner loads in a browser global", () => {
  const context = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/phrase-miner.js"), "utf8"), context);
  assert.equal(context.self.ShorthandPhraseMiner.findRepeatedPhrases(asYouCanSee)[0].trigger, "aycs/");
});
