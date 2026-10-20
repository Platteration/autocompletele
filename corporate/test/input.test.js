const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTable, translate, createState } = require("../desktop/adapters/input.js");
const layouts = require("../desktop/adapters/layouts.js");
const { fromOutput, detectLayout } = require("../desktop/adapters/keyboard-layout.js");

// A synthetic UiohookKey map: the table builder only needs names and numbers.
const NAMES = {};
let code = 1;
for (const name of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", ..."0123456789", "Space", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash", "IntlBackslash",
  "Numpad0", "Numpad5", "NumpadMultiply", "NumpadAdd", "NumpadSubtract", "NumpadDecimal", "NumpadDivide", "NumpadEnter",
  "Backspace", "Enter", "Tab", "CapsLock", "Shift", "ShiftRight", "Ctrl", "CtrlRight", "Alt", "AltRight", "Meta", "MetaRight", "Escape", "ArrowLeft", "Home", "F1", "F12"]) NAMES[name] = code++;

const key = (layout, name, mods, state, caps) => translate(Object.assign({ keycode: NAMES[name] }, mods || {}), buildTable(NAMES, layout), !!caps, state);

test("the US table reproduces the former fixed mapping for every key", () => {
  const PLAIN = { Space: " ", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/",
    NumpadMultiply: "*", NumpadAdd: "+", NumpadSubtract: "-", NumpadDecimal: ".", NumpadDivide: "/" };
  const SHIFTED = { Minus: "_", Equal: "+", BracketLeft: "{", BracketRight: "}", Backslash: "|", Semicolon: ":", Quote: "\"", Backquote: "~", Comma: "<", Period: ">", Slash: "?",
    0: ")", 1: "!", 2: "@", 3: "#", 4: "$", 5: "%", 6: "^", 7: "&", 8: "*", 9: "(" };
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    assert.equal(key("en-US", letter).text, letter.toLowerCase());
    assert.equal(key("en-US", letter, { shiftKey: true }).text, letter);
    assert.equal(key("en-US", letter, {}, null, true).text, letter, "caps lock");
    assert.equal(key("en-US", letter, { shiftKey: true }, null, true).text, letter.toLowerCase(), "caps lock with shift");
  }
  for (const digit of "0123456789") {
    assert.equal(key("en-US", digit).text, digit);
    assert.equal(key("en-US", digit, { shiftKey: true }).text, SHIFTED[digit]);
  }
  for (const [name, plain] of Object.entries(PLAIN)) {
    assert.equal(key("en-US", name).text, plain, name);
    assert.equal(key("en-US", name, { shiftKey: true }).text, SHIFTED[name] || plain, name + " shifted");
  }
  assert.equal(key("en-US", "Numpad5").text, "5");
  assert.equal(key("en-US", "Numpad5", { shiftKey: true }).text, "5");
  assert.equal(key("en-US", "IntlBackslash").text, "", "no such key on the US layout");
  assert.deepEqual(key("en-US", "Backspace"), { text: "", isBackspace: true, resetsBuffer: false });
  assert.deepEqual(key("en-US", "Enter"), { text: "\n", isBackspace: false, resetsBuffer: true });
  assert.deepEqual(key("en-US", "NumpadEnter"), { text: "\n", isBackspace: false, resetsBuffer: true });
  assert.deepEqual(key("en-US", "Tab"), { text: "\t", isBackspace: false, resetsBuffer: true });
  assert.deepEqual(key("en-US", "Shift"), { text: "", isBackspace: false, resetsBuffer: false });
  assert.deepEqual(key("en-US", "A", { ctrlKey: true }), { text: "", isBackspace: false, resetsBuffer: true });
  assert.deepEqual(key("en-US", "ArrowLeft"), { text: "", isBackspace: false, resetsBuffer: true });
  assert.deepEqual(key("en-US", "F12"), { text: "", isBackspace: false, resetsBuffer: true });
  assert.equal(buildTable(NAMES, "en-US").layout, "en-US");
  assert.equal(buildTable(NAMES, "nope").layout, "en-US", "unknown layouts fall back to US");
});

