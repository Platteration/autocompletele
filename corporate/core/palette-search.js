// Search over everything a person can insert: their own and the
// organisation's shortcuts, and the organisation's document sets. Scoring is
// the browser extension's palette scoring, shared rather than copied.
"use strict";

const { palette, template } = require("./personal.js");

function preview(text) {
  // {cursor} only says where the caret lands; it is noise in a preview.
  return String(text == null ? "" : text).replace(/\{cursor\}/gi, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Items a palette can list, in library order, then document sets, then lookups. */
function items(library, documents, lookups) {
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
  for (const lookup of Array.isArray(lookups) ? lookups : []) {
    out.push({
      kind: "lookup",
      trigger: lookup.trigger,
      expansion: lookup.label + " " + lookup.template,
      source: "organization",
      needsInput: true,
      preview: lookup.trigger + " <" + lookup.source.key + ">: " + lookup.label,
    });
  }
  return out;
}

/** "/cust 1001" typed into the palette: the lookup and its argument, or null. */
function lookupQuery(query, lookups) {
  const text = String(query == null ? "" : query).trim();
  const space = text.indexOf(" ");
  if (space < 0) return null;
  const trigger = text.slice(0, space);
  const argument = text.slice(space + 1).trim();
  const lookup = (Array.isArray(lookups) ? lookups : []).find((l) => l.trigger === trigger);
  return lookup && argument && !/\s/.test(argument) ? { lookup, argument } : null;
}

function search(list, query, limit) {
  return palette.search(list, query, Number.isFinite(limit) ? limit : 8);
}

module.exports = { items, search, lookupQuery };
