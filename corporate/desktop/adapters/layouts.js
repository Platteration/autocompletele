// Keyboard layouts for the listener: which character each physical key
// produces at four levels (plain, Shift, AltGr, Shift+AltGr), and how dead
// keys compose with the letter typed next. Keys are named as uiohook names
// them (A..Z, 0..9, Minus, Equal, BracketLeft, ...; IntlBackslash is the key
// left of Z on ISO keyboards). A level value starting with "†" is a dead key.
//
// en-US is exact and is what the listener always used. The other layouts
// cover the alphanumeric block of the common national variants; they are
// best effort until checked on a real keyboard (see the desktop README).
"use strict";

const DEAD = "†";

const US = {
  A: "aA", B: "bB", C: "cC", D: "dD", E: "eE", F: "fF", G: "gG", H: "hH", I: "iI", J: "jJ", K: "kK", L: "lL", M: "mM",
  N: "nN", O: "oO", P: "pP", Q: "qQ", R: "rR", S: "sS", T: "tT", U: "uU", V: "vV", W: "wW", X: "xX", Y: "yY", Z: "zZ",
  0: ["0", ")"], 1: ["1", "!"], 2: ["2", "@"], 3: ["3", "#"], 4: ["4", "$"], 5: ["5", "%"], 6: ["6", "^"], 7: ["7", "&"], 8: ["8", "*"], 9: ["9", "("],
  Space: [" ", " "], Minus: ["-", "_"], Equal: ["=", "+"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"],
  Semicolon: [";", ":"], Quote: ["'", "\""], Backquote: ["`", "~"], Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"],
  NumpadMultiply: ["*", "*"], NumpadAdd: ["+", "+"], NumpadSubtract: ["-", "-"], NumpadDecimal: [".", "."], NumpadDivide: ["/", "/"],
  Numpad0: ["0", "0"], Numpad1: ["1", "1"], Numpad2: ["2", "2"], Numpad3: ["3", "3"], Numpad4: ["4", "4"],
  Numpad5: ["5", "5"], Numpad6: ["6", "6"], Numpad7: ["7", "7"], Numpad8: ["8", "8"], Numpad9: ["9", "9"],
};

// Compose tables shared by every layout: dead mark + letter -> letter with the mark.
const COMPOSE = {
  "´": { a: "á", e: "é", i: "í", o: "ó", u: "ú", y: "ý", c: "ć", n: "ń", s: "ś", z: "ź", l: "ĺ", r: "ŕ", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", Y: "Ý", C: "Ć", N: "Ń", S: "Ś", Z: "Ź", L: "Ĺ", R: "Ŕ" },
  "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
  "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
  "¨": { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", y: "ÿ", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü", Y: "Ÿ" },
  "~": { a: "ã", o: "õ", n: "ñ", A: "Ã", O: "Õ", N: "Ñ" },
  "°": {},
};

// Each layout: overrides on top of US. A value is a string of up to four
// graphemes (plain, shift, altgr, shift+altgr) or an array of level strings.
const LAYOUTS = {
  "en-US": { name: "English (US)", keys: {} },
  "en-GB": { name: "English (UK)", keys: {
    Backquote: ["`", "¬", "¦"], 2: ["2", "\""], 3: ["3", "£"], 4: ["4", "$", "€"], Quote: ["'", "@"], Backslash: ["#", "~"], IntlBackslash: ["\\", "|"],
    E: ["e", "E", "é", "É"], A: ["a", "A", "á", "Á"], I: ["i", "I", "í", "Í"], O: ["o", "O", "ó", "Ó"], U: ["u", "U", "ú", "Ú"],
  } },
  "de-DE": { name: "German", keys: {
    Y: "zZ", Z: "yY", Backquote: [DEAD + "^", "°"], 2: ["2", "\"", "²"], 3: ["3", "§", "³"], 6: ["6", "&"], 7: ["7", "/", "{"], 8: ["8", "(", "["], 9: ["9", ")", "]"],
    0: ["0", "=", "}"], Minus: ["ß", "?", "\\"], Equal: [DEAD + "´", DEAD + "`"], BracketLeft: ["ü", "Ü"], BracketRight: ["+", "*", "~"], Semicolon: ["ö", "Ö"],
    Quote: ["ä", "Ä"], Backslash: ["#", "'"], Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "_"], Q: ["q", "Q", "@"], E: ["e", "E", "€"], M: ["m", "M", "µ"],
    IntlBackslash: ["<", ">", "|"],
  } },
  "fr-FR": { name: "French", keys: {
    A: "qQ", Q: "aA", Z: "wW", W: "zZ", M: [",", "?"], Semicolon: ["m", "M"],
    1: ["&", "1"], 2: ["é", "2", "~"], 3: ["\"", "3", "#"], 4: ["'", "4", "{"], 5: ["(", "5", "["], 6: ["-", "6", "|"], 7: ["è", "7", "`"], 8: ["_", "8", "\\"], 9: ["ç", "9", "^"], 0: ["à", "0", "@"],
    Minus: [")", "°", "]"], Equal: ["=", "+", "}"], BracketLeft: [DEAD + "^", DEAD + "¨"], BracketRight: ["$", "£", "¤"], Quote: ["ù", "%"], Backslash: ["*", "µ"],
    Comma: [";", "."], Period: [":", "/"], Slash: ["!", "§"], Backquote: ["²"], IntlBackslash: ["<", ">"], E: ["e", "E", "€"],
  } },
  "es-ES": { name: "Spanish", keys: {
    Backquote: ["º", "ª", "\\"], 1: ["1", "!", "|"], 2: ["2", "\"", "@"], 3: ["3", "·", "#"], 4: ["4", "$", "~"], 6: ["6", "&", "¬"], 7: ["7", "/"], 8: ["8", "("], 9: ["9", ")"], 0: ["0", "="],
    Minus: ["'", "?"], Equal: ["¡", "¿"], BracketLeft: [DEAD + "`", DEAD + "^", "["], BracketRight: ["+", "*", "]"], Semicolon: ["ñ", "Ñ"], Quote: [DEAD + "´", DEAD + "¨", "{"],
    Backslash: ["ç", "Ç", "}"], Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "_"], IntlBackslash: ["<", ">"], E: ["e", "E", "€"],
  } },
  "sv-SE": { name: "Swedish", keys: {
    Backquote: ["§", "½"], 2: ["2", "\"", "@"], 3: ["3", "#", "£"], 4: ["4", "¤", "$"], 5: ["5", "%", "€"], 6: ["6", "&"], 7: ["7", "/", "{"], 8: ["8", "(", "["], 9: ["9", ")", "]"], 0: ["0", "=", "}"],
    Minus: ["+", "?", "\\"], Equal: [DEAD + "´", DEAD + "`"], BracketLeft: ["å", "Å"], BracketRight: [DEAD + "¨", DEAD + "^", DEAD + "~"], Semicolon: ["ö", "Ö"], Quote: ["ä", "Ä"],
    Backslash: ["'", "*"], Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "_"], IntlBackslash: ["<", ">", "|"], E: ["e", "E", "€"],
  } },
  "nb-NO": { name: "Norwegian", keys: {
    Backquote: ["|", "§"], 2: ["2", "\"", "@"], 3: ["3", "#", "£"], 4: ["4", "¤", "$"], 5: ["5", "%", "€"], 6: ["6", "&"], 7: ["7", "/", "{"], 8: ["8", "(", "["], 9: ["9", ")", "]"], 0: ["0", "=", "}"],
    Minus: ["+", "?"], Equal: ["\\", "`", DEAD + "´"], BracketLeft: ["å", "Å"], BracketRight: [DEAD + "¨", DEAD + "^", DEAD + "~"], Semicolon: ["ø", "Ø"], Quote: ["æ", "Æ"],
    Backslash: ["'", "*"], Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "_"], IntlBackslash: ["<", ">"], E: ["e", "E", "€"],
  } },
  "da-DK": { name: "Danish", keys: {
    Backquote: ["½", "§"], 2: ["2", "\"", "@"], 3: ["3", "#", "£"], 4: ["4", "¤", "$"], 5: ["5", "%", "€"], 6: ["6", "&"], 7: ["7", "/", "{"], 8: ["8", "(", "["], 9: ["9", ")", "]"], 0: ["0", "=", "}"],
    Minus: ["+", "?"], Equal: [DEAD + "´", DEAD + "`", "|"], BracketLeft: ["å", "Å"], BracketRight: [DEAD + "¨", DEAD + "^", DEAD + "~"], Semicolon: ["æ", "Æ"], Quote: ["ø", "Ø"],
    Backslash: ["'", "*"], Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "_"], IntlBackslash: ["<", ">", "\\"], E: ["e", "E", "€"],
  } },
  "nl-NL": { name: "Dutch", keys: {
    Backquote: ["@", "§", "¬"], 1: ["1", "!", "¹"], 2: ["2", "\"", "²"], 3: ["3", "#", "³"], 4: ["4", "$", "¼"], 5: ["5", "%", "½"], 6: ["6", "&", "¾"], 7: ["7", "_", "£"], 8: ["8", "(", "{"], 9: ["9", ")", "}"], 0: ["0", "'"],
    Minus: ["/", "?", "\\"], Equal: [DEAD + "°", DEAD + "~"], BracketLeft: [DEAD + "¨", DEAD + "^"], BracketRight: ["*", "|"], Semicolon: ["+", "±"], Quote: [DEAD + "´", DEAD + "`"],
    Backslash: ["<", ">"], Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "="], IntlBackslash: ["]", "["], E: ["e", "E", "€"],
  } },
  "pt-PT": { name: "Portuguese", keys: {
    Backquote: ["\\", "|"], 2: ["2", "\"", "@"], 3: ["3", "#", "£"], 4: ["4", "$", "§"], 5: ["5", "%", "€"], 6: ["6", "&"], 7: ["7", "/", "{"], 8: ["8", "(", "["], 9: ["9", ")", "]"], 0: ["0", "=", "}"],
    Minus: ["'", "?"], Equal: ["«", "»"], BracketLeft: ["+", "*", DEAD + "¨"], BracketRight: [DEAD + "´", DEAD + "`"], Semicolon: ["ç", "Ç"], Quote: ["º", "ª"],
    Backslash: [DEAD + "~", DEAD + "^"], Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "_"], IntlBackslash: ["<", ">"], E: ["e", "E", "€"],
  } },
};

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function graphemes(text) {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Levels of one key value: a 2-to-4 grapheme string or an array of level strings. */
function levelsOf(value) {
  const parts = Array.isArray(value) ? value.map(String) : graphemes(String(value));
  const out = [];
  for (let i = 0; i < 4; i++) {
    let level = parts[i];
    if (Array.isArray(value) && typeof level === "string" && level.startsWith(DEAD)) {
      out.push(level);
      continue;
    }
    if (!Array.isArray(value) && level === DEAD) {
      // in the compact string form a dead key is written as "†x"
      level = DEAD + (parts[i + 1] || "");
      parts.splice(i + 1, 1);
    }
    out.push(level == null ? null : level);
  }
  return out;
}

function names() {
  return Object.keys(LAYOUTS);
}

/** Resolve a layout by name: { id, name, keys: { KeyName: [level0..level3] }, compose }. Unknown names fall back to en-US. */
function expand(id) {
  const key = LAYOUTS[id] ? id : "en-US";
  const layout = LAYOUTS[key];
  const keys = {};
  for (const [name, value] of Object.entries(US)) keys[name] = levelsOf(value);
  for (const [name, value] of Object.entries(layout.keys)) keys[name] = levelsOf(value);
  return { id: key, name: layout.name, keys, compose: COMPOSE, exact: key === "en-US" };
}

function isDead(level) {
  return typeof level === "string" && level.startsWith(DEAD);
}

function deadMark(level) {
  return isDead(level) ? level.slice(DEAD.length) : null;
}

module.exports = { DEAD, LAYOUTS, COMPOSE, names, expand, levelsOf, isDead, deadMark };
