const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { findBlanks, buildTemplate } = require("../src/template-maker.js");
const template = require("../src/template.js");
const expander = require("../src/expander.js");

const now = new Date(2026, 9, 10, 14, 5);
const found = (text) => findBlanks(text).map(({ kind, value }) => [kind, value]);
const named = (text) => findBlanks(text).map(({ name, value }) => [name, value]);

// What actle inserts for a saved expansion: content.js calls
// template.render(expansion) when nothing needs answering, and the fill-in form
// calls template.render(expansion, answers, now) once the blanks are answered.
// Both go through expander.render for {date}, {cursor} and {{escapes}}.
function insert(expansion, answers) {
  return template.render(expansion, answers || {}, now);
}

function answersFor(blanks) {
  return Object.fromEntries(blanks.map((blank) => [blank.name, blank.value]));
}

// Small, seeded generator so the fuzz cases are the same on every run.
function generator(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("the person after a greeting at the start of a line is a name blank", () => {
  assert.deepEqual(found("Hi Sam,\nThanks."), [["name", "Sam"]]);
  assert.deepEqual(found("Hello Sam Lee!"), [["name", "Sam Lee"]]);
  assert.deepEqual(found("hey Sam"), [["name", "Sam"]]);
  assert.deepEqual(found("Dear Dr. Anna Lee,"), [["name", "Dr. Anna Lee"]]);
  assert.deepEqual(found("Dear Mr Smith,"), [["name", "Mr Smith"]]);
  assert.deepEqual(found("Good morning, Sam,"), [["name", "Sam"]]);
  assert.deepEqual(found("Good evening Sam and Ana,"), [["name", "Sam and Ana"]]);
  assert.deepEqual(found("Hi Zo\u00eb,"), [["name", "Zo\u00eb"]]);
  assert.deepEqual(found("Hi Mary-Jane O\u2019Brien,"), [["name", "Mary-Jane O\u2019Brien"]]);
  assert.deepEqual(found("Notes\n  Hi Sam,"), [["name", "Sam"]]);
  // A couple addressed with two titles is one name, not the first title.
  assert.deepEqual(found("Dear Mr. and Mrs. Lee,"), [["name", "Mr. and Mrs. Lee"]]);
  assert.deepEqual(found("Dear Mr & Mrs Lee,"), [["name", "Mr & Mrs Lee"]]);
  assert.deepEqual(found("Dear Dr. Patel and Mr. Lee,"), [["name", "Dr. Patel and Mr. Lee"]]);
});

test("a title alone is never a name blank, nor repeated as one", () => {
  for (const text of ["Hi Dr.,", "Dear Prof,", "Hello Mrs.!", "Dear Mr. and Mrs.,"]) {
    assert.deepEqual(found(text), [], text);
  }
  const letter = "Dear Mr. and Mrs. Lee,\n\nThank you for meeting with me on October 20. Mr. Lee asked about the reading plan.";
  assert.deepEqual(found(letter), [["name", "Mr. and Mrs. Lee"], ["date", "October 20"]]);
  const blanks = findBlanks(letter).map(({ start, end, name }) => ({ start, end, name }));
  assert.equal(insert(buildTemplate(letter, blanks), { name: "Mr. and Mrs. Park", date: "May 1" }).text,
    "Dear Mr. and Mrs. Park,\n\nThank you for meeting with me on May 1. Mr. Lee asked about the reading plan.");
});

test("greetings that name nobody in particular, or no greeting at all, are not blanks", () => {
  for (const text of ["Hi team,", "Hi Team,", "Dear Sir,", "Hello everyone!", "Hi all,", "Hi there,", "Dear Sir or Madam,",
    "Hi Sam how are you", "Say hi Sam,", "Hi, sam,", "Hi\nSam,", "Hi Sam Lee Kim Park,"]) {
    assert.deepEqual(found(text), [], text);
  }
});

test("email addresses, links and phone numbers are blanks", () => {
  assert.deepEqual(found("Write to sam.lee+work@mail.example.co.uk."), [["email", "sam.lee+work@mail.example.co.uk"]]);
  assert.deepEqual(found("See https://example.com/a?b=1#c, or www.example.org."),
    [["link", "https://example.com/a?b=1#c"], ["link", "www.example.org"]]);
  assert.deepEqual(found("(see https://en.wikipedia.org/wiki/Mercury_(planet))"),
    [["link", "https://en.wikipedia.org/wiki/Mercury_(planet)"]]);
  for (const phone of ["(555) 123-4567", "555-123-4567", "555.123.4567", "555 123 4567", "+44 20 7946 0958",
    "+1 (555) 123-4567", "555-1234", "+33 6 12 34 56 78"]) {
    assert.deepEqual(found(`Call ${phone} today.`), [["phone", phone]], phone);
  }
});

test("dates in words, numbers and ISO form are blanks, and a weekday alone is a day blank", () => {
  for (const date of ["October 20", "Oct 20", "Oct. 20th", "October 20, 2026", "Sept 3 2026", "20 October", "20th of October 2026",
    "Tuesday, October 20", "Tue Oct 20", "Friday the 3rd of May", "20/10/2026", "10/20/26", "20.10.2026", "20-10-2026",
    "2026-10-20", "2026/10/20"]) {
    assert.deepEqual(found(`Due ${date}.`), [["date", date]], date);
  }
  assert.deepEqual(found("See you Monday, or on Friday's call."), [["day", "Monday"], ["day", "Friday"]]);
});

test("times, amounts and order or ticket numbers are blanks", () => {
  for (const time of ["3:30 pm", "3:30pm", "15:00", "9am", "9 a.m.", "12:45:10", "11 PM"]) {
    assert.deepEqual(found(`At ${time} sharp`), [["time", time]], time);
  }
  assert.deepEqual(found("Meet at 3pm."), [["time", "3pm"]], "a full stop after the time stays text");
  for (const amount of ["$1,200.50", "\u20ac30", "30 EUR", "USD 1,200", "30,50 \u20ac", "\u00a35k", "US$40", "$2 million", "1.200,50 EUR"]) {
    assert.deepEqual(found(`It costs ${amount} today`), [["amount", amount]], amount);
  }
  for (const id of ["#12345", "#A-1234", "INV-20481", "AB12345", "TKT_0042", "1234567890"]) {
    assert.deepEqual(found(`Ref ${id} please`), [["number", id]], id);
  }
});

test("years, counts, ratios and other everyday numbers are not blanks", () => {
  for (const text of ["We started in 2026.", "The 2025-2026 plan.", "FY2026 and Q4-2026 goals.", "A 1:1 meeting.", "Scores 3:2.",
    "Pop 1.234.567 or 1 234 567.", "We're #1!", "About 10 people and 1200 chairs.", "May I ask?", "On Mondays we meet.",
    "Visit example.com or www.", "Version 1.2.3 is out.", "Read pages 10-12.", "x86_64 builds", "Room 101 102 103",
    // An address without a real top-level domain, a day/month/year that is no
    // date, and digits inside a decimal or a version.
    "Contact admin@10.0.0.1 or sam@x.c", "Due 13/13/2026 or 45/67/2026", "Pi is 3.14159 and v1.20481 shipped",
    // Fiscal periods, standards, named days and ZIP+4 codes read as other kinds.
    "Plan for FY2026, CY-2025, H1 2026, 2026Q4 and Q3/2026.", "We follow ISO 27001, ISO/IEC 27002, EN 71 and RFC9110.",
    "Our Black Friday sale runs to Cyber Monday; Good Friday and Easter Monday are off."]) {
    assert.deepEqual(found(text), [], text);
  }
  assert.deepEqual(found("Ship to 94107-1234 today."), [["number", "94107-1234"]], "a ZIP+4 code is not a phone number");
});

test("ticket and invoice numbers with four digits are blanks, even when the digits look like a year", () => {
  for (const id of ["INV-2041", "SUP-2033", "PO-2050", "ENG-2034", "A1999"]) {
    assert.deepEqual(found(`Ref ${id} please`), [["number", id]], id);
  }
  assert.deepEqual(found("See you Friday, after Black Friday."), [["day", "Friday"]]);
});

test("the same value shares one blank and each new value gets the next number", () => {
  const text = "Hi Sam,\nOn Oct 20 at 3pm, then Oct 21 at 3pm, and again Oct 20 or Oct 22. Thanks again, Sam!";
  assert.deepEqual(named(text), [
    ["name", "Sam"], ["date", "Oct 20"], ["time", "3pm"], ["date2", "Oct 21"], ["time", "3pm"],
    ["date", "Oct 20"], ["date3", "Oct 22"], ["name", "Sam"],
  ]);
  const names = new Set(findBlanks(text + " Dear Ana, $5 $6 #12345 #12346").map((blank) => blank.name));
  for (const name of names) {
    assert.match(name, /^[a-z]+[0-9]*$/);
    assert.deepEqual(template.fields(`[[${name}]]`), [{ name, label: name }]);
  }
});

test("later mentions of the greeting name share its blank, matching whole words in the same case", () => {
  assert.deepEqual(named("Hi Sam,\nSam, could you check Samantha's note? sam@x.com. Thanks, Sam's team"), [
    ["name", "Sam"], ["name", "Sam"], ["email", "sam@x.com"], ["name", "Sam"],
  ]);
});

test("the writer's sign-off and the lines under it are never blanks", () => {
  const email = "Hi Sam,\nThe call is on Oct 20.\n\nBest regards,\nJane Doe\njane@acme.com\n555-987-6543\nhttps://acme.com";
  assert.deepEqual(found(email), [["name", "Sam"], ["date", "Oct 20"]]);
  // The writer signing with the same name as the reader is still the writer.
  assert.deepEqual(named("Hi Sam,\nSam, see you Monday.\nCheers,\nSam"), [["name", "Sam"], ["name", "Sam"], ["day", "Monday"]]);
  assert.deepEqual(found("Hi Sam,\nSee you Monday.\nThanks, Sam"), [["name", "Sam"], ["day", "Monday"]]);
  assert.deepEqual(found("Hi Sam,\nSee you Monday.\nSincerely\n\nSam Lee\n+1 555 123 4567"), [["name", "Sam"], ["day", "Monday"]]);
  for (const signoff of ["Thanks,", "Cheers,", "Sincerely,", "Best,", "Kind regards,", "Thank you so much!", "Regards"]) {
    assert.deepEqual(found(`Hi Sam,\nSee you Monday.\n${signoff}\nSam\n555-123-4567`), [["name", "Sam"], ["day", "Monday"]], signoff);
  }
});

test("a closing without a comma signs off when a name follows it, however long the signature", () => {
  const signature = "Priya Shah\npriya@shahdesign.studio\n(312) 555-0187\nhttps://shahdesign.studio";
  for (const closing of ["Kind regards", "Cheers!", "Thanks!", "Best regards!", "Best", "Regards", "Thanks in advance,",
    "Thank you for your time,", "Thank you for your help,", "Have a great week,", "Have a nice day!", "All best,",
    "Talk to you soon,", "Speak soon,", "Looking forward to hearing from you,", "With gratitude,", "Thx,"]) {
    const email = `Hi Jordan,\n\nThe invoice for $1,250.00 is due on November 15.\n\n${closing}\n${signature}`;
    assert.deepEqual(found(email), [["name", "Jordan"], ["amount", "$1,250.00"], ["date", "November 15"]], closing);
  }
  // Without a name under it, a bare "Thanks" mid-email still hides nothing.
  assert.deepEqual(found("Hi Sam,\nThanks\nthe call moved to Oct 20.\nIt starts at 3pm.\nMore soon.\nJane"),
    [["name", "Sam"], ["date", "Oct 20"], ["time", "3pm"]]);
});

test("a thank-you that is not a sign-off does not hide the rest of the email", () => {
  assert.deepEqual(found("Hi Sam,\nThanks!\nThe call moved to Oct 20.\nIt starts at 3pm.\nSee you then,\nJane"),
    [["name", "Sam"], ["date", "Oct 20"], ["time", "3pm"]]);
  assert.deepEqual(found("Thanks for the update on Oct 20."), [["date", "Oct 20"]]);
  assert.deepEqual(found("Hi Sam,\nThanks,\nOct 20 works.\nOct 21 too.\nOct 22.\nOct 23.\nOct 24.\nOct 25.\nOct 26.\nOct 27.\nOct 28.\nBye").length, 10);
});

test("blanks never overlap and come in reading order", () => {
  assert.deepEqual(found("On 2026-10-20 15:00 call 555-123-4567 about INV-20481 ($1,200)."),
    [["date", "2026-10-20"], ["time", "15:00"], ["phone", "555-123-4567"], ["number", "INV-20481"], ["amount", "$1,200"]]);
  assert.deepEqual(found("Order https://x.com/orders/12345?d=2026-10-20 from sam@x.com"),
    [["link", "https://x.com/orders/12345?d=2026-10-20"], ["email", "sam@x.com"]]);
  const blanks = findBlanks("Hi Sam,\nTuesday, October 20 at 3:30 pm: #12345, $30, sam@x.com, +1 555 123 4567.");
  for (let i = 1; i < blanks.length; i++) assert.ok(blanks[i - 1].end <= blanks[i].start);
  for (const blank of blanks) assert.equal(blank.value, "Hi Sam,\nTuesday, October 20 at 3:30 pm: #12345, $30, sam@x.com, +1 555 123 4567.".slice(blank.start, blank.end));
});

test("with no blanks chosen, the template inserts exactly the draft", () => {
  const drafts = [
    "Plain text.",
    "Report for {date} at {time}, {datetime} and {date+7}.",
    "Put the caret here: {cursor}",
    "Escaped already: {{date}} and {{{time}}} and {{cursor}",
    "Pronouns {subject} {Object2} {POSSESSIVE} and days {weekday} {weekday+1}",
    "Unknown {foo} {foo2} {date5} {date+12345} { date } {} {",
    "Blanks [[name]] [[ Name ]] \\[[name]] \\\\[[name]] and invalid [[]] [[ ]] [[a[b]] [[line\nbreak]] [[a\rb]]",
    "Unclosed [[name and more {date} text",
    "[[[[nested]]]] ]] [[ [x]] \\[[]] \\",
    "Ends with a backslash \\",
    "Private use \ue000 \ue0000\ue001 {cursor}\ue001",
    "Emoji \ud83d\ude00 {date} and CRLF\r\nline",
    "",
  ];
  for (const draft of drafts) {
    const expansion = buildTemplate(draft, []);
    assert.deepEqual(template.fields(expansion), [], draft);
    assert.equal(template.requiresInput(expansion), false, draft);
    assert.deepEqual(insert(expansion), { text: draft, cursorOffset: draft.length }, draft);
  }
});

test("placeholders and blank syntax are written with actle's own escapes", () => {
  assert.equal(buildTemplate("{date} {cursor} {subject} {foo}", []), "{{date}} {{cursor}} {{subject}} {{foo}}");
  assert.equal(buildTemplate("{{date}}", []), "{{{date}}}");
  assert.equal(buildTemplate("[[name]] \\[[name]]", []), "\\[[name]] \\\\[[name]]");
  assert.equal(buildTemplate("[[ ]] [[a\nb]] {date5} [[open", []), "[[ ]] [[a\nb]] {date5} [[open");
  assert.equal(buildTemplate("[[{date}]]", []), "\\[[{{date}}]]");
  // The shared renderer reads the escapes the same way.
  assert.equal(expander.render("{{date}} {{foo}}", now).text, "{date} {foo}");
});

test("random drafts round-trip exactly, with no blanks and with any choice of blanks", () => {
  const random = generator(20261020);
  const pieces = ["{", "}", "[", "]", "[[", "]]", "\\", "date", "cursor", "subject", "weekday", "Date", "2", "5", "+1", "-30",
    " ", "\n", "\r", "x", "Hi Sam,", "Sam", "Oct 20", "2026-10-21", "sam@x.com", "$30", "#12345", "3pm", "\ue000", "\ue0000\ue001"];
  let withBlanks = 0;
  for (let round = 0; round < 20000; round++) {
    let draft = "";
    const length = 1 + Math.floor(random() * 14);
    for (let i = 0; i < length; i++) draft += pieces[Math.floor(random() * pieces.length)];

    const plain = buildTemplate(draft, []);
    assert.deepEqual(insert(plain), { text: draft, cursorOffset: draft.length }, JSON.stringify(draft));
    assert.equal(template.requiresInput(plain), false, JSON.stringify(draft));

    const chosen = findBlanks(draft).filter(() => random() < 0.6);
    if (chosen.length > 0) withBlanks++;
    const expansion = buildTemplate(draft, chosen);
    assert.deepEqual(template.fields(expansion).map((field) => field.name),
      [...new Set(chosen.map((blank) => blank.name))], JSON.stringify({ draft, expansion }));
    assert.equal(insert(expansion, answersFor(chosen)).text, draft, JSON.stringify({ draft, expansion }));
  }
  assert.ok(withBlanks > 2000, "the fuzz must exercise blanks next to brackets, braces and backslashes");
});

test("chosen blanks become [[name]] and the rest stays literal", () => {
  const draft = "Hi Sam,\n\nYour order #12345 ships on October 20, 2026 for $30. Reply by October 20, 2026.\n\nThanks,\nJane";
  const blanks = findBlanks(draft);
  assert.deepEqual(blanks.map((blank) => blank.name), ["name", "number", "date", "amount", "date"]);
  const chosen = blanks.filter((blank) => blank.kind !== "number").map((blank) =>
    blank.kind === "amount" ? { ...blank, name: "Price" } : blank);
  const expansion = buildTemplate(draft, chosen);
  assert.equal(expansion,
    "Hi [[name]],\n\nYour order #12345 ships on [[date]] for [[Price]]. Reply by [[date]].\n\nThanks,\nJane");
  assert.deepEqual(template.fields(expansion).map((field) => field.name), ["name", "date", "Price"]);
  assert.equal(insert(expansion, { name: "Ana", date: "May 1", Price: "\u20ac40" }).text,
    "Hi Ana,\n\nYour order #12345 ships on May 1 for \u20ac40. Reply by May 1.\n\nThanks,\nJane");
  assert.equal(insert(expansion, answersFor(chosen)).text, draft);
  // Answers are inserted as typed, even when they look like placeholders.
  assert.equal(insert(buildTemplate("Hi Sam, see {date}.", findBlanks("Hi Sam, see {date}.")), { name: "{cursor}" }).text,
    "Hi {cursor}, see {date}.");
});

test("an email with a greeting and a date becomes a template with [[name]] and [[date]]", () => {
  const draft = "Hi Sam,\n\nJust confirming our meeting on Tuesday, October 20 at the office.\n\nBest regards,\nJane";
  const expansion = buildTemplate(draft, findBlanks(draft));
  assert.equal(expansion, "Hi [[name]],\n\nJust confirming our meeting on [[date]] at the office.\n\nBest regards,\nJane");
  assert.equal(template.requiresInput(expansion), true);
});

test("a value right after a backslash, a [ or an unclosed [[ is not offered, and cannot be forced", () => {
  assert.deepEqual(found("Path \\12345 and [Oct 20] and \\\\[[x]] 2026-10-20"), [["date", "2026-10-20"]]);
  assert.deepEqual(found("Note [[draft Oct 20 and $30"), []);
  assert.deepEqual(found("Note [[draft]] Oct 20 and $30"), [["date", "Oct 20"], ["amount", "$30"]]);
  assert.deepEqual(found("Note [[draft Oct 20]] and $30"), [["amount", "$30"]]);
  assert.throws(() => buildTemplate("Path \\12345", [{ start: 6, end: 11, name: "number" }]), RangeError);
  assert.throws(() => buildTemplate("[Oct 20]", [{ start: 1, end: 7, name: "date" }]), RangeError);
  assert.throws(() => buildTemplate("[[open Oct 20", [{ start: 7, end: 13, name: "date" }]), RangeError);
  // After an earlier blank that ends right before it, a blank is fine.
  assert.equal(buildTemplate("ab", [{ start: 0, end: 1, name: "x" }, { start: 1, end: 2, name: "y" }]), "[[x]][[y]]");
});

test("buildTemplate refuses blanks that overlap, fall outside the draft or have unusable names", () => {
  const draft = "Due Oct 20.";
  for (const chosen of [
    [{ start: 4, end: 10, name: "date" }, { start: 8, end: 10, name: "day" }],
    [{ start: -1, end: 3, name: "x" }],
    [{ start: 4, end: 99, name: "x" }],
    [{ start: 5, end: 5, name: "x" }],
    [{ start: 4.5, end: 6, name: "x" }],
    [{ start: 4, end: 10, name: " " }],
    [{ start: 4, end: 10, name: "a]b" }],
    [{ start: 4, end: 10, name: "a\nb" }],
    [null],
  ]) {
    assert.throws(() => buildTemplate(draft, chosen), RangeError, JSON.stringify(chosen));
  }
  assert.equal(buildTemplate(draft, [{ start: 4, end: 10, name: " due date " }]), "Due [[ due date ]].");
  assert.equal(buildTemplate(draft, null), "Due Oct 20.");
  assert.equal(buildTemplate(null, []), "");
});

test("template maker loads in a browser global", () => {
  const context = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/template-maker.js"), "utf8"), context);
  const maker = context.self.ShorthandTemplateMaker;
  const draft = "Hi Sam, on Oct 20.";
  assert.equal(maker.buildTemplate(draft, maker.findBlanks(draft)), "Hi [[name]], on [[date]].");
});
