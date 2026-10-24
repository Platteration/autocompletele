const test = require("node:test");
const assert = require("node:assert/strict");
const notes = require("../core/notes.js");

// Wednesday 21 October 2026, local time, as the shared renderers format it.
const NOW = new Date(2026, 9, 21, 9, 30);

const NOTES = {
  author: "[[author]]",
  actions: { heading: "Action items", patterns: ["TODO", "ACTION", " "] },
  documents: [
    {
      id: "minutes",
      trigger: "/mins",
      label: "Meeting minutes",
      title: "Minutes – [[meeting]]",
      sections: [
        { heading: "Details", body: ["{weekday} {date}", "Minute taker: [[author]]"] },
        { heading: "Attendees", body: "- [[attendees]]" },
        { heading: "Discussion" },
        { heading: "Item: [[topic]]", body: "Notes:", repeat: true },
        7,
        { body: "   " },
      ],
    },
    { id: "handover", trigger: "/handover", sections: ["Patients", { heading: "Next shift", body: "{cursor}" }], actions: false },
    { id: "minutes", trigger: "/mins2", sections: ["Copy"], actions: "yes" },
    { id: "dup", trigger: "/mins", sections: ["X"] },
    { id: "notrigger", sections: ["X"] },
    { id: "empty", trigger: "/empty", sections: [] },
    "junk",
  ],
};

const config = notes.normalizeNotes(NOTES);
const minutes = config.documents[0];
const handover = config.documents[1];

test("normalizeNotes keeps usable parts and explains what it dropped", () => {
  assert.deepEqual(config.documents.map((d) => [d.id, d.trigger]), [["minutes", "/mins"], ["handover", "/handover"], ["minutes-dup", "/mins2"]]);
  assert.equal(config.author, "author");
  assert.equal(config.dateOrder, "dmy");
  assert.deepEqual(config.actions.patterns, ["TODO", "ACTION"]);
  assert.equal(minutes.label, "Meeting minutes");
  assert.equal(handover.label, "handover", "the label falls back to the id");
  assert.deepEqual(minutes.sections.map((s) => [s.heading, s.repeat]), [["Details", false], ["Attendees", false], ["Discussion", false], ["Item: [[topic]]", true]]);
  assert.equal(minutes.sections[0].body, "{weekday} {date}\nMinute taker: [[author]]", "a body given as lines is joined");
  assert.deepEqual(handover.sections[0], { heading: "Patients", body: "", repeat: false }, "a string section is a heading");
  assert.equal(handover.actions, null, "actions: false switches the block off");
  assert.equal(config.documents[2].actions, config.actions, "an invalid actions value inherits the policy's");
  const text = config.warnings.join("\n");
  for (const expected of [/actions: 1 empty pattern/, /minutes section 4 ignored: not an object/, /minutes section 5 ignored: no heading or body/,
    /minutes-dup actions ignored/, /dup ignored: duplicate trigger \/mins/, /notrigger ignored: no trigger/, /empty ignored: no usable sections/, /document 6 ignored: not an object/]) {
    assert.match(text, expected);
  }
  assert.equal(config.warnings.length, 8);
  assert.deepEqual(notes.normalizeNotes(undefined), { documents: [], author: "author", dateOrder: "dmy", actions: notes.DEFAULT_ACTIONS, warnings: [] });
  assert.match(notes.normalizeNotes("nope").warnings[0], /notes section ignored/);
  const odd = notes.normalizeNotes({ author: "[[a]b]]", dateOrder: "ymd", actions: false, documents: [{ trigger: "/x", sections: ["A"], actions: { heading: "Follow-ups" } }] });
  assert.deepEqual(odd.warnings, ["notes author ignored: not a blank name", "notes dateOrder ignored: must be dmy or mdy"]);
  assert.equal(odd.actions, null);
  assert.deepEqual(odd.documents[0].actions, { heading: "Follow-ups", patterns: ["TODO", "ACTION"], empty: "None" }, "a document can switch actions back on");
  assert.equal(notes.normalizeNotes({ author: "lead", dateOrder: "mdy" }).author, "lead");
});

test("findDocument fires only when the trigger ends at the caret after a boundary", () => {
  assert.deepEqual(notes.findDocument("Weekly sync /mins", config), { document: minutes, start: 12 });
  assert.equal(notes.findDocument("(/handover", config).document, handover);
  assert.equal(notes.findDocument("/mins2", config).document.id, "minutes-dup", "the longest trigger wins");
  assert.equal(notes.findDocument("x/mins", config), null, "a letter before the trigger is not a boundary");
  assert.equal(notes.findDocument("/mins ", config), null, "the trigger must end at the caret");
  assert.equal(notes.findDocument("", config), null);
  assert.equal(notes.findDocument("/mins", null), null);
});

