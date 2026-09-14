(function (root) {
  "use strict";

  function normalize(list) {
    return (Array.isArray(list) ? list : []).map((item) => ({
      trigger: String((item && item.trigger) || ""),
      expansion: String((item && item.expansion) || ""),
    }));
  }

  function planImport(current, incoming) {
    const cleanCurrent = normalize(current);
    const cleanIncoming = normalize(incoming);
    const existing = new Map(cleanCurrent.map((item) => [item.trigger, item.expansion]));
    const additions = [];
    const updates = [];
    const unchanged = [];

    for (const item of cleanIncoming) {
      if (!existing.has(item.trigger)) {
        additions.push(item);
      } else if (existing.get(item.trigger) === item.expansion) {
        unchanged.push(item);
      } else {
        updates.push({ trigger: item.trigger, before: existing.get(item.trigger), after: item.expansion });
      }
    }

    return {
      additions,
      updates,
      unchanged,
      incomingCount: cleanIncoming.length,
      changedCount: additions.length + updates.length,
    };
  }

  function mergeImport(current, incoming) {
    const result = normalize(current);
    const index = new Map(result.map((item, i) => [item.trigger, i]));
    for (const item of normalize(incoming)) {
      if (index.has(item.trigger)) {
        result[index.get(item.trigger)] = item;
      } else {
        index.set(item.trigger, result.length);
        result.push(item);
      }
    }
    return result;
  }

  const api = { planImport, mergeImport };
  root.ShorthandImportPlan = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
