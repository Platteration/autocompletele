const test = require("node:test");
const assert = require("node:assert/strict");
const { createEngine, mergeLibraries } = require("../core/engine.js");
const orgPolicy = require("../core/org-policy.js");

const policy = orgPolicy.parse({
  capture: { apps: [{ id: "mail", match: { process: "outlook.exe" }, mode: "learn" }, { id: "bank", match: { title: "Banking" }, mode: "off" }] },
  library: [{ trigger: "sig/", expansion: "Kind regards,\n{cursor}\nExample" }, { trigger: "cool/", expansion: "ORG VERSION" },
    { trigger: "ack/", expansion: "Hi [[name]], thanks." }],
  keywordRules: [{ id: "refund", keywords: ["refund"], insert: { kind: "shorthand", trigger: "sig/" } }],
  documents: { shortcuts: [{ trigger: "/sld", label: "Shipping", documents: [{ title: "Packing list", path: "S:/packing.pdf" }] }] },
});

function make(options) {
  let clock = 1_000_000;
  const engine = createEngine(Object.assign({ policy, library: [{ trigger: "cool/", expansion: "That is really cool!" }], now: () => clock }, options));
  engine.tick = (ms) => { clock += ms; };
  engine.type = (text) => {
    let actions = [];
    for (const ch of Array.from(text)) {
      const key = ch === "\n" ? { text: "\n", resetsBuffer: true } : { text: ch };
      actions = actions.concat(engine.keyTyped(key));
    }
    return actions;
  };
  return engine;
}

test("personal shortcuts win over organisation ones with the same trigger", () => {
  const merged = mergeLibraries([{ trigger: "cool/", expansion: "mine" }], [{ trigger: "cool/", expansion: "org" }, { trigger: "sig/", expansion: "s" }]);
  assert.deepEqual(merged.map((sh) => [sh.trigger, sh.source]), [["cool/", "personal"], ["sig/", "organization"]]);
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  const [action] = engine.type("cool/");
  assert.equal(action.text, "That is really cool!");
  assert.equal(action.source, "personal");
  assert.equal(action.backspaces, 5);
  assert.equal(action.keystrokesSaved, 15);
});

test("the trigger key is not deleted twice when the adapter swallows it", () => {
  const engine = make({ swallowsTriggerKey: true });
  engine.focusChanged({ process: "notepad" });
  assert.equal(engine.type("cool/")[0].backspaces, 4);
});

test("undo returns the trigger and leaves no trace in the statistics", () => {
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  engine.type("sig/");
  const [undo] = engine.keyTyped({ isBackspace: true });
  assert.deepEqual(undo, { type: "undo", trigger: "sig/", charsBeforeCaret: 14, charsAfterCaret: 8 });
  assert.equal(engine.ledger.size(), 0);
  assert.equal(engine.buffer, "sig/");
  // A second Backspace is an ordinary deletion.
  assert.deepEqual(engine.keyTyped({ isBackspace: true }), []);
  assert.equal(engine.buffer, "sig");
});

test("an expansion is counted once the undo window closes", () => {
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  engine.type("cool/");
  assert.equal(engine.ledger.size(), 0, "still undoable");
  engine.keyTyped({ text: "" }); // a lone modifier keeps the window open
  assert.equal(engine.ledger.size(), 0);
  engine.type(" ");
  assert.equal(engine.ledger.size(), 1);
  assert.equal(engine.ledger.entries()[0].keystrokesSaved, 15);
  assert.equal(engine.ledger.entries()[0].app, "notepad");
  engine.type("cool/");
  engine.focusChanged({ process: "other" });
  assert.equal(engine.ledger.size(), 2, "a focus change also closes the window");
});

test("templates are handed to the shell instead of being typed", () => {
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  const [action] = engine.type("ack/");
  assert.equal(action.type, "template");
  assert.deepEqual(action.fields, [{ name: "name", label: "name" }]);
  assert.equal(action.backspaces, 4);
  const entry = engine.recordInsert({ kind: "template", trigger: "ack/", inserted: "Hi Sam, thanks.", typed: "ack/" });
  assert.equal(entry.keystrokesSaved, 11);
});

test("document shortcuts list the files and count attachment time when confirmed", () => {
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  const [action] = engine.type("see /sld");
  assert.equal(action.type, "documents");
  assert.equal(action.label, "Shipping");
  assert.equal(action.documents[0].title, "Packing list");
  assert.equal(action.backspaces, 4);
  assert.deepEqual(engine.type("x/sld"), [], "boundary rule applies");
  const entry = engine.recordInsert({ kind: "document", trigger: "/sld", count: 2 });
  assert.equal(entry.fixedSeconds, 40);
  assert.equal(engine.ledger.summary().secondsSaved, 40);
});

