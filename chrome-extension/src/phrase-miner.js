// Phrases the person keeps typing in their writing-pad drafts, offered as new
// shortcuts ("as you can see" -> aycs/). Pure: no DOM, storage or network, and
// only the texts the caller passes in are read.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ShorthandPhraseMiner = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MIN_COUNT = 3;
  const MIN_WORDS = 2;
  const MAX_WORDS = 8;
  const MIN_CHARS = 12;
  const DEFAULT_LIMIT = 5;

  // A phrase made only of these is never suggested ("it is", "you can do it").
  const FUNCTION_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "is", "are", "was",
    "were", "be", "it", "i", "you", "we", "they", "he", "she", "that", "this", "with", "as", "so",
    "if", "my", "your", "our", "me", "us", "can", "will", "have", "has", "do",
  ]);
  // A phrase that stops on one of these and runs on into more words is a
  // fragment of a longer thought ("as you can see the", "one of the", "thank
  // you for"). Such a phrase does not qualify, so it cannot hide the complete
  // phrase inside it either. It still qualifies where it ends a sentence or
  // clause at least 3 times ("that is what we are looking for.").
  const WEAK_ENDINGS = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "for", "with", "at", "as", "if", "so",
    "my", "your", "our", "is", "are", "was", "were", "be", "i", "we", "they", "he", "she",
  ]);
  // "and as you can see" is "as you can see" joined onto the previous clause.
  const WEAK_STARTS = new Set(["and", "or", "but", "so"]);

  // Letters (with their combining marks), digits, and apostrophes inside a word.
  const WORD = /[\p{L}\p{M}\p{N}]+(?:['\u2019][\p{L}\p{M}\p{N}]+)*/gu;
  // Words stay in one phrase only across spaces on the same line, or a single
  // hyphen inside a compound ("follow-up"). Any other character between two
  // words (. ! ? , ; : quotes, brackets, dashes, line breaks) ends the phrase.
  const SPACE_JOINER = /^[^\S\n\r\v\f\u2028\u2029]+$/u;
  const HYPHEN_JOINER = /^[-\u2010\u2011]$/u;

  function asText(value) {
    return typeof value === "string" ? value.normalize("NFC") : "";
  }

  function wordKey(word) {
    return word.toLowerCase().replace(/\u2019/g, "'");
  }

  function separatorKey(separator) {
    return HYPHEN_JOINER.test(separator) ? "-" : separator.replace(/\s+/gu, " ");
  }

  /** Split text into runs of words that may form one phrase. */
  function segmentsOf(text) {
    const segments = [];
    let current = null;
    let previousEnd = -1;
    WORD.lastIndex = 0;
    for (let match; (match = WORD.exec(text)) !== null;) {
      const start = match.index;
      const end = start + match[0].length;
      const separator = previousEnd < 0 ? "" : text.slice(previousEnd, start);
      const joined = current !== null && (SPACE_JOINER.test(separator) || HYPHEN_JOINER.test(separator));
      if (!joined) {
        current = { text, words: [], keys: [], joins: [] };
        segments.push(current);
      }
      current.words.push({ start, end });
      current.keys.push(wordKey(match[0]));
      current.joins.push(joined ? separatorKey(separator) : "");
      previousEnd = end;
    }
    return segments;
  }

  /**
   * The form phrases are compared and dismissed in: Unicode NFC, lower case,
   * curly apostrophes made straight, whitespace collapsed to one space, and
   * anything before the first word or after the last word dropped.
   * normalizePhrase("  As YOU can see: ") === "as you can see".
   */
  function normalizePhrase(text) {
    const source = asText(text);
    let out = "";
    let previousEnd = -1;
    WORD.lastIndex = 0;
    for (let match; (match = WORD.exec(source)) !== null;) {
      if (previousEnd >= 0) out += separatorKey(source.slice(previousEnd, match.index));
      out += wordKey(match[0]);
      previousEnd = match.index + match[0].length;
    }
    return out;
  }

  function phraseKey(segment, first, count) {
    let key = segment.keys[first];
    for (let i = first + 1; i < first + count; i++) key += segment.joins[i] + segment.keys[i];
    return key;
  }

  /** `taken` are the counted occurrences; the words are read from the first one. */
  function qualifies(segments, taken, key) {
    const { segment: s, first, count } = taken[0];
    const segment = segments[s];
    if (count < 3 && [...key].length < MIN_CHARS) return false;
    let content = false;
    for (let i = first; i < first + count; i++) {
      if (!FUNCTION_WORDS.has(segment.keys[i])) content = true;
    }
    if (!content) return false;
    if (WEAK_STARTS.has(segment.keys[first])) return false;
    if (!WEAK_ENDINGS.has(segment.keys[first + count - 1])) return true;
    // "what we are looking for." is whole where it ends a sentence or clause.
    const complete = taken.filter((place) => place.first + count === segments[place.segment].keys.length);
    return complete.length >= MIN_COUNT;
  }

  function existingTriggers(shorthands) {
    const triggers = [];
    if (!Array.isArray(shorthands)) return triggers;
    for (const item of shorthands) {
      const trigger = item && typeof item === "object" ? item.trigger : item;
      if (typeof trigger === "string" && trigger) triggers.push(trigger);
    }
    return triggers;
  }

  /**
   * `stem + "/"`, or `stem + "2/"`, `stem + "3/"` ... when that trigger is taken.
   * Taken means an existing trigger is the same, or starts with the proposal
   * (the new one would fire first and make the old one impossible to type), or
   * is a prefix of the proposal that a number can still get past. A trigger
   * that is a prefix of the stem itself (an existing "ay" against "aycs/")
   * cannot be avoided by numbering, so it is left for the library's conflict
   * warning.
   *
   * @param {string} stem
   * @param {Array<{trigger: string}|string>} shorthands existing shortcuts or triggers
   */
  function uniqueTrigger(stem, shorthands) {
    const base = String(stem == null ? "" : stem);
    const triggers = existingTriggers(shorthands);
    const taken = (candidate) => triggers.some((trigger) => trigger === candidate
      || trigger.startsWith(candidate)
      || (candidate.startsWith(trigger) && !base.startsWith(trigger)));
    let candidate = base + "/";
    for (let n = 2; taken(candidate); n++) candidate = base + n + "/";
    return candidate;
  }

  function initials(segment, first, count) {
    let stem = "";
    for (let i = first; i < first + count; i++) {
      const word = segment.text.slice(segment.words[i].start, segment.words[i].end);
      stem += String.fromCodePoint(word.codePointAt(0)).toLowerCase();
    }
    return stem;
  }

  function overlaps(a, b) {
    return a.segment === b.segment && a.first < b.first + b.count && b.first < a.first + a.count;
  }

  /**
   * Find phrases worth offering as shortcuts.
   *
   * A phrase is 2 to 8 consecutive words in one segment (see segmentsOf), seen
   * at least 3 times without overlapping itself across all the texts. It needs
   * 3+ words or 12+ characters, and at least one word outside FUNCTION_WORDS.
   * It must not start with a word in WEAK_STARTS, nor end with one in
   * WEAK_ENDINGS unless it ends a sentence or clause 3+ times. Of a phrase and a
   * longer qualifying phrase containing it, the shorter is dropped when the
   * longer is seen as often; of two phrases seen equally often where every
   * occurrence of one overlaps the other, only the higher ranked is offered.
   * Texts that differ only in spacing count once.
   *
   * @param {string[]} texts
   * @param {{limit?: number, dismissed?: string[], shorthands?: Array<{trigger: string, expansion: string}>}} [options]
   * @returns {Array<{phrase: string, display: string, count: number, words: number, trigger: string}>}
   *   phrase is normalizePhrase form (store it to dismiss); display is the
   *   spelling to save as the expansion.
   */
  function findRepeatedPhrases(texts, options) {
    const opts = options && typeof options === "object" ? options : {};
    const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : DEFAULT_LIMIT;
    if (!Array.isArray(texts) || limit === 0) return [];

    // A conflict copy or a restored draft is the same writing, not a repeat,
    // even if its spacing differs.
    const seenTexts = new Set();
    const unique = texts.map(asText).filter((text) => {
      const key = text.replace(/\s+/gu, " ").trim();
      if (!key || seenTexts.has(key)) return false;
      seenTexts.add(key);
      return true;
    });
    const segments = unique.flatMap(segmentsOf);

    // Count phrases one length at a time, only extending phrases that were
    // seen often enough: a longer phrase can never be seen more often.
    const candidates = new Map();
    let frontier = new Map();
    segments.forEach((segment, s) => {
      for (let i = 0; i + MIN_WORDS <= segment.keys.length; i++) {
        const key = phraseKey(segment, i, MIN_WORDS);
        if (!frontier.has(key)) frontier.set(key, []);
        frontier.get(key).push({ segment: s, first: i });
      }
    });
    for (let count = MIN_WORDS; count <= MAX_WORDS && frontier.size > 0; count++) {
      const next = new Map();
      for (const [key, places] of frontier) {
        if (places.length < MIN_COUNT) continue;
        candidates.set(key, { key, count, places });
        if (count === MAX_WORDS) continue;
        for (const place of places) {
          const segment = segments[place.segment];
          if (place.first + count >= segment.keys.length) continue;
          const longer = key + segment.joins[place.first + count] + segment.keys[place.first + count];
          if (!next.has(longer)) next.set(longer, []);
          next.get(longer).push(place);
        }
      }
      frontier = next;
    }

    const qualified = [];
    for (const candidate of candidates.values()) {
      // Places are in reading order, so taking each one that starts after the
      // last taken one ends gives the most non-overlapping occurrences.
      const taken = [];
      for (const place of candidate.places) {
        const last = taken[taken.length - 1];
        if (!last || last.segment !== place.segment || place.first >= last.first + candidate.count) {
          taken.push({ segment: place.segment, first: place.first, count: candidate.count });
        }
      }
      if (taken.length < MIN_COUNT || !qualifies(segments, taken, candidate.key)) continue;
      qualified.push({ key: candidate.key, words: candidate.count, seen: taken.length, taken, first: taken[0] });
    }
    const byKey = new Map(qualified.map((phrase) => [phrase.key, phrase]));

    // Keep only maximal phrases.
    const dominated = new Set();
    for (const phrase of qualified) {
      const segment = segments[phrase.first.segment];
      for (let length = MIN_WORDS; length < phrase.words; length++) {
        for (let offset = 0; offset + length <= phrase.words; offset++) {
          const inner = byKey.get(phraseKey(segment, phrase.first.first + offset, length));
          if (inner && phrase.seen >= inner.seen) dominated.add(inner.key);
        }
      }
    }

    // The first seen breaks ties: two phrases of the same length never start
    // at the same word.
    const ranked = qualified.filter((phrase) => !dominated.has(phrase.key)).sort((a, b) =>
      b.seen * b.words - a.seen * a.words || b.words - a.words
      || a.first.segment - b.first.segment || a.first.first - b.first.first);

    const excluded = new Set();
    if (Array.isArray(opts.dismissed)) {
      for (const text of opts.dismissed) excluded.add(normalizePhrase(text));
    }
    if (Array.isArray(opts.shorthands)) {
      for (const item of opts.shorthands) {
        if (item && typeof item === "object") excluded.add(normalizePhrase(item.expansion));
      }
    }
    excluded.delete("");

    const triggers = existingTriggers(opts.shorthands);
    const results = [];
    const shown = [];
    for (const phrase of ranked) {
      // A phrase longer than 8 words shows up as several 8-word windows seen
      // equally often; offer only the best of them. Dismissed and existing
      // phrases still count here, so dismissing one window hides the rest.
      if (shown.some((other) => other.seen === phrase.seen
        && phrase.taken.every((place) => other.taken.some((kept) => overlaps(place, kept))))) continue;
      shown.push(phrase);
      if (excluded.has(phrase.key)) continue;

      const spellings = new Map();
      for (const place of phrase.taken) {
        const segment = segments[place.segment];
        const spelling = segment.text
          .slice(segment.words[place.first].start, segment.words[place.first + phrase.words - 1].end)
          .replace(/\s+/gu, " ");
        spellings.set(spelling, (spellings.get(spelling) || 0) + 1);
      }
      let display = "";
      let best = 0;
      for (const [spelling, seen] of spellings) {
        if (seen > best) {
          display = spelling;
          best = seen;
        }
      }

      const trigger = uniqueTrigger(initials(segments[phrase.first.segment], phrase.first.first, phrase.words), triggers);
      triggers.push(trigger);
      results.push({ phrase: phrase.key, display, count: phrase.seen, words: phrase.words, trigger });
      if (results.length >= limit) break;
    }
    return results;
  }

  return { findRepeatedPhrases, normalizePhrase, uniqueTrigger };
});
