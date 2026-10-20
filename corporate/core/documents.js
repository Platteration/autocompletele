// Document shortcuts: typing /sld in an email lists the files an organisation
// marked as the standard hand-outs for "shipping logistics department", so
// they can be attached in one step. The catalogue is plain data; opening or
// attaching a file is the desktop shell's job.
"use strict";

const { expander } = require("./personal.js");

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeDocument(raw, warnings, where) {
  const source = raw && typeof raw === "object" ? raw : { path: raw };
  const path = asText(source.path || source.url);
  if (!path) {
    warnings.push("document in " + where + " ignored: no path");
    return null;
  }
  const fileName = path.replace(/\\/g, "/").split("/").pop();
  return {
    title: asText(source.title) || fileName,
    path,
    tags: (Array.isArray(source.tags) ? source.tags : []).map(asText).filter(Boolean),
    description: asText(source.description),
  };
}

/** Validate a catalogue {shortcuts:[{trigger,label,documents:[...]}]}. */
function normalizeCatalog(catalog) {
  const warnings = [];
  const source = catalog && typeof catalog === "object" ? catalog : {};
  const list = Array.isArray(source.shortcuts) ? source.shortcuts : Array.isArray(source) ? source : [];
  const seen = new Set();
  const shortcuts = [];
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      warnings.push("document shortcut " + index + " ignored: not an object");
      return;
    }
    const trigger = asText(raw.trigger);
    if (!trigger) {
      warnings.push("document shortcut " + index + " ignored: no trigger");
      return;
    }
    if (seen.has(trigger)) {
      warnings.push("document shortcut " + trigger + " ignored: duplicate trigger");
      return;
    }
    const documents = (Array.isArray(raw.documents) ? raw.documents : [])
      .map((doc) => normalizeDocument(doc, warnings, trigger)).filter(Boolean);
    if (!documents.length) {
      warnings.push("document shortcut " + trigger + " ignored: no documents");
      return;
    }
    seen.add(trigger);
    shortcuts.push({ trigger, label: asText(raw.label) || trigger, documents });
  });
  return { shortcuts, warnings };
}

/**
 * Find a document shortcut whose trigger ends at the caret, under the same
 * boundary rule as text shortcuts.
 * @returns {{shortcut:object, start:number}|null}
 */
function findShortcut(textBeforeCaret, catalog) {
  const list = catalog && Array.isArray(catalog.shortcuts) ? catalog.shortcuts : [];
  const match = expander.findMatch(textBeforeCaret, list.map((s) => ({ trigger: s.trigger, expansion: "" })));
  if (!match) return null;
  const shortcut = list.find((s) => s.trigger === match.shorthand.trigger);
  return shortcut ? { shortcut, start: match.start } : null;
}

function score(query, shortcut, doc) {
  const q = query.toLowerCase();
  const fields = [doc.title, doc.path, doc.description, shortcut.label, shortcut.trigger, ...doc.tags].map((f) => String(f).toLowerCase());
  let best = 0;
  for (const field of fields) {
    if (field === q) best = Math.max(best, 3);
    else if (field.startsWith(q)) best = Math.max(best, 2);
    else if (field.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

/** Rank documents across every shortcut for a free-text query. */
function search(query, catalog, limit) {
  const q = asText(query);
  const list = catalog && Array.isArray(catalog.shortcuts) ? catalog.shortcuts : [];
  const out = [];
  for (const shortcut of list) {
    for (const doc of shortcut.documents) {
      const s = q ? score(q, shortcut, doc) : 1;
      if (s > 0) out.push({ score: s, shortcut, document: doc });
    }
  }
  out.sort((a, b) => b.score - a.score || a.document.title.localeCompare(b.document.title));
  return out.slice(0, Math.max(1, Math.floor(Number(limit) || 10)));
}

module.exports = { normalizeCatalog, findShortcut, search };
