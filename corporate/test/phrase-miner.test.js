const test = require("node:test");
const assert = require("node:assert/strict");
const miner = require("../core/phrase-miner.js");

const SENTENCE = "Thanks for reaching out to our support team.";
const messages = [
  "Hi John,\n\n" + SENTENCE + " We will get back to you within one business day.\n\nBest regards,\nAlex",
  "Hi Mary,\n\n" + SENTENCE + " We will get back to you within one business day.\n\nBest regards,\nAlex",
  "Hello,\n\n" + SENTENCE + " Your ticket is open.\n\nBest regards,\nAlex",
  "Totally unrelated message about lunch plans for the whole team today.",
];

test("splitting into paragraphs and sentences normalises whitespace", () => {
  assert.deepEqual(miner.splitParagraphs("one  two\n\n\n three\nfour\n\n"), ["one two", "three four"]);
  assert.deepEqual(miner.splitSentences("First one. Second one! Third? Trailing"), ["First one.", "Second one!", "Third?", "Trailing"]);
  assert.deepEqual(miner.splitSentences(""), []);
});

test("mine proposes texts recurring across distinct sessions only", () => {
  const found = miner.mine(messages);
  assert.deepEqual(found.map((f) => [f.text, f.sessions, f.kind]), [[SENTENCE, 3, "sentence"]]);
  assert.equal(found[0].suggestedTrigger, "tfro/");
  assert.equal(found[0].words, 8);
  // Repeating a line inside one message does not make it recur.
  const repeated = [SENTENCE + " " + SENTENCE + " " + SENTENCE];
  assert.deepEqual(miner.mine(repeated), []);
  assert.deepEqual(miner.mine(messages, { minCount: 4 }), []);
});

test("mine keeps maximal texts and drops phrases already in the library", () => {
  const two = messages.slice(0, 2);
  const found = miner.mine(two, { minCount: 2 });
  const texts = found.map((f) => f.text);
  assert.ok(texts.includes(SENTENCE + " We will get back to you within one business day."), texts.join(" | "));
  assert.ok(!texts.includes(SENTENCE), "the sentence is covered by the paragraph seen as often");
  assert.ok(!texts.some((t) => t === "reaching out to our support"), "sub-phrases are not proposed");
  const filtered = miner.mine(messages, { existing: [SENTENCE] });
  assert.deepEqual(filtered, []);
});

test("suggestTrigger uses initials and avoids taken triggers", () => {
  assert.equal(miner.suggestTrigger("Thanks for reaching out to our team"), "tfro/");
  assert.equal(miner.suggestTrigger("Thanks for reaching out to our team", ["tfro/"]), "tfrot/");
  assert.equal(miner.suggestTrigger("Thanks for reaching out", ["tfro/"]), "tfro2/");
  assert.equal(miner.suggestTrigger("Thanks for reaching out", ["tfro/", "tfro2/"]), "tfro3/");
  assert.equal(miner.suggestTrigger("!!! ???"), "phrase/");
  const found = miner.mine(messages, { minCount: 2, takenTriggers: ["tfro/"] });
  assert.ok(found.every((f) => f.suggestedTrigger !== "tfro/"));
  assert.equal(new Set(found.map((f) => f.suggestedTrigger)).size, found.length);
});

test("mine honours limit and length bounds and tolerates junk input", () => {
  assert.deepEqual(miner.mine(null), []);
  assert.deepEqual(miner.mine([null, 42, { text: null }]), []);
  assert.equal(miner.mine(messages.slice(0, 2), { minCount: 2, limit: 1 }).length, 1);
  assert.deepEqual(miner.mine(messages, { maxLength: 10 }), []);
});
