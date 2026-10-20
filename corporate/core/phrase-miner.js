// Finds sentences, paragraphs and phrases a person keeps retyping in the
// applications they opted in to learning, and proposes them as shortcuts.
// A candidate must recur across distinct typing sessions (separate messages),
// so repeating a line within one message does not count.
"use strict";

const DEFAULTS = Object.freeze({
  minCount: 3,        // distinct sessions a text must appear in
  minWords: 4,
  maxPhraseWords: 12, // sliding window for phrases inside sentences
  minLength: 20,      // characters
  maxLength: 2000,
  limit: 20,
});

function normalize(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

function words(text) {
  return normalize(text).split(" ").filter(Boolean);
}

function splitParagraphs(text) {
  return String(text == null ? "" : text).split(/\n\s*\n/).map(normalize).filter(Boolean);
}

function splitSentences(paragraph) {
  const out = [];
  const source = normalize(paragraph);
  const pattern = /[^.!?]+(?:[.!?]+["'”’)]*|$)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const sentence = match[0].trim();
    if (sentence) out.push(sentence);
  }
  return out;
}

/** Suggest a trigger from the initials of the first words, avoiding `taken`. */
function suggestTrigger(text, taken) {
  const used = new Set((Array.isArray(taken) ? taken : []).map((t) => String(t)));
  const parts = words(text).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const initials = parts.map((w) => w[0]);
  let base = initials.slice(0, 4).join("") || "phrase";
  let candidate = base + "/";
  let extra = 4;
  while (used.has(candidate)) {
    if (extra < initials.length) {
      base += initials[extra++];
      candidate = base + "/";
    } else {
      let counter = 2;
      while (used.has(base + counter + "/")) counter++;
      candidate = base + counter + "/";
    }
  }
  return candidate;
}

function record(table, text, kind, sessionIndex) {
  let entry = table.get(text);
  if (!entry) {
    entry = { text, kind, occurrences: 0, sessions: new Set() };
    table.set(text, entry);
  }
  entry.occurrences++;
  entry.sessions.add(sessionIndex);
  // The longest kind wins the label when the same text is both a sentence and a paragraph.
  if (kind === "paragraph") entry.kind = "paragraph";
}

/**
 * Mine recurring text.
 * @param {Array<{text:string}|string>} sessions one entry per message or field session
 * @returns {Array<{text:string, kind:string, sessions:number, occurrences:number, words:number, suggestedTrigger:string}>}
 */
function mine(sessions, options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const existing = new Set((Array.isArray(settings.existing) ? settings.existing : []).map(normalize));
  const taken = Array.isArray(settings.takenTriggers) ? settings.takenTriggers.slice() : [];
  const table = new Map();
  (Array.isArray(sessions) ? sessions : []).forEach((session, index) => {
    const text = typeof session === "string" ? session : session && session.text;
    for (const paragraph of splitParagraphs(text)) {
      if (words(paragraph).length >= settings.minWords) record(table, paragraph, "paragraph", index);
      const sentences = splitSentences(paragraph);
      for (const sentence of sentences) {
        const sentenceWords = words(sentence);
        if (sentenceWords.length >= settings.minWords && sentences.length > 1) record(table, sentence, "sentence", index);
        const maxWindow = Math.min(settings.maxPhraseWords, sentenceWords.length - 1);
        for (let size = settings.minWords; size <= maxWindow; size++) {
          for (let start = 0; start + size <= sentenceWords.length; start++) {
            record(table, sentenceWords.slice(start, start + size).join(" "), "phrase", index);
          }
        }
      }
    }
  });

  let candidates = [...table.values()].filter((entry) => entry.sessions.size >= settings.minCount
    && entry.text.length >= settings.minLength && entry.text.length <= settings.maxLength);
  // Keep only maximal texts: a phrase that only ever occurs inside a longer
  // candidate seen in as many sessions adds nothing, and neither does one
  // that is already part of a saved shortcut.
  candidates = candidates.filter((entry) => !candidates.some((other) => other !== entry
    && other.text.length > entry.text.length && other.sessions.size >= entry.sessions.size
    && other.text.includes(entry.text)));
  candidates = candidates.filter((entry) => ![...existing].some((saved) => saved.includes(entry.text)));
  candidates.sort((a, b) => b.sessions.size - a.sessions.size || b.text.length - a.text.length || a.text.localeCompare(b.text));
  return candidates.slice(0, Math.max(0, settings.limit)).map((entry) => {
    const suggestedTrigger = suggestTrigger(entry.text, taken);
    taken.push(suggestedTrigger);
    return {
      text: entry.text,
      kind: entry.kind,
      sessions: entry.sessions.size,
      occurrences: entry.occurrences,
      words: words(entry.text).length,
      suggestedTrigger,
    };
  });
}

module.exports = { DEFAULTS, normalize, words, splitParagraphs, splitSentences, suggestTrigger, mine };
