// Search over everything a person can insert: their own and the
// organisation's shortcuts, and the organisation's document sets. Scoring is
// the browser extension's palette scoring, shared rather than copied.
"use strict";

const { palette, template } = require("./personal.js");

function preview(text) {
  // {cursor} only says where the caret lands; it is noise in a preview.
  return String(text == null ? "" : text).replace(/\{cursor\}/gi, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Items a palette can list, in library order, then document sets, then filed documents. */
function items(library, documents, filingIndex) {
  const out = [];
  for (const sh of Array.isArray(library) ? library : []) {
    out.push({
      kind: "shortcut",
      trigger: sh.trigger,
      // palette.score matches the query against trigger and expansion.
      expansion: sh.expansion,
      source: sh.source || "personal",
      needsInput: template.requiresInput(sh.expansion),
      preview: preview(sh.expansion),
    });
  }
  const shortcuts = documents && Array.isArray(documents.shortcuts) ? documents.shortcuts : [];
  for (const set of shortcuts) {
    const titles = set.documents.map((doc) => doc.title).join(", ");
    out.push({
      kind: "documents",
      trigger: set.trigger,
      expansion: set.label + " " + titles + " " + set.documents.flatMap((doc) => doc.tags || []).join(" "),
      source: "organization",
      needsInput: false,
      preview: set.label + ": " + titles,
    });
  }
  const filed = filingIndex && Array.isArray(filingIndex.entries) ? filingIndex.entries : [];
  for (const entry of filed) {
    out.push({
      kind: "file",
      trigger: entry.name,
      expansion: [entry.ruleLabel, entry.originalName, entry.folder, ...Object.values(entry.values || {})].filter(Boolean).join(" "),
      source: "organization",
      needsInput: false,
      preview: (entry.ruleLabel ? entry.ruleLabel + ": " : "") + (entry.folder || entry.path),
      path: entry.path,
    });
  }
  return out;
}

function search(list, query, limit) {
  return palette.search(list, query, Number.isFinite(limit) ? limit : 8);
}

module.exports = { items, search };
