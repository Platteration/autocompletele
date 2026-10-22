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
  // "Kind regards,\n" is 14 characters before the caret; the person's own
  // Backspace (not swallowed by default, as on the uiohook desk) already
  // removed the last of them, so 13 more are deleted, not 14.
  assert.deepEqual(undo, { type: "undo", trigger: "sig/", charsBeforeCaret: 13, charsAfterCaret: 8 });
  assert.equal(engine.ledger.size(), 0);
  assert.equal(engine.buffer, "sig/");
  // A second Backspace is an ordinary deletion.
  assert.deepEqual(engine.keyTyped({ isBackspace: true }), []);
  assert.equal(engine.buffer, "sig");
  // An adapter that swallows the Backspace leaves all 14 to delete.
  const swallowing = make({ swallowsTriggerKey: true });
  swallowing.focusChanged({ process: "notepad" });
  swallowing.type("sig/");
  assert.deepEqual(swallowing.keyTyped({ isBackspace: true }), [{ type: "undo", trigger: "sig/", charsBeforeCaret: 14, charsAfterCaret: 8 }]);
});

test("undo and trigger deletion count characters, never UTF-16 units", () => {
  // Each emoji here is one code point (two UTF-16 units) and one character on screen.
  const emoji = orgPolicy.parse({
    library: [
      { trigger: "ok/", expansion: "👍 Agreed 🙂" },
      { trigger: "mid/", expansion: "🙂🙂{cursor} end 🎉" },
      { trigger: "🙂/", expansion: "smile" },
      { trigger: "top/", expansion: "{cursor}after" },
    ],
    documents: { shortcuts: [{ trigger: "🗂/", label: "Files", documents: [{ title: "List", path: "S:/list.pdf" }] }] },
  });
  const engine = make({ policy: emoji, library: [] });
  engine.focusChanged({ process: "notepad" });
  // 12 UTF-16 units, 10 characters; the person's Backspace took the last one.
  assert.equal(engine.type("ok/")[0].cursorOffset, 12, "the caret offset stays a string index for the sender");
  assert.deepEqual(engine.keyTyped({ isBackspace: true }), [{ type: "undo", trigger: "ok/", charsBeforeCaret: 9, charsAfterCaret: 0 }]);
  engine.focusChanged({ process: "notepad" });
  engine.type("mid/");
  assert.deepEqual(engine.keyTyped({ isBackspace: true }), [{ type: "undo", trigger: "mid/", charsBeforeCaret: 1, charsAfterCaret: 6 }]);
  engine.focusChanged({ process: "notepad" });
  engine.focusChanged({ process: "notepad" });
  engine.type("top/");
  // The caret was at the start: the person's Backspace hit the text before it, nothing of the expansion.
  assert.deepEqual(engine.keyTyped({ isBackspace: true }), [{ type: "undo", trigger: "top/", charsBeforeCaret: 0, charsAfterCaret: 5 }]);
  engine.focusChanged({ process: "notepad" });
  assert.equal(engine.type("say 🙂/")[0].backspaces, 2, "a two-character trigger costs two Backspaces");
  // Document shortcuts and app triggers count the same way (hygiene: the desk's adapter types ASCII only).
  engine.setExtensions([{ id: "notes", trigger: (text) => (text.endsWith("📝n/") ? { trigger: "📝n/", action: { popover: "notes" } } : null) }]);
  assert.deepEqual(engine.type(" 🗂/").map((a) => [a.type, a.backspaces]), [["documents", 2]]);
  assert.deepEqual(engine.type(" 📝n/").map((a) => [a.type, a.backspaces]), [["app", 3]]);
  const swallowing = make({ policy: emoji, library: [], swallowsTriggerKey: true });
  swallowing.focusChanged({ process: "notepad" });
  assert.equal(swallowing.type("🙂/")[0].backspaces, 1);
  swallowing.setExtensions(engine.extensions);
  assert.equal(swallowing.type(" 🗂/")[0].backspaces, 1);
  assert.equal(swallowing.type(" 📝n/")[0].backspaces, 2);
  swallowing.focusChanged({ process: "notepad" });
  swallowing.type("ok/");
  assert.equal(swallowing.keyTyped({ isBackspace: true })[0].charsBeforeCaret, 10);
});

