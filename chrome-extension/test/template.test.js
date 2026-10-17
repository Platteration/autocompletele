const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const template = require("../src/template.js");
const expander = require("../src/expander.js");
const now = new Date(2026, 9, 10, 14, 5);

test("template fields preserve first appearance, trimmed names, and case", () => {
  assert.deepEqual(template.fields("Hi [[ Customer name ]]. [[Customer name]] meets [[customer name]]."), [
    { name: "Customer name", label: "Customer name" },
    { name: "customer name", label: "customer name" },
  ]);
});

test("template parts expose text and original field spelling for previews", () => {
  assert.deepEqual(template.parts("Hi [[ name ]]!"), [
    { type: "text", value: "Hi " },
    { type: "field", name: "name", label: "name", raw: "[[ name ]]" },
    { type: "text", value: "!" },
  ]);
  assert.deepEqual(template.parts(null), []);
  assert.deepEqual(template.fields("No blanks here"), []);
});

test("empty, nested, multiline and unclosed fields stay literal", () => {
  const text = "[[]] [[ ]] [[[[nested]]]] [[line\nbreak]] [[line\rbreak]] [[unfinished";
  assert.deepEqual(template.fields(text), []);
  assert.equal(template.fill(text, { nested: "changed" }), text);
});

test("backslash escapes a named blank without requesting an answer", () => {
  const text = "Use \\[[name]] then [[name]], and leave \\[[ ]] alone.";
  assert.deepEqual(template.fields(text), [{ name: "name", label: "name" }]);
  assert.equal(template.fill(text, { name: "Alex" }), "Use [[name]] then Alex, and leave \\[[ ]] alone.");
});

test("fill repeats an answer without trimming or reparsing it", () => {
  assert.equal(template.fill("[[name]] / [[ name ]] / [[other]]", {
    name: "  [[other]]\n$& <b>Alex</b>  ", other: "Morgan",
  }), "  [[other]]\n$& <b>Alex</b>   /   [[other]]\n$& <b>Alex</b>   / Morgan");
});

test("missing values remain literal while explicit empty answers clear blanks", () => {
  assert.equal(template.fill("[[ missing ]] [[empty]] [[zero]]", { empty: "", zero: 0 }), "[[ missing ]]  0");
  assert.equal(template.fill("[[ name ]]", null), "[[ name ]]");
});

test("names do not access inherited properties or mutate prototypes", () => {
  const text = "[[__proto__]] [[constructor]] [[toString]]";
  assert.equal(template.fill(text, {}), text);
  const values = JSON.parse('{"__proto__":"first","constructor":"second","toString":"third"}');
  assert.equal(template.fill(text, values), "first second third");
  assert.equal(template.render(text, values, now).text, "first second third");
  assert.equal({}.first, undefined);
});

test("render evaluates original built-ins and preserves answer tokens verbatim", () => {
  assert.deepEqual(template.render("On {date} at {time}: [[answer]]{cursor}!", {
    answer: "{date} {cursor} {{time}} [[again]]",
  }, now), {
    text: "On 2026-10-10 at 14:05: {date} {cursor} {{time}} [[again]]!",
    cursorOffset: "On 2026-10-10 at 14:05: {date} {cursor} {{time}} [[again]]".length,
  });
});

test("render preserves built-in escapes and uses the first real cursor", () => {
  assert.deepEqual(template.render("{{cursor}} [[x]]{cursor} [[y]]{cursor} {datetime}", {
    x: "alpha", y: "beta",
  }, now), { text: "{cursor} alpha beta 2026-10-10 14:05", cursorOffset: 14 });
});

test("render adjusts cursor offsets before, between, and after answers", () => {
  assert.deepEqual(template.render("{cursor}[[a]][[b]]", { a: "long value", b: "B" }, now), {
    text: "long valueB", cursorOffset: 0,
  });
  assert.deepEqual(template.render("[[a]]{cursor}[[b]]", { a: "", b: "long value" }, now), {
    text: "long value", cursorOffset: 0,
  });
  assert.deepEqual(template.render("[[a]] [[a]]", { a: "😀" }, now), {
    text: "😀 😀", cursorOffset: 5,
  });
});

