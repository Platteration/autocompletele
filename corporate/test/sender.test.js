// The sender (desktop/adapters/sender.js) with a fake platform tool and a fake
// clipboard: the text to paste is on the clipboard when the paste key goes
// out, the person's previous clipboard comes back only after the keys were
// sent, once for a run of queued jobs, and undo sends one key per character.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSender } = require("../desktop/adapters/sender.js");
const { createEngine } = require("../core/engine.js");
const orgPolicy = require("../core/org-policy.js");

const GRACE = 20;

/** A clipboard that answers with promises, as Electron's does in the pinned version (or synchronously). */
function fakeClipboard(initial, sync) {
  const clip = { value: initial, log: [] };
  const answer = (value) => (sync ? value : Promise.resolve(value));
  clip.readText = () => {
    clip.log.push(["read", clip.value]);
    return answer(clip.value);
  };
  clip.writeText = (text) => {
    clip.log.push(["write", text]);
    clip.value = text;
    return answer(undefined);
  };
  return clip;
}

/** A slow platform tool: the keys (the paste last) go out `ms` after the call; it records the clipboard then. */
function slowTool(clip, ms, fail) {
  const sent = [];
  return {
    sent,
    impl: {
      available: () => true,
      keys: (sequence) => new Promise((resolve, reject) => {
        clip.log.push(["keys-start", clip.value]);
        setTimeout(() => {
          clip.log.push(["keys-sent", clip.value]);
          sent.push({ keys: sequence.slice(), clipboard: clip.value });
          if (fail) reject(new Error("xdotool died"));
          else resolve();
        }, ms);
      }),
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const sync of [false, true]) {
  const kind = sync ? "a synchronous" : "a promise";
  test("with " + kind + " clipboard the previous text comes back only after a slow tool sent the paste", async () => {
    const clip = fakeClipboard("hunter2-copied-from-the-vault", sync);
    const tool = slowTool(clip, 8 * GRACE);
    const sender = createSender({ clipboard: clip, platform: "linux", impl: tool.impl, restoreDelayMs: GRACE });
    assert.deepEqual(await sender.replace({ backspaces: 3, text: "Dear Ms Jones, your refund is on its way." }), { ok: true });
    assert.deepEqual(tool.sent, [{ keys: ["BackSpace", "BackSpace", "BackSpace", "ctrl+v"], clipboard: "Dear Ms Jones, your refund is on its way." }],
      "the paste key went out with the text on the clipboard");
    assert.equal(clip.value, "Dear Ms Jones, your refund is on its way.", "not restored before the grace delay");
    await wait(3 * GRACE);
    assert.equal(clip.value, "hunter2-copied-from-the-vault", "restored after it");
    assert.deepEqual(clip.log.map((entry) => entry[0]), ["read", "write", "keys-start", "keys-sent", "read", "write"]);
  });
}

test("a run of queued jobs (a Forms fill) restores once, after the last keys", async () => {
  const clip = fakeClipboard("the person's copy");
  const tool = slowTool(clip, 2 * GRACE);
  const sender = createSender({ clipboard: clip, platform: "linux", impl: tool.impl, restoreDelayMs: GRACE });
  // Each step awaited before the next, as the Forms app sends them.
  assert.equal((await sender.replace({ text: "Acme GmbH" })).ok, true);
  assert.equal((await sender.press("tab", 2)).ok, true);
  assert.equal((await sender.replace({ text: "jane@example.com" })).ok, true);
  // Queued without waiting, as the shell may.
  const [a, b] = await Promise.all([sender.press("tab"), sender.replace({ text: "+49 30 1234" })]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(tool.sent.map((s) => s.clipboard), ["Acme GmbH", "Acme GmbH", "jane@example.com", "jane@example.com", "+49 30 1234"],
    "each paste saw its own value");
  assert.deepEqual(tool.sent[1].keys, ["Tab", "Tab"]);
  await wait(3 * GRACE);
  const restores = clip.log.filter((entry) => entry[0] === "write" && entry[1] === "the person's copy");
  assert.equal(restores.length, 1, "one restore for the whole run");
  assert.equal(clip.log.indexOf(restores[0]) > clip.log.map((e) => e[0]).lastIndexOf("keys-sent"), true, "after the last keys");
  assert.equal(clip.value, "the person's copy");
});

test("a copy made after a paste is kept, and one made between two pastes is what comes back", async () => {
  const clip = fakeClipboard("old copy");
  const tool = slowTool(clip, 1);
  const sender = createSender({ clipboard: clip, platform: "linux", impl: tool.impl, restoreDelayMs: GRACE });
  await sender.replace({ text: "inserted" });
  clip.value = "copied by the person right after"; // Ctrl+C during the grace delay
  await wait(3 * GRACE);
  assert.equal(clip.value, "copied by the person right after");

  await sender.replace({ text: "first" });
  clip.value = "new copy between two pastes";
  await sender.replace({ text: "second" });
  assert.equal(tool.sent.at(-1).clipboard, "second");
  await wait(3 * GRACE);
  assert.equal(clip.value, "new copy between two pastes");
});

test("a tool that fails reports it, and the clipboard still comes back", async () => {
  const clip = fakeClipboard("previous");
  const tool = slowTool(clip, 1, true);
  const notes = [];
  const sender = createSender({ clipboard: clip, platform: "linux", impl: tool.impl, restoreDelayMs: GRACE, notify: (line) => notes.push(line) });
  assert.deepEqual(await sender.replace({ text: "x" }), { ok: false, error: "xdotool died" });
  assert.match(notes[0], /Could not type into this application: xdotool died/);
  await wait(3 * GRACE);
  assert.equal(clip.value, "previous");
  const unavailable = createSender({ clipboard: clip, platform: "linux", impl: { available: () => false }, restoreDelayMs: GRACE });
  assert.equal((await unavailable.replace({ text: "y" })).ok, false);
  assert.equal(clip.value, "previous", "nothing written when typing is unavailable");
});

test("a clipboard that cannot be read still takes the text and the paste", async () => {
  const clip = fakeClipboard("unreadable");
  clip.readText = () => { throw new Error("clipboard busy"); };
  const tool = slowTool(clip, 1);
  const sender = createSender({ clipboard: clip, platform: "linux", impl: tool.impl, restoreDelayMs: GRACE });
  assert.deepEqual(await sender.replace({ text: "first" }), { ok: true });
  assert.deepEqual(await sender.replace({ text: "second" }), { ok: true });
  assert.deepEqual(tool.sent.map((s) => s.clipboard), ["first", "second"]);
  await wait(3 * GRACE);
  assert.equal(clip.value, "second", "nothing is put back when nothing could be read");
});

test("a clipboard that could not be read before the paste is never emptied when it answers later", async () => {
  const clip = fakeClipboard("the person's copy, unreadable for a moment");
  const read = clip.readText;
  let failures = 1;
  clip.readText = () => {
    if (failures-- > 0) throw new Error("clipboard busy");
    return read();
  };
  const tool = slowTool(clip, 1);
  const sender = createSender({ clipboard: clip, platform: "linux", impl: tool.impl, restoreDelayMs: GRACE });
  assert.deepEqual(await sender.replace({ text: "Kind regards" }), { ok: true });
  await wait(3 * GRACE);
  assert.equal(clip.value, "Kind regards", "left as it is: what was there before is unknown, so no empty text is written back");
  assert.deepEqual(clip.log.filter((entry) => entry[0] === "write").map((entry) => entry[1]), ["Kind regards"]);
  // A copy made between two pastes of a run is known, and comes back.
  failures = 1;
  await sender.replace({ text: "first" });
  clip.value = "copied between the pastes";
  await sender.replace({ text: "second" });
  await wait(3 * GRACE);
  assert.equal(clip.value, "copied between the pastes");
});

test("undoing an emoji expansion sends one Backspace per character the field still holds", async () => {
  const engine = createEngine({ library: [], policy: orgPolicy.parse({ library: [
    { trigger: "ok/", expansion: "👍 Agreed 🙂" }, { trigger: "🙂/", expansion: "smile" }, { trigger: "tone/", expansion: "👍🏽 Agreed 🙂" },
  ] }) });
  engine.focusChanged({ process: "notepad" });
  let actions = [];
  for (const ch of "ok/") actions = actions.concat(engine.keyTyped({ text: ch }));
  const clip = fakeClipboard("");
  const tool = slowTool(clip, 1);
  const sender = createSender({ clipboard: clip, platform: "linux", impl: tool.impl, restoreDelayMs: GRACE });
  await sender.replace(actions[0]);
  // 10 characters (12 UTF-16 units); the person's own Backspace reached the field and took one.
  const [undo] = engine.keyTyped({ isBackspace: true });
  await sender.undo(undo);
  const keys = tool.sent[1].keys;
  assert.equal(keys.filter((k) => k === "BackSpace").length, 9);
  assert.equal(keys.filter((k) => k === "Delete").length, 0);
  assert.equal(keys.at(-1), "ctrl+v");
  assert.equal(tool.sent[1].clipboard, "ok/");
  // A trigger with an emoji in it: two characters typed, two Backspaces.
  engine.focusChanged({ process: "notepad" });
  actions = [];
  for (const ch of Array.from(" 🙂/")) actions = actions.concat(engine.keyTyped({ text: ch }));
  await sender.replace(actions[0]);
  assert.deepEqual(tool.sent[2].keys, ["BackSpace", "BackSpace", "ctrl+v"]);
  // A skin-toned emoji is one or two Backspaces depending on the application: no undo, so no keys at all.
  engine.focusChanged({ process: "chrome.exe" });
  actions = [];
  for (const ch of " tone/") actions = actions.concat(engine.keyTyped({ text: ch }));
  await sender.replace(actions[0]);
  assert.deepEqual(engine.keyTyped({ isBackspace: true }), []);
  assert.equal(tool.sent.length, 4, "nothing more was sent");
  await wait(3 * GRACE);
});
