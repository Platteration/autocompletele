// Pure shorthand-matching logic shared by the content script and the tests.
// Mirrors the rules in shared/SPEC.md. No DOM access here.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ShorthandExpander = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // A trigger may only fire when the character before it is a boundary:
  // start of text, whitespace, or punctuation (anything that is not a letter,
  // digit or underscore).
  function isBoundary(ch) {
    if (ch === undefined || ch === "") return true;
    return !/[\p{L}\p{N}_]/u.test(ch);
  }

  /**
   * Find the shorthand whose trigger ends exactly at the caret.
   * @param {string} textBeforeCaret
   * @param {Array<{trigger:string, expansion:string}>} shorthands
   * @returns {{shorthand:object, start:number}|null} start = index where the trigger begins
   */
  function findMatch(textBeforeCaret, shorthands) {
    if (!textBeforeCaret || !shorthands || shorthands.length === 0) return null;
    let best = null;
    for (const sh of shorthands) {
      const t = sh && sh.trigger;
      if (!t || t.length > textBeforeCaret.length) continue;
      if (!textBeforeCaret.endsWith(t)) continue;
      const start = textBeforeCaret.length - t.length;
      if (!isBoundary(textBeforeCaret[start - 1])) continue;
      if (!best || t.length > best.shorthand.trigger.length) {
        best = { shorthand: sh, start };
      }
    }
    return best;
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatDate(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function formatTime(d) {
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /**
   * Substitute placeholders in an expansion.
   * @param {string} expansion
   * @param {Date} [now]
   * @returns {{text:string, cursorOffset:number}} cursorOffset = where the caret
   *   should end up, measured from the start of `text` (text.length when no {cursor}).
   */
  function render(expansion, now) {
    const d = now || new Date();
    const values = {
      date: formatDate(d),
      time: formatTime(d),
      datetime: formatDate(d) + " " + formatTime(d),
    };
    let out = "";
    let cursorOffset = -1;
    let i = 0;
    const src = String(expansion == null ? "" : expansion);
    while (i < src.length) {
      const ch = src[i];
      if (ch === "{") {
        // Escaped literal: {{name}} -> {name}
        const escaped = /^\{\{([a-z]+)\}\}/i.exec(src.slice(i));
        if (escaped) {
          out += "{" + escaped[1] + "}";
          i += escaped[0].length;
          continue;
        }
        const m = /^\{([a-z]+)\}/i.exec(src.slice(i));
        if (m) {
          const name = m[1].toLowerCase();
          if (name === "cursor") {
            if (cursorOffset < 0) cursorOffset = out.length;
            i += m[0].length;
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(values, name)) {
            out += values[name];
            i += m[0].length;
            continue;
          }
        }
      }
      out += ch;
      i++;
    }
    if (cursorOffset < 0) cursorOffset = out.length;
    return { text: out, cursorOffset };
  }

  /** Normalise a raw list (e.g. from an imported file) into valid shorthands. */
  function sanitizeList(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const trigger = String(item.trigger == null ? "" : item.trigger).trim();
      const expansion = String(item.expansion == null ? "" : item.expansion);
      if (!trigger || seen.has(trigger)) continue;
      seen.add(trigger);
      out.push({ trigger, expansion });
    }
    return out;
  }

  return { findMatch, render, sanitizeList, isBoundary };
});