test("marker-like source and answers cannot corrupt rendered text", () => {
  const source = "\uE0000\uE001 [[answer]]{cursor} [[other]]";
  const values = { answer: "\uE000\uE0001\uE001 $&", other: "\uE000\uE000\uE0000\uE001", unused: "\uE000".repeat(8) };
  const text = "\uE0000\uE001 " + values.answer + " " + values.other;
  assert.deepEqual(template.render(source, values, now), {
    text, cursorOffset: "\uE0000\uE001 ".length + values.answer.length,
  });
});

test("cursor removal cannot turn literal source into a valid answer marker", () => {
  assert.deepEqual(template.render("\uE000{cursor}\uE0000\uE001 [[x]]", { x: "ANSWER" }, now), {
    text: "\uE000\uE0000\uE001 ANSWER", cursorOffset: 1,
  });
});

test("cursor removal cannot turn an ordinary expansion into an unknown answer marker", () => {
  const source = "\uE000{cursor}\uE0007\uE001";
  assert.deepEqual(template.render(source, {}, now), expander.render(source, now));
});

test("multiple cursor removals preserve joined private-use text and literal values", () => {
  const source = "[[x]]\uE000{CURSOR}\uE000{cursor}\uE0000\uE001 [[x]]";
  assert.deepEqual(template.render(source, { x: "{date}" }, now), {
    text: "{date}\uE000\uE000\uE0000\uE001 {date}", cursorOffset: 7,
  });
});

test("missing fields remain exact literals even when their names resemble built-ins", () => {
  assert.deepEqual(template.render("[[ {date} ]]!", {}, now), {
    text: "[[ {date} ]]!", cursorOffset: 13,
  });
});

test("ordinary expansions keep the existing renderer's exact behavior", () => {
  for (const text of ["hello", "{date} {cursor}{time}", "{{date}} {unknown}", "", "😀{cursor}x"]) {
    assert.deepEqual(template.render(text, {}, now), expander.render(text, now));
  }
});

