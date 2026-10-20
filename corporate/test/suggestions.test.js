const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const suggestions = require("../core/suggestions.js");
const { createAssistant } = require("../desktop/assistant.js");
const { run } = require("../admin/actle-admin.js");

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-suggest-"));
}

test("the queue keeps one entry per text and drops unusable ones", () => {
  let queue = suggestions.enqueue([], { kind: "paragraph", text: "Thanks for reaching out.", trigger: "tfro/", sessions: 4 });
  queue = suggestions.enqueue(queue, { kind: "paragraph", text: "  Thanks for  reaching out. ", trigger: "thx/", sessions: 5 });
  queue = suggestions.enqueue(queue, { text: "" });
  queue = suggestions.enqueue(queue, null);
  assert.deepEqual(queue, [{ kind: "paragraph", text: "Thanks for  reaching out.", trigger: "thx/", sessions: 5 }], "spacing differences are the same text");
  assert.equal(suggestions.enqueue(queue, { text: "thanks for reaching out." }).length, 2, "case is significant: shortcuts are pasted verbatim");
  assert.equal(suggestions.enqueue(null, { text: "x", kind: "odd" })[0].kind, "phrase");
});

test("ranking counts each desk once, leaves out the library and prefers a free trigger", () => {
  const make = (id, team, at, items) => suggestions.buildExport(items, { installId: id, team, now: at });
  const files = [
    make("a", "Shipping", 1, [{ text: "Old text from desk a", trigger: "old/" }]),
    make("a", "Shipping", 2, [{ kind: "template", text: "Hi [[name]], your order ships today.", trigger: "ship/", sessions: 3 }, { text: "Our office hours are 9 to 5.", trigger: "hrs/" }]),
    make("b", "Sales", 1, [{ kind: "template", text: "Hi [[name]], your order ships today.", trigger: "ord/", sessions: 6 }]),
    make("c", "Sales", 1, [{ kind: "template", text: "Hi [[name]],  your order ships today.", trigger: "ship/", sessions: 2 }]),
    { not: "a file" },
  ];
  const ranked = suggestions.rank(files, { library: [{ trigger: "hrs/", expansion: "Our office hours are 9 to 5." }, { trigger: "ship/", expansion: "Something else" }] });
  assert.equal(ranked.desks, 3);
  assert.deepEqual(ranked.warnings, ["file 5 skipped: not an actle suggestions file"]);
  assert.equal(ranked.suggestions.length, 1, "the library text and desk a's older file are left out");
  const top = ranked.suggestions[0];
  assert.equal(top.desks, 3);
  assert.equal(top.sessions, 11);
  assert.deepEqual(top.teams.sort(), ["Sales", "Shipping"]);
  assert.equal(top.suggestedTrigger, "ord/", "ship/ is taken by the library, so the next trigger a desk chose is used");
  assert.deepEqual(suggestions.toLibrary(ranked.suggestions), { version: 1, shorthands: [{ trigger: "ord/", expansion: "Hi [[name]], your order ships today." }] });
  assert.equal(suggestions.rank(files, { minDesks: 4 }).suggestions.length, 0);
});

test("a desk suggests what the person picked; template values never leave", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ capture: { defaultMode: "learn" }, reporting: { team: "Shipping" } }));
  const keychain = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from("K" + t), decryptString: (b) => Buffer.from(b).toString().slice(1) };
  const assistant = createAssistant({ dataDir, keychain });
  for (const [name, ref] of [["Johnathan", "A-1001"], ["Marianne", "A-1002"], ["Priyanka", "A-1003"]]) {
    assistant.focusChanged({ process: "outlook" });
    for (const ch of `Dear ${name}, your order ${ref} has shipped today and will arrive soon.\n\nThanks for reaching out to our support team today.`) {
      assistant.keyTyped(ch === "\n" ? { text: "\n", resetsBuffer: true } : { text: ch });
    }
  }
  assistant.focusChanged({ process: "other" });
  const proposals = assistant.candidates();
  const template = proposals.find((c) => c.kind === "template");
  assert.ok(template, "template proposed");
  const added = assistant.suggest({ trigger: "shipped/", template: template.template, names: { name: "customer" } });
  assert.equal(added.ok, true);
  const phrase = proposals.find((c) => c.kind !== "template");
  assert.ok(phrase, "the repeated sentence is proposed too");
  assert.equal(assistant.suggest({ trigger: "tfro/", text: phrase.text }).ok, true);
  assert.match(assistant.suggest({ trigger: "x/", text: "never proposed" }).error, /has changed/);
  const exported = assistant.suggestionsExport();
  assert.equal(exported.format, "actle-phrase-suggestions");
  assert.equal(exported.team, "Shipping");
  assert.match(exported.installId, /^[0-9a-f-]{36}$/);
  assert.match(exported.suggestions[0].text, /^Dear \[\[customer\]\], your order \[\[reference\]\]/);
  const text = JSON.stringify(exported);
  for (const value of ["Johnathan", "Marianne", "Priyanka", "A-1001"]) assert.equal(text.includes(value), false, value + " must not leave the desk");
  assistant.unsuggest(exported.suggestions[0].text);
  assert.equal(assistant.suggestions().length, 1);
});

test("the admin tool ranks suggestion files and writes a library to review", () => {
  const dir = temp();
  const file = (name, id, items) => fs.writeFileSync(path.join(dir, name), JSON.stringify(suggestions.buildExport(items, { installId: id, team: "Ops", now: 5 })));
  file("a.json", "a", [{ kind: "paragraph", text: "We will get back to you within one business day.", trigger: "wgb/" }]);
  file("b.json", "b", [{ kind: "paragraph", text: "We will get back to you within one business day.", trigger: "wgb/" }]);
  fs.writeFileSync(path.join(dir, "bad.json"), "{");
  const out = [];
  const err = [];
  const target = path.join(dir, "library.json");
  const code = run(["suggestions", path.join(dir, "a.json"), path.join(dir, "b.json"), path.join(dir, "bad.json"), "--min-desks", "2", "--out", target], { stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  assert.equal(code, 0, err.join("\n"));
  assert.match(out.join("\n"), /desks: 2, suggestions: 1/);
  assert.match(out.join("\n"), /2 desk\(s\), 0 message\(s\), paragraph, Ops, trigger wgb\//);
  assert.match(err.join("\n"), /bad\.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")).shorthands, [{ trigger: "wgb/", expansion: "We will get back to you within one business day." }]);
  assert.equal(run(["suggestions", path.join(dir, "a.json"), "--min-desks", "0"], { stdout: () => {}, stderr: () => {} }), 1);
});

test("the suggested trigger is the one most desks chose", () => {
  const files = [["a", "ty/"], ["b", "ship/"], ["c", "ship/"]].map(([id, trigger]) =>
    suggestions.buildExport([{ text: "Your order ships today.", trigger }], { installId: id, now: 1 }));
  const ranked = suggestions.rank(files);
  assert.equal(ranked.suggestions[0].suggestedTrigger, "ship/");
  assert.deepEqual(ranked.suggestions[0].triggers, ["ship/", "ty/"]);
  assert.equal(suggestions.rank(files, { library: [{ trigger: "ship/", expansion: "x" }] }).suggestions[0].suggestedTrigger, "ty/");
});
