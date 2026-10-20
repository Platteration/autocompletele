// Organisation-level phrase discovery. A person picks learning proposals to
// suggest to their organisation and exports them; an administrator ranks the
// suggestions across desks and promotes the good ones to the shared library.
//
// Only what the person chose leaves the desk, after a preview. A template
// suggestion carries the template with its blanks, never the values seen in
// the blanks (customer names, order numbers).
"use strict";

const { normalize, suggestTrigger } = require("./phrase-miner.js");

const FORMAT = "actle-phrase-suggestions";
const VERSION = 1;
const KINDS = Object.freeze(["template", "paragraph", "sentence", "phrase"]);

function asText(value) {
  return String(value == null ? "" : value);
}

/** One queued suggestion, normalised; null when unusable. */
function normalizeSuggestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = asText(raw.text).trim();
  if (!text) return null;
  return {
    kind: KINDS.includes(raw.kind) ? raw.kind : "phrase",
    text,
    trigger: asText(raw.trigger).trim(),
    sessions: Math.max(0, Math.floor(Number(raw.sessions) || 0)),
  };
}

/** Add to a queue, replacing an entry with the same text. */
function enqueue(queue, raw) {
  const item = normalizeSuggestion(raw);
  const list = (Array.isArray(queue) ? queue : []).map(normalizeSuggestion).filter(Boolean);
  if (!item) return list;
  const key = normalize(item.text);
  return list.filter((existing) => normalize(existing.text) !== key).concat([item]);
}

function buildExport(queue, options) {
  const settings = options || {};
  return {
    format: FORMAT,
    version: VERSION,
    generatedAt: Number(settings.now) || Date.now(),
    installId: asText(settings.installId),
    team: asText(settings.team),
    suggestions: (Array.isArray(queue) ? queue : []).map(normalizeSuggestion).filter(Boolean),
  };
}

function isExport(value) {
  return !!value && typeof value === "object" && value.format === FORMAT && value.version === VERSION && Array.isArray(value.suggestions);
}

/**
 * Rank suggestions from several desks. A desk counts once per text (its
 * newest file wins); texts already in the library are left out.
 * @param {Array} files parsed export files
 * @param {object} options { library: [{trigger, expansion}], minDesks }
 */
function rank(files, options) {
  const settings = options || {};
  const warnings = [];
  const latest = new Map();
  let anonymous = 0;
  (Array.isArray(files) ? files : []).forEach((file, index) => {
    if (!isExport(file)) {
      warnings.push("file " + (index + 1) + " skipped: not an actle suggestions file");
      return;
    }
    const id = file.installId || "anonymous-" + anonymous++;
    const previous = latest.get(id);
    if (previous && previous.generatedAt >= file.generatedAt) return;
    latest.set(id, file);
  });
  const library = Array.isArray(settings.library) ? settings.library : [];
  const known = new Set(library.map((sh) => normalize(sh.expansion)));
  const taken = library.map((sh) => sh.trigger);
  const byText = new Map();
  for (const file of latest.values()) {
    for (const raw of file.suggestions) {
      const item = normalizeSuggestion(raw);
      if (!item) continue;
      const key = normalize(item.text);
      if (known.has(key)) continue;
      const row = byText.get(key) || { text: item.text, kind: item.kind, desks: 0, sessions: 0, triggers: [], teams: [] };
      row.desks += 1;
      row.sessions += item.sessions;
      if (item.trigger && !row.triggers.includes(item.trigger)) row.triggers.push(item.trigger);
      if (file.team && !row.teams.includes(file.team)) row.teams.push(file.team);
      byText.set(key, row);
    }
  }
  const minDesks = Math.max(1, Math.floor(Number(settings.minDesks) || 1));
  const ranked = [...byText.values()].filter((row) => row.desks >= minDesks)
    .sort((a, b) => b.desks - a.desks || b.sessions - a.sessions || a.text.localeCompare(b.text));
  for (const row of ranked) {
    // The trigger most desks chose, unless the library already uses it.
    const preferred = row.triggers.find((t) => !taken.includes(t));
    row.suggestedTrigger = preferred || suggestTrigger(row.text, taken);
    taken.push(row.suggestedTrigger);
  }
  return { desks: latest.size, suggestions: ranked, warnings };
}

/** A library file in the shared shorthands.json format, for review before merging into a policy. */
function toLibrary(ranked) {
  return { version: 1, shorthands: (Array.isArray(ranked) ? ranked : []).map((row) => ({ trigger: row.suggestedTrigger, expansion: row.text })) };
}

module.exports = { FORMAT, VERSION, normalizeSuggestion, enqueue, buildExport, isExport, rank, toLibrary };
