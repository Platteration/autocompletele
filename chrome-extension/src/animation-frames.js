// Pure visual frames. These strings never become intermediate editor values.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ShorthandAnimationFrames = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DURATIONS = Object.freeze({ expand: 480, casino: 600 });
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const graphemes = (text) => [...segmenter.segment(text)].map(({ segment }) => segment);

  function plan(trigger, text) {
    trigger = String(trigger == null ? "" : trigger);
    text = String(text == null ? "" : text);
    const source = graphemes(trigger);
    const glyphs = graphemes(text);
    // Bound the alignment work; long scripts keep the inexpensive field cue.
    if (source.length > 128 || glyphs.length > 512) return null;
    const lengths = Array.from({ length: source.length + 1 }, () => new Uint16Array(glyphs.length + 1));
    for (let i = source.length - 1; i >= 0; i--) {
      for (let j = glyphs.length - 1; j >= 0; j--) {
        lengths[i][j] = source[i] === glyphs[j] ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
      }
    }
    const anchors = [];
    let i = 0;
    let j = 0;
    while (i < source.length && j < glyphs.length) {
      if (source[i] === glyphs[j]) { anchors.push(j++); i++; }
      else if (lengths[i + 1][j] > lengths[i][j + 1]) i++;
      else j++;
    }
    const anchored = new Set(anchors);
    const missing = glyphs.map((_, index) => index).filter((index) => !anchored.has(index));
    return { trigger, text, glyphs, anchors, missing };
  }

  function frame(sequence, mode, elapsedMs, random = Math.random) {
    const { glyphs } = sequence;
    const duration = DURATIONS[mode];
    let time = Number(elapsedMs);
    if (Number.isNaN(time)) time = 0;
    if (!duration || time >= duration) return { text: sequence.text, locked: glyphs.length, done: true };
    time = Math.max(0, time);
    if (mode === "expand") {
      if (time < 100) return { text: sequence.trigger, locked: 0, done: false };
      const count = Math.floor((time - 100) / (duration - 100) * sequence.missing.length);
      const visible = new Set([...sequence.anchors, ...sequence.missing.slice(0, count)]);
      let locked = 0;
      while (visible.has(locked)) locked++;
      return { text: glyphs.filter((_, index) => visible.has(index)).join(""), locked, done: false };
    }
    const locked = Math.floor(time / duration * glyphs.length);
    const text = glyphs.map((glyph, index) => {
      if (index < locked || /^[\p{P}\p{Z}\s]+$/u.test(glyph)) return glyph;
      const sample = Number(random());
      const value = Number.isFinite(sample) ? Math.min(1 - Number.EPSILON, Math.max(0, sample)) : 0;
      return alphabet[Math.floor(value * alphabet.length)];
    }).join("");
    return { text, locked, done: false };
  }

  return { DURATIONS, plan, frame };
});