test("an expansion with a character made of several code points is never undone by count; the Backspace stays a deletion", () => {
  // Chromium and macOS remove 👍🏽 with one Backspace, other editors one code
  // point at a time: any count would delete the person's own text in one of them.
  const expansions = ["👍🏽 Agreed 🙂", "Thank you 🙏🏽", "Greetings from Berlin 🇩🇪", "Step 1️⃣ done", "Café au lait",
    "👨‍👩‍👧‍👦".repeat(20), "🇩🇪{cursor} after", "before {cursor}🙏🏽"];
  for (const expansion of expansions) {
    const engine = make({ policy: orgPolicy.parse({ library: [{ trigger: "x/", expansion }] }), library: [] });
    engine.focusChanged({ process: "chrome.exe", title: "Mail - Google Chrome" });
    assert.equal(engine.type("Dear Anna, x/")[0].type, "expand", expansion);
    assert.equal(engine.ledger.size(), 0, "still undoable until the next key");
    assert.deepEqual(engine.keyTyped({ isBackspace: true }), [], JSON.stringify(expansion) + ": no undo is sent");
    assert.equal(engine.ledger.size(), 1, "the expansion stays, and is counted");
    assert.equal(engine.buffer, "", "the trigger is not typed back");
    assert.deepEqual(engine.keyTyped({ isBackspace: true }), [], "a second Backspace is an ordinary one too");
  }
  // One code point per character, emoji included: undone as before.
  const plain = make({ policy: orgPolicy.parse({ library: [{ trigger: "x/", expansion: "Thanks 🙏 and 🎉" }] }), library: [] });
  plain.focusChanged({ process: "chrome.exe" });
  plain.type("x/");
  assert.deepEqual(plain.keyTyped({ isBackspace: true }), [{ type: "undo", trigger: "x/", charsBeforeCaret: 13, charsAfterCaret: 0 }]);
});

test("Enter, Ctrl+Enter, Tab and a shortcut chord end the word: the value typed last is checked", () => {
  // Keys as the desk's input adapter produces them (desktop/adapters/input.js).
  const { buildTable, translate } = require("../desktop/adapters/input.js");
  const { containsCardNumber } = require("../core/capture-policy.js");
  const table = buildTable({ Enter: 28, Tab: 15, S: 31, Space: 57, Ctrl: 29, Alt: 56 });
  const send = {
    "Enter": translate({ keycode: 28 }, table),
    "Ctrl+Enter": translate({ keycode: 28, ctrlKey: true }, table),
    "Tab": translate({ keycode: 15 }, table),
    "Alt+S": translate({ keycode: 31, altKey: true }, table),
  };
  assert.deepEqual(send["Alt+S"], { text: "", isBackspace: false, resetsBuffer: true });
  const rules = orgPolicy.parse({ keywordRules: [
    { id: "card", action: "warn", detect: ["card-number"], message: "No card numbers." },
    { id: "secret", action: "warn", keywords: ["hunter2"], message: "No passwords." },
  ] });
  for (const [name, key] of Object.entries(send)) {
    const engine = make({ policy: rules, library: [] });
    const checked = [];
    engine.setExtensions([{ id: "guard", check: (text) => { checked.push(text); return containsCardNumber(text) ? { popover: "warning" } : null; } }]);
    engine.focusChanged({ process: "slack" });
    assert.deepEqual(engine.type("my card is 4111 1111 1111 1111"), [], name + ": nothing while the number is typed");
    const actions = engine.keyTyped(key);
    assert.deepEqual(actions.map((a) => a.type), ["warning", "app"], name + ": the keyword rule and the app check run");
    assert.equal(actions[0].hits[0].rule.id, "card");
    assert.deepEqual(actions.map((a) => a.leftField), [true, true], name + ": marked as raised by a key that may have left the field");
    assert.equal(checked.at(-1), engine.fieldText, name + ": the app saw the whole field");
    assert.deepEqual(engine.keyTyped(key), [], name + ": a second key after no word checks nothing");
  }
  // A word already ended by a space is not checked again by Enter, and each rule still fires once per field.
  const engine = make({ policy: rules, library: [] });
  engine.focusChanged({ process: "slack" });
  const spaced = engine.type("pw hunter2 ");
  assert.deepEqual(spaced.map((a) => a.type), ["warning"]);
  assert.equal(spaced[0].leftField, undefined, "a word ended by a space is not marked");
  assert.deepEqual(engine.keyTyped(send.Enter), []);
  engine.type("hunter2");
  assert.deepEqual(engine.keyTyped(send["Ctrl+Enter"]), [], "once per field");
});

