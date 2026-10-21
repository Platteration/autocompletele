// The suite's app registry: engine hooks (trigger sources and word-end checks),
// loading and validation, and how the assistant routes channels, palette
// items and lifecycle hooks to apps. A broken app never stops the assistant.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createEngine } = require("../core/engine.js");
const orgPolicy = require("../core/org-policy.js");
const { loadApps, validate, APP_IDS } = require("../desktop/apps/index.js");
const { createAssistant } = require("../desktop/assistant.js");

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-apps-"));
}

function typeAll(engine, text) {
  let actions = [];
  for (const ch of text) actions = actions.concat(engine.keyTyped({ text: ch }));
  return actions;
}

test("an app trigger fires after the library and document shortcuts, with backspaces and the engine's field text updated", () => {
  const engine = createEngine({
    library: [{ trigger: "/mins", expansion: "A SHORTCUT WINS" }],
    policy: orgPolicy.parse({ documents: { shortcuts: [{ trigger: "/sld", documents: [{ path: "x" }] }] } }),
  });
  const seen = [];
  engine.setExtensions([{
    id: "notes",
    trigger: (text) => {
      seen.push(text);
      return text.endsWith("/handover") ? { trigger: "/handover", action: { popover: "render", documentId: "handover" } } : null;
    },
  }]);
  engine.focusChanged({ process: "notepad" });
  assert.equal(typeAll(engine, "see /mins")[0].type, "expand", "the library shortcut wins over the app trigger");
  engine.focusChanged({ process: "notepad" });
  assert.equal(typeAll(engine, "see /sld")[0].type, "documents");
  engine.focusChanged({ process: "notepad" });
  const actions = typeAll(engine, "note /handover");
  assert.deepEqual(actions, [{ type: "app", app: "notes", trigger: "/handover", backspaces: 9, popover: "render", documentId: "handover" }]);
  assert.ok(seen.length > 0, "the trigger source saw the buffer");
  assert.equal(engine.buffer, "", "the buffer is cleared after an app trigger");
  const swallowing = createEngine({ library: [], policy: orgPolicy.parse({}), swallowsTriggerKey: true });
  swallowing.setExtensions([{ id: "notes", trigger: (text) => (text.endsWith("/h") ? { trigger: "/h", action: {} } : null) }]);
  swallowing.focusChanged({ process: "notepad" });
  assert.equal(typeAll(swallowing, "/h")[0].backspaces, 1, "a swallowed trigger key is not deleted");
});

test("an app trigger is taken out of the learning session once; the app then counts it as spent, not as typed", () => {
  const engine = createEngine({ library: [], policy: orgPolicy.parse({ capture: { defaultMode: "learn" } }), minSessionLength: 1 });
  engine.setExtensions([{ id: "forms", trigger: (text) => (text.endsWith("refund/") ? { trigger: "refund/", action: { popover: "plan" } } : null) }]);
  engine.focusChanged({ process: "portal" });
  const actions = typeAll(engine, "hello there refund/");
  assert.equal(actions[0].type, "app");
  // The convention every app follows (desktop/apps/index.js): typed "" and the trigger as spent keystrokes.
  const entry = engine.recordInsert({ kind: "form", trigger: "refund", inserted: "Refund\nP2", typed: "", spentKeystrokes: "refund/".length });
  assert.equal(entry.keystrokesSaved, "Refund\nP2".length - "refund/".length);
  const ended = engine.endSession();
  assert.equal(ended.text, "hello there \n\n", "the text typed before the trigger survives; the insert leaves a paragraph break");
});

test("an app check runs when a word ends, sees the field text, and is reset when the focus moves", () => {
  const engine = createEngine({ library: [], policy: orgPolicy.parse({}) });
  const calls = [];
  let fired = false;
  engine.setExtensions([{
    id: "guard",
    check: (fieldText, context) => {
      calls.push([fieldText, context.process]);
      if (fired || !/card/.test(fieldText)) return null;
      fired = true;
      return { popover: "warning", message: "No cards." };
    },
    reset: () => { fired = false; },
  }]);
  assert.equal(engine.fieldText, "", "field text is only kept while something needs it");
  engine.focusChanged({ process: "outlook" });
  let actions = typeAll(engine, "the card ");
  assert.deepEqual(actions, [{ type: "app", app: "guard", popover: "warning", message: "No cards." }]);
  assert.equal(engine.fieldText, "the card ");
  assert.deepEqual(calls.map((c) => c[1]), ["outlook", "outlook"], "checked at each word end, not on every key");
  actions = typeAll(engine, "again ");
  assert.deepEqual(actions, [], "once per field until reset");
  engine.focusChanged({ process: "teams" });
  actions = typeAll(engine, "card ");
  assert.equal(actions.length, 1, "a new field fires again");
  engine.setExtensions([]);
  assert.equal(engine.fieldText, "", "without checks or keyword rules the field text is dropped");
  engine.setExtensions([{ id: "x", check: () => "not an object" }]);
  engine.focusChanged({ process: "teams" });
  assert.deepEqual(typeAll(engine, "word "), [], "a non-object result is ignored");
});

