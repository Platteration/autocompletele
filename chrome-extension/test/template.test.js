const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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
