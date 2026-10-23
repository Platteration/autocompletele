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
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { loadApps, validate, APP_IDS, NAMES } = require("../desktop/apps/index.js");
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

test("the Guard app sees the word a send key ends, and nothing typed in a terminal or a password manager", () => {
  const dataDir = temp();
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "desktop", "apps", "guard", "sample-policy.json"), "utf8"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ organization: "Org", guard: Object.assign({}, sample, { assumeExternal: true }) }));
  const assistant = createAssistant({ dataDir, now: () => new Date(2026, 9, 21, 12).getTime(), appIds: ["guard"] });
  const guard = (actions) => actions.filter((a) => a.type === "app" && a.app === "guard").map((a) => a.rule || (a.rules && a.rules[0]) || a.popover);
  const send = { enter: { text: "\n", resetsBuffer: true }, tab: { text: "\t", resetsBuffer: true }, chord: { text: "", resetsBuffer: true } };
  for (const [name, key] of Object.entries(send)) {
    assistant.focusChanged({ process: "slack", title: "general - Slack" });
    assert.deepEqual(guard(typeAll(assistant, "my card is 4111 1111 1111 1111")), [], name + ": nothing while typing");
    const raised = assistant.keyTyped(key).filter((a) => a.type === "app" && a.app === "guard");
    assert.equal(guard(raised).length, 1, name + ": the card typed last is warned about");
    assert.equal(raised[0].leftField, true, name + ": marked as raised by a key that may have left the field");
  }
  for (const context of [{ process: "/usr/bin/gnome-terminal" }, { process: "C:\\Program Files\\1Password\\1Password.exe" },
    { process: "C:\\Program Files\\PuTTY\\putty.exe" }, { process: "pinentry-gnome3" }, { process: "msedge.exe", title: "Anmelden - Microsoft-Konto" }]) {
    assistant.focusChanged(context);
    const actions = typeAll(assistant, "sudo -v hunter2 4111 1111 1111 1111 ").concat(assistant.keyTyped(send.enter));
    assert.deepEqual(guard(actions), [], JSON.stringify(context));
    assert.equal(assistant.engine.fieldText, "", JSON.stringify(context) + ": no field text held");
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
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

test("the names people see come from one table: the tabs, their first lines, the tray and palette entries, the built-in factle tab and the Delete learned text question", async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(NAMES)), {
    reply: { name: "mactle", covers: "replies to mail" },
    sheets: { name: "extle", covers: "Excel and Google Sheets" },
    forms: { name: "cactle", covers: "CRM and ticket forms" },
    guard: { name: "gactle", covers: "compliance warnings" },
    notes: { name: "dactle", covers: "minutes, handovers and logs in Word, Docs or any editor" },
    filing: { name: "factle", covers: "document filing" },
  });
  assert.deepEqual(Object.keys(NAMES), APP_IDS.concat("filing"), "every app of the registry has a name, and filing");

  const dataDir = temp();
  fs.copyFileSync(path.join(__dirname, "..", "shared", "org-policy.example.json"), path.join(dataDir, "policy.json"));
  const assistant = createAssistant({ dataDir, now: () => new Date(2026, 9, 21, 12).getTime() });
  assert.deepEqual(assistant.appsInfo().map((app) => [app.id, app.title]), APP_IDS.map((id) => [id, NAMES[id].name]), "the tab labels");
  const tray = assistant.apps.filter((app) => typeof app.trayItems === "function").flatMap((app) => app.trayItems().map((item) => item.label));
  assert.deepEqual(tray, ["mactle: Reply to the copied message…", "dactle: Update action items in the copied note"]);
  assert.deepEqual(assistant.paletteSearch("mactle").map((item) => [item.kind, item.trigger])[0], ["app:reply", "mactle: Reply to copied message"]);
  assert.deepEqual(assistant.paletteSearch("dactle").map((item) => [item.kind, item.trigger])[0], ["app:notes", "dactle: Update action items in copied note"]);

  // Each tab page opens with "<name>: <what it covers>". The pages cannot
  // load the table, so they are run under Node (a few lines of DOM) and held to it.
  class Node {
    constructor(tag) { Object.assign(this, { tagName: tag, children: [], attrs: {}, text: "", value: "", className: "" }); }
    get textContent() { return this.text + this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join(""); }
    set textContent(value) { this.text = String(value); this.children = []; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener() {}
    replaceWith() {}
  }
  const el = (tag, attrs, children) => {
    const node = new Node(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    node.append(...(children || []));
    return node;
  };
  const helpers = { api: { invoke: async (channel, payload) => assistant.invoke(channel, payload) }, el, text: (node, value) => { node.textContent = value; }, announce: () => {}, seconds: (n) => n + " s", preview: (value) => String(value || "").slice(0, 140) };
  for (const id of APP_IDS) {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "apps", id + ".js"), "utf8"), { window });
    const section = new Node("section");
    await window.actleApps[id].render(section, helpers, {});
    const first = section.children[0];
    assert.equal(first.tagName + " " + first.textContent, "h2 " + NAMES[id].name + ": " + NAMES[id].covers, id);
  }

  // Filing is built into the dashboard page itself.
  const page = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "index.html"), "utf8");
  assert.equal(page.match(/<button role="tab" data-tab="filing"[^>]*>([^<]*)<\/button>/)[1], NAMES.filing.name);
  assert.equal(page.match(/<section id="tab-filing"[^>]*>\s*<h2>([^<]*)<\/h2>/)[1], NAMES.filing.name + ": " + NAMES.filing.covers);

  // dashboard.js is not run by any test; its "Delete learned text" question names cactle's stored fills.
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "desktop", "renderer", "dashboard.js"), "utf8");
  const questions = [...dashboard.matchAll(/window\.confirm\("([^"]*)"\)/g)].map((m) => m[1]).filter((q) => q.startsWith("Delete all learned text"));
  assert.deepEqual(questions, ["Delete all learned text on this computer, including suggestions not yet exported and the fills " + NAMES.forms.name + " stored for learning? Proposals based on it disappear. Your shortcuts and statistics are not affected."]);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the simulator heads the filing walk-through and each app's with the name and what it covers", () => {
  const lines = execFileSync(process.execPath, [path.join(__dirname, "..", "desktop", "simulate.js")], { encoding: "utf8" }).split("\n");
  assert.ok(lines.includes(NAMES.filing.name + ": " + NAMES.filing.covers), "factle: document filing");
  assert.deepEqual(lines.filter((line) => line.endsWith(" (app)")), APP_IDS.map((id) => NAMES[id].name + ": " + NAMES[id].covers + " (app)"));
});
