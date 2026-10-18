// Warnings about a shorthand list that the matching rules make invisible.
//
// This is deliberately not part of expander.js: that file is mirrored line for
// line on Windows and Android and is pinned by shared/conformance.json, whereas
// this is advice shown in the manager only.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ShorthandConflicts = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const WORD_ONLY = /^[\p{L}\p{N}_]+$/u;

  /**
   * Inspect a list of shorthands for triggers that will misbehave.
   *
   * Three problems are worth warning about:
   *
   * - `unreachable`: another trigger is a proper prefix of this one. Expansion
   *   fires the moment the text before the caret ends with a trigger, so the
   *   shorter one always wins and the longer can never be typed. With `sig`
   *   and `sig/` defined, `sig` fires after three characters and `sig/` is
   *   dead.
   *
   * - `fires-mid-word`: the trigger is only letters, digits or underscores, so
   *   it fires inside ordinary words. A trigger of `sig` goes off partway
   *   through typing "signature".
   *
   * - `duplicate`: more than one shorthand uses the trigger, which Chrome sync
   *   can produce by merging two devices' libraries. The content script ranks
   *   the library by use count in this browser, keeping library order for
   *   ties, and findMatch keeps the first of equally long matches, so typing
   *   the trigger only ever expands one of them. (The picker and suggestions
   *   still list both.)
   *
   * Each warning is reported once per trigger, however many shorthands use it.
   *
   * @param {Array<{trigger: string}>} shorthands
   * @returns {Array<{trigger: string, kind: string, other?: string, count?: number, message: string}>}
   */
  function find(shorthands) {
    const out = [];
    if (!Array.isArray(shorthands)) return out;

    const uses = new Map();
    for (const s of shorthands) {
      const trigger = s && typeof s.trigger === "string" ? s.trigger : "";
      if (trigger) uses.set(trigger, (uses.get(trigger) || 0) + 1);
    }
    const triggers = [...uses.keys()];

    for (const trigger of triggers) {
      const count = uses.get(trigger);
      if (count > 1) {
        out.push({
          trigger,
          kind: "duplicate",
          count,
          message:
            `${count === 2 ? "Two" : count} shorthands use "${trigger}". Typing it expands only one of them: ` +
            `the one used most in this browser, or the first in the list when they are tied. ` +
            `Rename or delete the ${count === 2 ? "other" : "others"}.`,
        });
      }

      // Shortest prefix first, so the warning names the trigger that actually wins.
      const blockers = triggers
        .filter((other) => other !== trigger && trigger.startsWith(other))
        .sort((a, b) => a.length - b.length);

      if (blockers.length > 0) {
        out.push({
          trigger,
          kind: "unreachable",
          other: blockers[0],
          message:
            `"${trigger}" can never fire, because "${blockers[0]}" expands as soon as you type it.`,
        });
      }

      if (WORD_ONLY.test(trigger)) {
        out.push({
          trigger,
          kind: "fires-mid-word",
          message:
            `"${trigger}" is only letters and digits, so it fires inside ordinary words. ` +
            `Ending it with a symbol, like "${trigger}/", avoids that.`,
        });
      }
    }
    return out;
  }

  /** Group the warnings by trigger, for rendering next to each row. */
  function byTrigger(shorthands) {
    const map = new Map();
    for (const c of find(shorthands)) {
      if (!map.has(c.trigger)) map.set(c.trigger, []);
      map.get(c.trigger).push(c);
    }
    return map;
  }

  return { find, byTrigger };
});
