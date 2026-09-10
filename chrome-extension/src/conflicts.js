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
   * Two problems are worth warning about:
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
   * @param {Array<{trigger: string}>} shorthands
   * @returns {Array<{trigger: string, kind: string, other?: string, message: string}>}
   */
  function find(shorthands) {
    const out = [];
    if (!Array.isArray(shorthands)) return out;

    const triggers = shorthands
      .map((s) => (s && typeof s.trigger === "string" ? s.trigger : ""))
      .filter(Boolean);

    for (const trigger of triggers) {
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
