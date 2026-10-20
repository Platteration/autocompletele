// Turns the learning corpus (scrubbed text from applications in learn mode)
// into candidates a person can accept with one click: recurring phrases and
// paragraphs, and groups of near-identical messages that differ only in a few
// slots, proposed as one [[name]] template. Pure; no Electron here.
"use strict";

const { phraseMiner, variableDetector } = require("../core/index.js");

const DEFAULTS = Object.freeze({ clusterThreshold: 0.6, maxTemplates: 10 });

function templateCandidates(sessions, options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const minCount = Math.max(2, settings.minCount || 3);
  const minWords = settings.minWords || 4;
  const paragraphs = [];
  sessions.forEach((session, index) => {
    for (const paragraph of phraseMiner.splitParagraphs(session.text)) {
      if (phraseMiner.words(paragraph).length >= minWords) paragraphs.push({ text: paragraph, session: index });
    }
  });
  const groups = variableDetector.cluster(paragraphs.map((p) => p.text), { threshold: settings.clusterThreshold });
  const out = [];
  for (const members of groups) {
    const distinct = new Set(members.map((i) => paragraphs[i].session));
    if (distinct.size < minCount) continue;
    // One paragraph per session, so a message repeated in one draft does not count twice.
    const seen = new Set();
    const texts = [];
    for (const i of members) {
      if (seen.has(paragraphs[i].session)) continue;
      seen.add(paragraphs[i].session);
      texts.push(paragraphs[i].text);
    }
    const result = variableDetector.detect(texts);
    if (!result || !result.slots.length) continue;
    out.push({
      kind: "template",
      text: result.template,
      template: result.template,
      slots: result.slots,
      segments: result.segments,
      sessions: texts.length,
      similarity: result.similarity,
    });
  }
  out.sort((a, b) => b.sessions - a.sessions || a.template.localeCompare(b.template));
  return out.slice(0, settings.maxTemplates);
}

/**
 * Build the candidate list.
 * @param {{sessions:Array, library:Array, learning:object, dismissed:string[]}} input
 */
function candidates(input) {
  const sessions = (Array.isArray(input.sessions) ? input.sessions : []).filter((s) => s && typeof s.text === "string");
  const library = Array.isArray(input.library) ? input.library : [];
  const learning = Object.assign({ minCount: 3, minLength: 20, minWords: 4 }, input.learning || {});
  const dismissed = new Set((Array.isArray(input.dismissed) ? input.dismissed : []).map((t) => phraseMiner.normalize(t)));
  const existing = library.map((sh) => sh.expansion);
  const existingNormalized = existing.map(phraseMiner.normalize);
  const existingSet = new Set(existingNormalized);
  // Text that already lives inside a saved expansion (for example a signature
  // inserted through its own trigger) is not something to learn again.
  const insideExisting = (text) => existingNormalized.some((value) => value.includes(phraseMiner.normalize(text)));
  const taken = library.map((sh) => sh.trigger);

  const templates = templateCandidates(sessions, learning)
    .filter((c) => !dismissed.has(phraseMiner.normalize(c.template)) && !existingSet.has(phraseMiner.normalize(c.template)));
  for (const candidate of templates) {
    candidate.suggestedTrigger = phraseMiner.suggestTrigger(candidate.segments.filter((s) => s.type === "same").map((s) => s.text).join(" "), taken);
    taken.push(candidate.suggestedTrigger);
  }
  // A phrase that is just the fixed part of a template adds nothing.
  const covered = templates.map((c) => c.segments.filter((s) => s.type === "same").map((s) => phraseMiner.normalize(s.text)));
  const phrases = phraseMiner.mine(sessions, {
    existing,
    takenTriggers: taken,
    minCount: learning.minCount,
    minLength: learning.minLength,
    minWords: learning.minWords,
  }).filter((c) => !dismissed.has(phraseMiner.normalize(c.text)))
    .filter((c) => !covered.some((parts) => parts.some((part) => part.includes(c.text))))
    .filter((c) => !insideExisting(c.text))
    .map((c) => Object.assign({ kind: c.kind }, c));

  return templates.concat(phrases);
}

module.exports = { DEFAULTS, templateCandidates, candidates };