test("keyword offers and app checks on the same word both reach the shell, the app's last", () => {
  const engine = createEngine({ library: [], policy: orgPolicy.parse({ keywordRules: [{ id: "k", keywords: ["refund"], insert: "Returns text" }] }) });
  engine.setExtensions([{ id: "guard", check: (text) => (/refund/.test(text) ? { popover: "warning" } : null) }]);
  engine.focusChanged({ process: "outlook" });
  const actions = typeAll(engine, "refund ");
  assert.deepEqual(actions.map((a) => a.type), ["keyword", "app"]);
});

test("loadApps validates the shape and skips what it cannot load", () => {
  const log = [];
  const host = { policy: () => ({}) };
  const apps = loadApps(host, {
    ids: ["one", "two", "three", "four", "five"],
    log: (line) => log.push(line),
    factories: {
      one: () => ({ id: "one", title: "One", ipc: { "one:ping": () => "pong" }, extension: { id: "wrong", check: () => null } }),
      two: () => ({ id: "not-two" }),
      three: () => { throw new Error("boom"); },
      four: () => ({ id: "four", ipc: { "elsewhere:x": () => 1 } }),
    },
  });
  assert.deepEqual(apps.map((a) => a.id), ["one"]);
  assert.equal(apps[0].extension.id, "one", "the extension id follows the app id");
  assert.equal(apps[0].tab, true);
  assert.equal(log.length, 4);
  assert.match(log[0], /app two not loaded: app two reports id "not-two"/);
  assert.match(log[1], /app three not loaded: boom/);
  assert.match(log[2], /app four not loaded: .*must start with four:/);
  assert.match(log[3], /app five not loaded: Cannot find module/);
  assert.throws(() => validate({ id: "a", ipc: { "a:x": 1 } }, "a"), /not a function/);
  assert.deepEqual(APP_IDS, ["reply", "sheets", "forms", "guard", "notes"]);
  const real = loadApps({ policy: () => orgPolicy.parse({}) });
  assert.deepEqual(real.map((a) => a.id), ["reply", "sheets", "forms", "guard", "notes"], "every app of the suite has a module");
});

test("the assistant routes channels, palette items, lifecycle hooks and engine hooks to its apps", () => {
  const dataDir = temp();
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ organization: "Org", library: [{ trigger: "sig/", expansion: "Sig" }] }));
  const events = [];
  const assistant = createAssistant({
    dataDir,
    now: () => new Date(2026, 9, 21, 12).getTime(),
    appIds: ["guard", "broken"],
    apps: {
      guard: (host) => ({
        id: "guard",
        title: "Guard",
        ipc: {
          "guard:summary": (payload) => ({ ok: true, org: host.policy().organization, got: payload, settings: host.settings().enabled }),
          "guard:audit": () => { host.audit({ event: "guard-test" }); return { ok: true }; },
        },
        extension: { id: "guard", check: (text) => (/card/.test(text) ? { popover: "warning" } : null) },
        palette: {
          items: () => [{ trigger: "guard:pack", expansion: "PCI card rules", preview: "Card data" }],
          choose: (choice) => ({ type: "expand", text: "chosen " + choice.trigger, backspaces: 0, cursorOffset: 0, spentKeystrokes: choice.spentKeystrokes }),
        },
        onPolicy: (policy) => events.push("policy:" + policy.organization),
        onSettings: (settings) => events.push("settings:" + settings.enabled),
        onFocus: (context) => events.push("focus:" + context.process),
      }),
      broken: () => { throw new Error("no good"); },
    },
  });
  assert.deepEqual(assistant.appsInfo(), [{ id: "guard", title: "Guard", tab: true }]);
  assert.ok(assistant.warnings().some((w) => /app broken not loaded: no good/.test(w)));
  assert.deepEqual(assistant.invoke("guard:summary", { a: 1 }), { ok: true, org: "Org", got: { a: 1 }, settings: true });
  assert.deepEqual(assistant.invoke("guard:nope"), { ok: false, error: "unknown channel guard:nope" });
  assert.deepEqual(assistant.invoke("other:x"), { ok: false, error: "unknown channel other:x" });
  assistant.invoke("guard:audit");
  assert.equal(assistant.audit().pop().event, "guard-test");
  assert.equal(assistant.app("guard").title, "Guard");
  assert.equal(assistant.app("nope"), null);

  assistant.focusChanged({ process: "outlook" });
  let actions = [];
  for (const ch of "card ") actions = actions.concat(assistant.keyTyped({ text: ch }));
  assert.deepEqual(actions, [{ type: "app", app: "guard", popover: "warning" }]);

  const found = assistant.paletteSearch("card");
  assert.deepEqual(found.map((i) => [i.kind, i.trigger]), [["app:guard", "guard:pack"]]);
  const chosen = assistant.paletteChoose({ kind: "app:guard", trigger: "guard:pack", query: "card" });
  assert.equal(chosen.text, "chosen guard:pack");
  assert.equal(chosen.spentKeystrokes, 5);
  assert.equal(assistant.paletteChoose({ kind: "app:nope", trigger: "x", query: "" }), null);

  assistant.saveSettings({ enabled: false });
  assert.ok(events.includes("focus:outlook"));
  assert.ok(events.includes("settings:false"));
  assert.ok(events.includes("policy:Org"));
});
