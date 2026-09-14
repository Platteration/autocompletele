(function (root) {
  "use strict";

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function score(shorthand, query) {
    const q = normalize(query);
    if (!q) return 1;
    const trigger = normalize(shorthand && shorthand.trigger);
    const expansion = normalize(shorthand && shorthand.expansion);
    if (!trigger && !expansion) return -1;

    if (trigger === q) return 100;
    if (trigger.startsWith(q)) return 80 - Math.min(trigger.length - q.length, 20);
    if (trigger.includes(q)) return 60 - Math.min(trigger.indexOf(q), 20);
    if (expansion.startsWith(q)) return 40;
    if (expansion.includes(q)) return 20;

    // Tiny subsequence fallback so "thx" can still surface "thank you"-style entries.
    let qi = 0;
    for (let i = 0; i < trigger.length && qi < q.length; i++) {
      if (trigger[i] === q[qi]) qi++;
    }
    if (qi === q.length) return 10;
    return -1;
  }

  function search(list, query, limit) {
    const cap = Number.isFinite(limit) ? Math.max(0, limit) : 6;
    return (Array.isArray(list) ? list : [])
      .map((item, index) => ({ item, index, score: score(item, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, cap)
      .map((entry) => entry.item);
  }

  root.ShorthandPalette = { score, search };
})(typeof self !== "undefined" ? self : this);