test("template helper loads in a browser global after the expander", () => {
  const context = vm.createContext({ self: {} });
  for (const file of ["expander.js", "template.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  }
  assert.equal(context.self.ShorthandTemplate.fill("Hi [[name]]", { name: "Alex" }), "Hi Alex");
  assert.equal(context.self.ShorthandTemplate.render("[[name]]{cursor}!", { name: "Alex" }).cursorOffset, 4);
});

test("variable parts retain token spelling and expose meaningful labels", () => {
  assert.deepEqual(template.parts("On {weekday}, {Subject} meets [[subject]]."), [
    { type: "text", value: "On " },
    { type: "variable", name: "weekday", label: "Weekday", raw: "{weekday}" },
    { type: "text", value: ", " },
    { type: "variable", name: "subject", label: "Subject pronoun", raw: "{Subject}" },
    { type: "text", value: " meets " },
    { type: "field", name: "subject", label: "subject", raw: "[[subject]]" },
    { type: "text", value: "." },
  ]);
});

test("variables list only active browser tokens in first appearance order", () => {
  assert.deepEqual(template.variables(
    "{Subject} {{object}} {WEEKDAY} {subject} [[{reflexive}]] {possessivepronoun} {object} {date} {unknown}"
  ), ["subject", "weekday", "possessivepronoun", "object"]);
  assert.deepEqual(template.variables(null), []);
  assert.deepEqual(template.fields("{subject} [[subject]] [[subject]]"), [
    { name: "subject", label: "subject" },
  ]);
});

test("pronoun-only scripts require input while weekdays and escaped tokens do not", () => {
  for (const text of ["{subject}", "{OBJECT}", "[[name]]", "{weekday} {Reflexive}"]) {
    assert.equal(template.requiresInput(text), true, text);
  }
  for (const text of ["{weekday}", "{{subject}} {{object}}", "\\[[name]]", "{unknown}", "", null]) {
    assert.equal(template.requiresInput(text), false, String(text));
  }
});

test("weekday renders full English names for each local calendar day", () => {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  days.forEach((day, index) => {
    const date = new Date(2026, 9, 11 + index, 14, 5);
    assert.deepEqual(template.render("{weekday} {Weekday} {WEEKDAY}", {}, date), {
      text: `${day} ${day} ${day.toUpperCase()}`,
      cursorOffset: day.length * 3 + 2,
    });
  });
});

test("weekday shifts by whole days without asking for input", () => {
  const sunday = new Date(2026, 9, 11, 14, 5);
  assert.equal(template.render("{weekday+1} {weekday-1} {weekday+7} {Weekday+2} {WEEKDAY+3}", {}, sunday).text,
    "Monday Saturday Sunday Tuesday WEDNESDAY");
  assert.equal(template.requiresInput("{weekday+1} on {date+7}"), false);
  assert.deepEqual(template.variables("{weekday+1} {weekday-2}"), ["weekday"]);
  assert.equal(template.render("{subject+1}", {}, sunday).text, "{subject+1}");
  assert.equal(template.requiresInput("{subject+1}"), false);
});

test("weekday uses the local date when UTC is already the next day", () => {
  const output = execFileSync(process.execPath, ["-e", `
    const template = require(${JSON.stringify(path.resolve(__dirname, "../src/template.js"))});
    process.stdout.write(template.render("{weekday}", {}, new Date("2026-10-11T01:00:00Z")).text);
  `], { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" });
  assert.equal(output, "Saturday");
});

test("pronoun presets provide all five forms and are immutable", () => {
  const source = "{subject}/{object}/{possessive}/{possessivepronoun}/{reflexive}";
  const expected = {
    "she/her": "she/her/her/hers/herself",
    "he/him": "he/him/his/his/himself",
    "they/them": "they/them/their/theirs/themself",
  };
  assert.deepEqual(Object.keys(template.pronounPresets), Object.keys(expected));
  assert.equal(Object.isFrozen(template.pronounPresets), true);
  for (const [name, text] of Object.entries(expected)) {
    assert.equal(Object.isFrozen(template.pronounPresets[name]), true);
    assert.deepEqual(template.render(source, {}, now, template.pronounPresets[name]), {
      text, cursorOffset: text.length,
    });
  }
});

test("pronoun title and uppercase tokens apply case without reparsing values", () => {
  const pronouns = { subject: "xe {date} [[name]]", object: "ßem", reflexive: "themself" };
  const source = "{subject} | {Subject} | {SUBJECT} | {Object} | {OBJECT} | {rEfLeXiVe}";
  const text = "xe {date} [[name]] | Xe {date} [[name]] | XE {DATE} [[NAME]] | SSem | SSEM | themself";
  assert.deepEqual(template.render(source, { name: "ignored" }, now, pronouns), {
    text, cursorOffset: text.length,
  });
});

test("blank answers and custom pronouns cannot evaluate each other's tokens", () => {
  const answers = { name: "{subject} {weekday} {cursor} [[again]]" };
  const pronouns = { subject: "{date} {weekday} {cursor} [[name]] $&", object: "" };
  const source = "[[name]] / {subject}{cursor} / {object} / [[name]]";
  const beforeCursor = answers.name + " / " + pronouns.subject;
  assert.deepEqual(template.render(source, answers, now, pronouns), {
    text: beforeCursor + " /  / " + answers.name, cursorOffset: beforeCursor.length,
  });
});

test("missing or inherited pronouns stay literal with no default selection", () => {
  const source = "{Subject} {object} {possessive} {possessivepronoun} {reflexive}";
  assert.deepEqual(template.render(source, {}, now), { text: source, cursorOffset: source.length });
  const pronouns = Object.create({ subject: "she", object: "her" });
  pronouns.reflexive = "themself";
  assert.equal(template.render(source, {}, now, pronouns).text,
    "{Subject} {object} {possessive} {possessivepronoun} themself");
  assert.equal(template.render("{subject}", { subject: "blank answer" }, now).text, "{subject}");
});

test("escaped variables remain literal and blanks-only fill preserves variables", () => {
  const source = "{{weekday}} {{Subject}} {{{object}}} {subject} [[subject]]";
  assert.equal(template.render(source, { subject: "Alex" }, now, { subject: "they", object: "them" }).text,
    "{weekday} {Subject} {{object}} they Alex");
  assert.equal(template.fill(source, { subject: "Alex" }),
    "{{weekday}} {{Subject}} {{{object}}} {subject} Alex");
});

test("new variables inside blank names and escaped blanks do not become separate prompts", () => {
  const source = "\\[[{subject}]] \\[[{weekday}]] [[{object}]]";
  assert.deepEqual(template.variables(source), []);
  assert.deepEqual(template.fields(source), [{ name: "{object}", label: "{object}" }]);
  assert.equal(template.requiresInput("\\[[{subject}]] \\[[{weekday}]]"), false);
  assert.equal(template.render(source, { "{object}": "Alex" }, now, { subject: "they", object: "them" }).text,
    "[[{subject}]] [[{weekday}]] Alex");
});

test("repeated pronouns share their answer and preserve UTF-16 cursor offsets", () => {
  assert.deepEqual(template.render("{subject} [[name]]{cursor} {Subject} {SUBJECT}", { name: "😀" }, now,
    { subject: "ßie" }), { text: "ßie 😀 SSie SSIE", cursorOffset: 6 });
  assert.deepEqual(template.render("{cursor}{weekday}{subject}", {}, now, { subject: "they" }), {
    text: "Saturdaythey", cursorOffset: 0,
  });
  assert.deepEqual(template.render("{subject}{cursor}[[name]]", { name: "Alex" }, now, { subject: "" }), {
    text: "Alex", cursorOffset: 0,
  });
});

test("variable replacements preserve marker-like literals and custom values", () => {
  const pronouns = { subject: "\uE000\uE0001\uE001", unused: "\uE000".repeat(12) };
  assert.deepEqual(template.render("\uE000{cursor}\uE0000\uE001 {subject} [[name]]", { name: "\uE0000\uE001" }, now, pronouns), {
    text: "\uE000\uE0000\uE001 \uE000\uE0001\uE001 \uE0000\uE001", cursorOffset: 1,
  });
});

test("numbered pronoun variables name up to four people and person 1 is the plain name", () => {
  const parsed = template.parts("{subject} {Possessive2} {object3} {REFLEXIVE4} {subject1}").filter((part) => part.type === "variable");
  assert.deepEqual(parsed.map(({ name, person, raw }) => ({ name, person, raw })), [
    { name: "subject", person: undefined, raw: "{subject}" },
    { name: "possessive", person: 2, raw: "{Possessive2}" },
    { name: "object", person: 3, raw: "{object3}" },
    { name: "reflexive", person: 4, raw: "{REFLEXIVE4}" },
    { name: "subject", person: 1, raw: "{subject1}" },
  ]);
  assert.deepEqual(template.pronounPeople("{object3} {subject} {possessive2} {subject1} {object} {weekday} {possessive2}"), [
    { person: 1, names: ["subject", "object"] },
    { person: 2, names: ["possessive"] },
    { person: 3, names: ["object"] },
  ]);
  assert.deepEqual(template.pronounPeople("{weekday} [[name]]"), []);
});

test("out-of-range people, numbered weekdays and shifted pronouns stay literal", () => {
  const sunday = new Date(2026, 9, 11, 12);
  for (const token of ["{subject5}", "{subject0}", "{weekday2}", "{subject2+1}", "{possessive12}"]) {
    assert.equal(template.render(token, {}, sunday, template.presetFor("she/her", 2)).text, token, token);
    assert.equal(template.requiresInput(token), false, token);
  }
  assert.equal(template.requiresInput("{possessive2}"), true);
});

test("each person's pronouns render independently with their own capitalisation", () => {
  const pronouns = { ...template.presetFor("she/her", 1), ...template.presetFor("he/him", 2), ...template.presetFor("they/them", 4) };
  assert.deepEqual(pronouns.subject2, "he");
  assert.equal(
    template.render("{Subject} lent {possessive} car to {object2}; {Subject2} thanked {object1}. {POSSESSIVEPRONOUN4} too.", {}, now, pronouns).text,
    "She lent her car to him; He thanked her. THEIRS too.");
  assert.equal(template.render("{subject} and {subject3}", {}, now, template.presetFor("she/her", 1)).text, "she and {subject3}",
    "a person without a choice stays literal");
});

test("escaped numbered pronouns stay literal without asking for input", () => {
  assert.equal(template.requiresInput("{{possessive2}}"), false);
  assert.equal(template.render("{{possessive2}} [[x]]", { x: "y" }, now, template.presetFor("he/him", 2)).text, "{possessive2} y");
  assert.equal(expander.render("{{subject3}}", now).text, "{subject3}");
});