test("render fills date, weekday, author and lists, repeats sections and appends the action block", () => {
  const out = notes.render(minutes, { author: "Dana Reyes", attendees: ["Ann", " ", "Bob"], topic: ["Budget", "Hiring"], meeting: "  " }, NOW);
  assert.equal(out.text, [
    "# Minutes – [[meeting]]", "",
    "## Details", "Wednesday 2026-10-21", "Minute taker: Dana Reyes", "",
    "## Attendees", "- Ann", "- Bob", "",
    "## Discussion", "", "",
    "## Item: Budget", "Notes:", "",
    "## Item: Hiring", "Notes:", "",
    "## Action items", "- None", "",
  ].join("\n"));
  assert.deepEqual(out.fields, ["meeting"], "a blank answered with whitespace is still missing");
  assert.equal(out.ready, false);
  assert.equal(out.caret, out.text.indexOf("## Discussion\n") + "## Discussion\n".length, "the caret goes to the first empty section");
});

test("render lists every missing blank once, joins arrays inline and puts the caret at {cursor} or the end of the sections", () => {
  const out = notes.render(minutes, { attendees: ["Ann", "Bob"] }, NOW);
  assert.deepEqual(out.fields, ["meeting", "author", "topic"]);
  assert.match(out.text, /^## Item: \[\[topic\]\]\nNotes:$/m, "a repeat section without values is written once");
  const titled = notes.render({ title: "With [[attendees]]", sections: [{ heading: "A", body: "x" }], actions: null }, { attendees: ["Ann", "Bob"] }, NOW);
  assert.equal(titled.text, "# With Ann, Bob\n\n## A\nx\n");
  assert.equal(titled.caret, titled.text.length - 1, "no empty section and no {cursor}: the end of the last section");
  assert.equal(titled.ready, true);
  const cursor = notes.render(handover, {}, NOW);
  assert.equal(cursor.text, "## Patients\n\n\n## Next shift\n\n");
  assert.equal(cursor.caret, cursor.text.indexOf("## Next shift\n") + "## Next shift\n".length, "{cursor} wins over an earlier empty section");
  const ownSection = notes.render({ sections: [{ heading: "Action items", body: "| Owner | Action | Due |" }], actions: notes.DEFAULT_ACTIONS }, {}, NOW);
  assert.equal(ownSection.text, "## Action items\n| Owner | Action | Due |\n", "no second block when a section already has the heading");
});

test("collectActions finds each owner form and ignores non-owners", () => {
  const text = [
    "## Discussion",
    "Sam will circulate the slides. Lee Chan to call the vendor.",
    "- [ ] @priya.k check the lease. Mail sam@example.com about it.",
    "Back to normal after the outage. We will meet again. The board will decide.",
    "TODO: Omar to book the room",
    "Nothing else to report.",
  ].join("\n");
  const { items } = notes.collectActions(text, config, NOW);
  assert.deepEqual(items.map((i) => [i.owner, i.text, i.line]), [
    ["Sam", "Sam will circulate the slides", 2],
    ["Lee Chan", "Lee Chan to call the vendor", 2],
    ["priya.k", "@priya.k check the lease", 3],
    ["Omar", "TODO: Omar to book the room", 5],
  ]);
  const custom = notes.collectActions("Board will decide.\nThe board will decide.", { actions: { heading: "Actions", patterns: ["decide"], empty: "-" } }, NOW);
  assert.deepEqual(custom.items.map((i) => [i.owner, i.text]), [["Board", "Board will decide"], ["", "The board will decide"]], "a policy pattern makes an owner-less sentence an action");
});

test("collectActions resolves due phrases to ISO dates when a weekday or date is given", () => {
  const due = (sentence, cfg) => {
    const [item] = notes.collectActions(sentence, cfg || config, NOW).items;
    return item ? [item.due, item.dueText] : null;
  };
  assert.deepEqual(due("Send the deck by Friday."), ["2026-10-23", "by Friday"]);
  assert.deepEqual(due("Send the deck by Wed"), ["2026-10-28", "by Wed"], "the same weekday means next week's");
  assert.deepEqual(due("Send it by next Friday"), ["2026-10-30", "by next Friday"]);
  assert.deepEqual(due("Review next Monday"), ["2026-10-26", "next Monday"]);
  assert.deepEqual(due("Send by Sunday"), ["2026-10-25", "by Sunday"]);
  assert.deepEqual(due("Send by 2026-10-30"), ["2026-10-30", "by 2026-10-30"]);
  assert.deepEqual(due("Send before 3 November 2026 please"), ["2026-11-03", "before 3 November 2026"]);
  assert.deepEqual(due("Send by 3/11/2026"), ["2026-11-03", "by 3/11/2026"]);
  assert.deepEqual(due("Send by 3/11/2026", notes.normalizeNotes({ dateOrder: "mdy" })), ["2026-03-11", "by 3/11/2026"]);
  assert.deepEqual(due("Send by 31.02.2026 or by Friday"), ["2026-10-23", "by Friday"], "an impossible date is not a due date");
  assert.deepEqual(due("Call them tomorrow"), ["2026-10-22", "tomorrow"]);
  assert.deepEqual(due("Finish by today"), ["2026-10-21", "by today"]);
  assert.deepEqual(due("Pay it next week"), ["next week", "next week"], "a vague phrase is kept as written");
  assert.deepEqual(due("Report due by end of the month"), ["end of the month", "by end of the month"]);
  assert.deepEqual(due("We met by the river on Friday. Today was fine."), null, "no due phrase, owner or pattern");
  assert.equal(due("Send the deck by Saturday", config)[0], "2026-10-24");
  assert.equal(notes.collectActions("Send by Friday", config, new Date(2026, 9, 23)).items[0].due, "2026-10-30", "on a Friday, by Friday is a week away");
});

test("collectActions builds the block and skips headings and the block itself", () => {
  const text = "## Sam will not count\nSam will draft the policy by Friday.\n\n## Action items\n- @omar to check by Monday\n";
  const out = notes.collectActions(text, minutes, NOW);
  assert.deepEqual(out.items.map((i) => i.line), [2]);
  assert.equal(out.block, "## Action items\n- Sam will draft the policy by Friday (due 2026-10-23)");
  assert.equal(notes.collectActions("Nothing here.", minutes, NOW).block, "## Action items\n- None");
  assert.equal(notes.collectActions("TODO: x", undefined, NOW).items.length, 1, "without a config the defaults apply");
  const named = notes.collectActions("Ask @kim to call. TODO: Omar to book", minutes, NOW).block;
  assert.equal(named, "## Action items\n- Ask @kim to call\n- TODO: Omar to book");
});

test("updateActionBlock appends, replaces, leaves the rest alone and is idempotent", () => {
  const body = "# Shift log\n\nSam will restock ward 3 by Friday.\nQuiet night otherwise.";
  const once = notes.updateActionBlock(body, minutes, NOW);
  assert.equal(once, body + "\n\n## Action items\n- Sam will restock ward 3 by Friday (due 2026-10-23)\n");
  assert.equal(notes.updateActionBlock(once, minutes, NOW), once, "running it twice changes nothing");
  assert.equal(notes.updateActionBlock("Quiet night.", minutes, NOW), "Quiet night.", "no items and no block: untouched");
  assert.equal(notes.updateActionBlock("Sam will go.\n", minutes, NOW), "Sam will go.\n\n## Action items\n- Sam will go\n");
  assert.equal(notes.updateActionBlock("Sam will go.", handover, NOW), "Sam will go.", "a document without actions is untouched");

  const rendered = notes.render(minutes, { author: "Dana", attendees: ["Ann"], topic: ["Budget"], meeting: "Ops" }, NOW).text;
  const typed = rendered.replace("## Discussion\n", "## Discussion\nLee will send the figures by 2026-10-30.\n");
  const updated = notes.updateActionBlock(typed, minutes, NOW);
  assert.equal(updated, typed.replace("## Action items\n- None\n", "## Action items\n- Lee will send the figures by 2026-10-30 (due 2026-10-30)\n"));
  assert.equal(notes.updateActionBlock(updated, minutes, NOW), updated);

  const middle = "Intro.\n### action items\n- None\n\n## Later\nKim to file it.\nEnd.";
  const replaced = notes.updateActionBlock(middle, minutes, NOW);
  assert.equal(replaced, "Intro.\n## Action items\n- Kim to file it\n\n## Later\nKim to file it.\nEnd.", "the block is replaced where it stands");
  assert.equal(notes.updateActionBlock(replaced, minutes, NOW), replaced);
  const gone = notes.updateActionBlock(replaced.replace("Kim to file it.\n", ""), minutes, NOW);
  assert.equal(gone, "Intro.\n## Action items\n- Kim to file it\n\n## Later\nEnd.", "a line the new block does not produce is kept, never dropped");
  assert.equal(notes.updateActionBlock(gone, minutes, NOW), gone);
});

test("updateActionBlock keeps lines typed into the block by hand", () => {
  const text = "Sam will call by Friday.\n\n## Action items\n- None\n- Ask facilities about the heating\n";
  const out = notes.updateActionBlock(text, minutes, NOW);
  assert.equal(out, "Sam will call by Friday.\n\n## Action items\n- Sam will call by Friday (due 2026-10-23)\n- Ask facilities about the heating\n");
  assert.equal(notes.updateActionBlock(out, minutes, NOW), out);
  const only = notes.updateActionBlock("Quiet.\n\n## Action items\n- None\n- Ask facilities\n", minutes, NOW);
  assert.equal(only, "Quiet.\n\n## Action items\n- Ask facilities\n", "kept lines replace the empty marker");
});

test("phrasings mines prose from earlier notes, not headings, template text or the action block", () => {
  const note = "## Handover notes for the night shift\nPatient settled overnight with no further concerns raised. Obs every four hours.\n\nMinute taker: [[author]] for the night shift team\n\n## Action items\n- Sam will check the drug chart before the round starts\n";
  const found = notes.phrasings([note, note, note, "unrelated"], { documents: [{ sections: [{ body: "Minute taker: [[author]] for the night shift team" }] }], actions: notes.DEFAULT_ACTIONS });
  assert.deepEqual(found.map((p) => p.text), ["Patient settled overnight with no further concerns raised. Obs every four hours."]);
  const withBlock = notes.phrasings([note, note, note], { documents: [], actions: null });
  assert.ok(withBlock.some((p) => p.text.includes("drug chart")), "without an action block setting, its lines are prose");
  assert.equal(found[0].sessions, 3);
  assert.deepEqual(notes.phrasings(undefined, undefined), []);
});

test("blanks lists a document's blanks once, in order, and marks list lines and repeat-only blanks as lists", () => {
  assert.deepEqual(notes.blanks(minutes), [{ name: "meeting", list: false }, { name: "author", list: false }, { name: "attendees", list: true }, { name: "topic", list: true }]);
  assert.deepEqual(notes.blanks(handover), []);
  const mixed = notes.normalizeNotes({ documents: [{ trigger: "/x", title: "[[author]]", sections: [
    { heading: "Item: [[topic]]", body: "Owner: [[author]]", repeat: true },
    { heading: "Risks", body: "Risks: [[risks]]\n  *   [[ risks ]]  \n- [[topic]] and more" },
  ] }] }).documents[0];
  assert.deepEqual(notes.blanks(mixed), [{ name: "author", list: false }, { name: "topic", list: false }, { name: "risks", list: true }],
    "a blank also used in a plain section (even on a list line with more text) stays a scalar; a list line of its own makes a list");
  assert.deepEqual(notes.blanks({ sections: [] }), []);
  assert.deepEqual(notes.blanks(null), []);
});

test("render leaves a short list of a repeat section open in its later copies and says how many values it needs", () => {
  const doc = notes.normalizeNotes({ documents: [{ trigger: "/r", sections: [{ heading: "Item: [[topic]]", body: "Owner: [[owner]]", repeat: true }, { heading: "All", body: "- [[topic]]" }] }] }).documents[0];
  assert.deepEqual(notes.blanks(doc), [{ name: "topic", list: true }, { name: "owner", list: true }]);
  const out = notes.render(doc, { topic: ["A", "B", "C"], owner: ["Ann", "Bob"] }, NOW);
  assert.deepEqual(out.fields, ["owner"], "the blank is open, not misreported as unanswered elsewhere");
  assert.deepEqual(out.short, { owner: { given: 2, needed: 3 } });
  assert.equal(out.ready, false);
  assert.match(out.text, /## Item: B\nOwner: Bob\n\n## Item: C\nOwner: \[\[owner\]\]/, "the copies with a value are filled; the last one stays open");
  const full = notes.render(doc, { topic: ["A", "B"], owner: ["Ann", "Bob"] }, NOW);
  assert.deepEqual([full.fields, full.short, full.ready], [[], {}, true]);
  const scalar = notes.render(doc, { topic: ["A", "B"], owner: "Ann" }, NOW);
  assert.equal(scalar.ready, true, "one plain value is written into every copy");
  assert.match(scalar.text, /## Item: A\nOwner: Ann\n\n## Item: B\nOwner: Ann/);
  const none = notes.render(doc, { topic: ["A", "B"] }, NOW);
  assert.deepEqual([none.fields, none.short], [["owner"], {}], "a list with no values at all is missing, not short");
  assert.deepEqual(notes.render(minutes, { attendees: ["Ann"] }, NOW).short, {}, "a plain section never reports a short list");
});

test("organizationItems names every document under kind notes for usage reports", () => {
  assert.deepEqual(notes.organizationItems(config), [{ trigger: "minutes", kind: "notes" }, { trigger: "handover", kind: "notes" }, { trigger: "minutes-dup", kind: "notes" }]);
  assert.deepEqual(notes.organizationItems(null), []);
  assert.deepEqual(notes.organizationItems({ documents: [{ id: "" }, "junk", { id: "ok" }] }), [{ trigger: "ok", kind: "notes" }]);
});