test("keyword offers fire when a word ends and once per field", () => {
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  assert.deepEqual(engine.type("about the refund"), []);
  const [offer] = engine.type(" ");
  assert.equal(offer.type, "keyword");
  assert.equal(offer.hits[0].rule.id, "refund");
  assert.deepEqual(engine.type("refund again "), []);
  engine.focusChanged({ process: "notepad" });
  assert.equal(engine.type("refund.").length, 1);
});

test("off mode ignores keys; disabling pauses everything", () => {
  const engine = make();
  assert.equal(engine.focusChanged({ process: "chrome", title: "Online Banking" }).mode, "off");
  assert.deepEqual(engine.type("cool/"), []);
  engine.focusChanged({ process: "notepad" });
  engine.setEnabled(false);
  assert.equal(engine.mode, "off");
  assert.deepEqual(engine.type("cool/"), []);
  engine.setEnabled(true);
  assert.equal(engine.mode, "triggers");
  assert.equal(engine.type("cool/").length, 1);
});

test("learn mode keeps a scrubbed session and flushes it on focus change", () => {
  const engine = make();
  assert.equal(engine.focusChanged({ process: "C:/Apps/OUTLOOK.EXE", title: "New message" }).mode, "learn");
  engine.type("Hello there, cool/ my card is 4111 1111 1111 1111.\nBye");
  engine.keyTyped({ isBackspace: true });
  engine.type("e!");
  engine.tick(5000);
  const { session } = engine.focusChanged({ process: "notepad" });
  assert.equal(session.app, "outlook");
  // Only typed text is learned: the expansion actle inserted becomes a paragraph break.
  assert.equal(session.text, "Hello there, \n\n my card is [card].\nBye!");
  assert.equal(session.text.includes("That is really cool"), false);
  assert.equal(session.redactions, 1);
  assert.equal(session.endedAt - session.startedAt, 5000);
  assert.equal(engine.session, null);
  // Short sessions are dropped; triggers-mode windows never create one.
  engine.focusChanged({ process: "outlook.exe" });
  engine.type("short");
  assert.equal(engine.focusChanged({ process: "notepad" }).session, null);
  engine.type("this is long enough to be a session but notepad is not learned");
  assert.equal(engine.endSession(), null);
});

test("learn mode is refused for credential prompts even when the rule asks for it", () => {
  const engine = make();
  const result = engine.focusChanged({ process: "outlook.exe", title: "Sign in to your account" });
  assert.equal(result.mode, "triggers");
  assert.match(result.reason, /never enabled/);
  assert.equal(engine.focusChanged({ process: "outlook.exe", secureInput: true }).mode, "off");
});

test("the engine's own window never expands or learns", () => {
  const engine = make();
  engine.focusChanged({ process: "outlook.exe", ownWindow: true });
  assert.deepEqual(engine.type("cool/"), []);
  assert.equal(engine.buffer, "");
});

test("setLibrary and setPolicy take effect immediately", () => {
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  engine.setLibrary([{ trigger: "new/", expansion: "fresh" }]);
  assert.equal(engine.type("new/")[0].text, "fresh");
  assert.equal(engine.type("cool/")[0].text, "ORG VERSION", "the personal override is gone");
  engine.setPolicy({ typing: { charsPerMinute: 100 }, capture: { defaultMode: "learn" } });
  assert.equal(engine.ledger.charsPerMinute, 100);
  assert.equal(engine.mode, "learn");
  assert.notEqual(engine.session, null);
  assert.deepEqual(engine.type("cool/"), [], "the organisation library is gone too");
});

test("an organisation pause turns everything off until the policy lifts it", () => {
  const engine = make();
  engine.focusChanged({ process: "outlook.exe" });
  assert.equal(engine.mode, "learn");
  engine.setPolicy(orgPolicy.parse({ paused: { message: "Paused by IT" }, capture: { defaultMode: "learn" }, library: [{ trigger: "x/", expansion: "X" }] }));
  assert.equal(engine.paused, true);
  assert.equal(engine.mode, "off");
  assert.equal(engine.session, null, "no learning while paused");
  assert.deepEqual(engine.type("cool/ x/ refund "), []);
  assert.equal(engine.focusChanged({ process: "notepad" }).reason, "paused by the organisation");
  engine.setEnabled(true);
  assert.equal(engine.mode, "off", "the person cannot override an organisation pause");
  engine.setPolicy(orgPolicy.parse({ library: [{ trigger: "x/", expansion: "X" }] }));
  assert.equal(engine.paused, false);
  assert.equal(engine.mode, "triggers");
  assert.equal(engine.type("x/")[0].text, "X");
});