test("a key that may leave the field (Ctrl+Enter, Alt+Tab, Ctrl+W) raises warnings only, with nothing to insert", () => {
  // Keys as the desk's input adapter produces them; the example policy's rules.
  const { buildTable, translate } = require("../desktop/adapters/input.js");
  const table = buildTable({ Enter: 28, Tab: 15, W: 17, F4: 62, ArrowLeft: 105 });
  const keys = {
    "Ctrl+Enter": translate({ keycode: 28, ctrlKey: true }, table),
    "Alt+Tab": translate({ keycode: 15, altKey: true }, table),
    "Ctrl+W": translate({ keycode: 17, ctrlKey: true }, table),
    "Alt+F4": translate({ keycode: 62, altKey: true }, table),
    "ArrowLeft": translate({ keycode: 105 }, table),
  };
  const example = orgPolicy.parse(JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "shared", "org-policy.example.json"), "utf8")));
  for (const [name, key] of Object.entries(keys)) {
    const engine = make({ policy: example, library: [] });
    engine.focusChanged({ process: "outlook.exe" });
    assert.deepEqual(engine.type("please sign the contract"), []);
    const [warning, ...rest] = engine.keyTyped(key);
    assert.deepEqual(rest, []);
    assert.equal(warning.type, "warning", name);
    assert.equal(warning.leftField, true, name);
    assert.deepEqual(warning.hits.map((hit) => hit.rule.id), ["contract-disclaimer"], name);
    assert.equal(warning.hits[0].rule.insert, undefined, name + ": the disclaimer is not offered for insertion into whatever has the focus now");
    assert.equal(warning.hits[0].rule.message, "Messages about contracts need the legal disclaimer.");
    assert.ok(example.keywordRules.find((rule) => rule.id === "contract-disclaimer").insert, "the policy's rule keeps its insert");

    const offers = make({ policy: example, library: [] });
    offers.focusChanged({ process: "teams" });
    assert.deepEqual(offers.type("about the refund"), []);
    assert.deepEqual(offers.keyTyped(key), [], name + ": no offer at a key that may leave the field");
    // Still in the same field, the offer comes at the next word typed there, with its insert.
    const [offer] = offers.type(" today ");
    assert.deepEqual([offer.type, offer.hits[0].rule.id, offer.leftField], ["keyword", "returns", undefined], name);
    assert.ok(offer.hits[0].rule.insert);
  }
  // A word ended by a space is warned about and offered with the inserts, as before.
  const engine = make({ policy: example, library: [] });
  engine.focusChanged({ process: "outlook.exe" });
  assert.deepEqual(engine.type("the contract and the refund ").map((a) => [a.type, a.hits[0].rule.id, !!a.hits[0].rule.insert, a.leftField]),
    [["warning", "contract-disclaimer", true, undefined], ["keyword", "returns", true, undefined]]);
});

test("nothing is held or checked in a terminal, a password manager or a credential prompt; shortcuts still expand", () => {
  const rules = orgPolicy.parse({
    library: [{ trigger: "sig/", expansion: "Kind regards" }],
    keywordRules: [{ id: "contract", action: "warn", keywords: ["contract"], message: "x" }, { id: "card", action: "warn", detect: ["card-number"], message: "y" }],
  });
  const contexts = [
    { process: "/usr/bin/gnome-terminal" },
    { process: "gnome-terminal-" }, // Linux /proc/<pid>/comm cuts gnome-terminal-server to 15 characters
    { process: "C:\\Program Files\\1Password\\1Password.exe", title: "1Password" },
    { process: "chrome.exe", title: "Sign in - Bank - Google Chrome" },
    { process: "C:\\Program Files\\PuTTY\\putty.exe", title: "build01.corp - PuTTY" },
    { process: "C:\\Program Files\\Git\\usr\\bin\\mintty.exe", title: "MINGW64:/c/Users/jane" },
    { process: "C:\\Program Files (x86)\\Mobatek\\MobaXterm\\MobaXterm.exe", title: "build01.corp" },
    { process: "urxvt", title: "jane@ws: ~" },
    { process: "polkit-gnome-au", title: "Authenticate" }, // polkit-gnome-authentication-agent-1, cut to 15
    { process: "pinentry-gnome3", title: "pinentry" },
    { process: "msedge.exe", title: "Anmelden - Microsoft-Konto - Microsoft Edge" },
  ];
  for (const context of contexts) {
    const engine = make({ policy: rules, library: [] });
    let checks = 0;
    engine.setExtensions([{ id: "guard", check: (text) => { checks++; return /contract/.test(text) ? { popover: "warning" } : null; } }]);
    assert.equal(engine.focusChanged(context).mode, "triggers");
    const actions = engine.type("sudo -v\nhunter2\nthe contract 4111 1111 1111 1111 ").concat(engine.keyTyped({ text: "\n", resetsBuffer: true }));
    assert.deepEqual(actions, [], JSON.stringify(context) + ": no keyword or app action");
    assert.equal(engine.fieldText, "", JSON.stringify(context) + ": no field text is held");
    assert.equal(checks, 0, JSON.stringify(context) + ": the app check never ran");
    assert.equal(engine.type("sig/")[0].type, "expand", "shortcuts still work there");
    engine.focusChanged({ process: "notepad" });
    assert.deepEqual(engine.type("the contract ").map((a) => a.type), ["warning", "app"], "an ordinary window is checked again");
  }
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