test("national layouts: swapped letters, AltGr levels and shifted symbols", () => {
  assert.equal(key("de-DE", "Y").text, "z");
  assert.equal(key("de-DE", "Z", { shiftKey: true }).text, "Y");
  assert.equal(key("de-DE", "Q", { ctrlKey: true, altKey: true }).text, "@", "Windows reports AltGr as Ctrl+Alt");
  assert.equal(key("de-DE", "Minus").text, "ß");
  assert.equal(key("de-DE", "IntlBackslash", { shiftKey: true }).text, ">");
  assert.equal(key("en-GB", "3", { shiftKey: true }).text, "£");
  assert.equal(key("en-GB", "4", { ctrlKey: true, altKey: true }).text, "€");
  assert.equal(key("en-GB", "Quote", { shiftKey: true }).text, "@");
  assert.equal(key("fr-FR", "A").text, "q");
  assert.equal(key("fr-FR", "2").text, "é");
  assert.equal(key("fr-FR", "2", { shiftKey: true }).text, "2");
  assert.equal(key("fr-FR", "M").text, ",");
  assert.equal(key("es-ES", "Semicolon", { shiftKey: true }).text, "Ñ");
  assert.equal(key("sv-SE", "BracketLeft", {}, null, true).text, "Å", "caps lock applies to å");
  assert.equal(key("nb-NO", "Semicolon").text, "ø");
  assert.equal(key("da-DK", "Quote").text, "ø");
  assert.equal(key("pt-PT", "Semicolon").text, "ç");
  assert.equal(key("nl-NL", "Backquote").text, "@");
  assert.equal(key("de-DE", "A", { altKey: true }).text, "", "plain Alt is a shortcut");
  assert.equal(key("de-DE", "A", { altKey: true }).resetsBuffer, true);
  assert.equal(key("de-DE", "2", { ctrlKey: true, altKey: true, shiftKey: true }).text, "²", "Shift+AltGr falls back to the AltGr level");
});

test("dead keys compose with the next letter, type themselves on Space, and stay literal otherwise", () => {
  const table = buildTable(NAMES, "de-DE");
  const state = createState();
  const press = (name, mods) => translate(Object.assign({ keycode: NAMES[name] }, mods || {}), table, false, state);
  assert.deepEqual(press("Equal"), { text: "", isBackspace: false, resetsBuffer: false }, "the dead key alone types nothing");
  assert.equal(press("E").text, "é");
  press("Equal");
  assert.equal(press("E", { shiftKey: true }).text, "É");
  press("Equal");
  assert.equal(press("Space").text, "´", "dead key then Space types the mark");
  press("Equal");
  assert.equal(press("X").text, "´x", "not composable: mark and letter");
  press("Equal");
  assert.equal(press("Equal").text, "´", "two dead keys: the first is typed");
  assert.equal(press("A").text, "á");
  press("Equal");
  assert.equal(press("Backspace").isBackspace, true);
  assert.equal(press("E").text, "e", "Backspace cancels the pending mark");
  press("Backquote");
  assert.equal(press("O").text, "ô", "the German circumflex key");
  // Right Alt held acts as AltGr on platforms that do not report Ctrl+Alt.
  assert.equal(press("AltRight").text, "");
  assert.equal(state.rightAlt, true);
  assert.equal(press("Q").text, "@");
  state.rightAlt = false;
  assert.equal(press("Q").text, "q");
});

test("layout detection maps each platform's output and tolerates failure", async () => {
  assert.equal(fromOutput("win32", "0407:00000407"), "de-DE");
  assert.equal(fromOutput("win32", "0809:00000809\r\n"), "en-GB");
  assert.equal(fromOutput("win32", "040C:0000040C"), "fr-FR");
  assert.equal(fromOutput("win32", "0409:00020409"), "en-US", "US-International is treated as US");
  assert.equal(fromOutput("win32", "0411:00000411"), null, "Japanese is not covered");
  assert.equal(fromOutput("darwin", '(\n    {\n        "Bundle ID" = "com.apple.keylayout.German";\n        InputSourceKind = "Keyboard Layout";\n        "KeyboardLayout ID" = 3;\n        "KeyboardLayout Name" = German;\n    }\n)'), "de-DE");
  assert.equal(fromOutput("darwin", '"KeyboardLayout Name" = "Swedish - Pro";'), "sv-SE");
  assert.equal(fromOutput("darwin", '"KeyboardLayout Name" = "U.S.";'), "en-US");
  assert.equal(fromOutput("linux", "rules:      evdev\nmodel:      pc105\nlayout:     se,us\nvariant:    ,\n"), "sv-SE");
  assert.equal(fromOutput("linux", "layout:     gb\n"), "en-GB");
  assert.equal(fromOutput("linux", "layout:     ru\n"), null);
  assert.equal(fromOutput("sunos", "anything"), null);
  assert.equal(await detectLayout("win32", async () => "0413:00000413"), "nl-NL");
  assert.equal(await detectLayout("linux", async () => { throw new Error("no X"); }), null);
  assert.equal(await detectLayout("other", async () => "x"), null);
  assert.deepEqual(layouts.names().slice(0, 2), ["en-US", "en-GB"]);
  assert.equal(layouts.expand("de-DE").keys.Y[0], "z");
  assert.equal(layouts.expand("de-DE").exact, false);
});