test("statistics remember whether a shortcut came from the organisation or the person", () => {
  const engine = make();
  engine.focusChanged({ process: "notepad" });
  engine.type("cool/ sig/ ");
  engine.recordInsert({ kind: "document", trigger: "/sld", count: 1 });
  engine.recordInsert({ kind: "keyword", trigger: "refund", inserted: "x", source: "personal" });
  engine.recordInsert({ kind: "template", trigger: "ack/", inserted: "Hi Sam", typed: "ack/", source: "organization" });
  assert.deepEqual(engine.ledger.entries().map((e) => [e.trigger, e.source]), [
    ["cool/", "personal"], ["sig/", "organization"], ["/sld", "organization"], ["refund", "organization"], ["ack/", "organization"],
  ]);
});

test("compliance warnings see the whole field, across new lines, and fire once", () => {
  const engine = make({ policy: orgPolicy.parse({
    library: [{ trigger: "disc/", expansion: "This message is confidential." }],
    keywordRules: [
      { id: "disclaimer", action: "warn", keywords: ["contract"], unless: ["This message is confidential"], message: "Add the disclaimer.", insert: { kind: "shorthand", trigger: "disc/" } },
      { id: "card", action: "warn", detect: ["card-number"], message: "No card numbers." },
      { id: "hours", keywords: ["hours"], insert: "9 to 5" },
    ],
  }) });
  engine.focusChanged({ process: "notepad" });
  const first = engine.type("Hi,\nthe contract ");
  assert.deepEqual(first.map((a) => a.type), ["warning"]);
  assert.equal(first[0].hits[0].rule.message, "Add the disclaimer.");
  assert.deepEqual(engine.type("contract again "), [], "once per field");
  assert.deepEqual(engine.type("card 4111 1111 1111 1111 and office hours ").map((a) => a.type), ["warning", "keyword"], "different words, different actions");

  engine.focusChanged({ process: "notepad" });
  engine.type("disc/");
  assert.deepEqual(engine.type("\n\nAbout the contract "), [], "the disclaimer inserted above, before new lines, counts");
  assert.equal(engine.fieldText.endsWith("This message is confidential.\n\nAbout the contract "), true);
  engine.keyTyped({ isBackspace: true });
  assert.equal(engine.fieldText.endsWith("About the contract"), true, "Backspace removes from the field text too");
  engine.focusChanged({ process: "other" });
  assert.equal(engine.fieldText, "", "the field text is dropped when the focus moves");
});

test("without keyword rules the field text is not kept at all", () => {
  const engine = make({ policy: orgPolicy.parse({ library: [{ trigger: "a/", expansion: "A" }] }) });
  engine.focusChanged({ process: "notepad" });
  engine.type("some private words a/ ");
  assert.equal(engine.fieldText, "");
  const kept = make();
  kept.focusChanged({ process: "notepad" });
  kept.type("x".repeat(5000));
  assert.equal(kept.fieldText.length, 4000, "capped");
  kept.setPolicy(orgPolicy.parse({}));
  assert.equal(kept.fieldText, "", "dropped when the rules go away");
});

test("learning keeps what was typed, never what actle inserted, and undo restores the trigger", () => {
  const engine = make();
  engine.focusChanged({ process: "outlook.exe" });
  engine.type("Our signature: sig/");
  engine.keyTyped({ isBackspace: true });
  assert.equal(engine.session.text, "Our signature: sig/", "after undo the session holds exactly what was typed");
  engine.type(" then sig/ and ");
  engine.recordInsert({ kind: "keyword", trigger: "refund", inserted: "Inserted refund text", typed: "" });
  engine.type("the end of a long enough message");
  const { session } = engine.focusChanged({ process: "notepad" });
  assert.equal(session.text, "Our signature: sig/ then \n\n and \n\nthe end of a long enough message");
  assert.equal(/Kind regards|Inserted refund/.test(session.text), false);
});

test("a warning and an offer on the same word arrive together, warning first", () => {
  const engine = make({ policy: orgPolicy.parse({ keywordRules: [
    { id: "offer", keywords: ["contract"], insert: "Contract template text" },
    { id: "warn", action: "warn", keywords: ["contract"], message: "Add the disclaimer." },
  ] }) });
  engine.focusChanged({ process: "notepad" });
  const actions = engine.type("the contract ");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "warning");
  assert.deepEqual(actions[0].hits.map((h) => h.rule.id), ["warn", "offer"]);
});
