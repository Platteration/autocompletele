// Keystroke and time-saved accounting. Pure: entries come in, summaries come
// out. Persistence lives in store.js so this module can run in any shell.
"use strict";

const DEFAULT_CHARS_PER_MINUTE = 200; // 40 words per minute at five characters a word
const KINDS = Object.freeze(["expansion", "suggestion", "template", "learned", "keyword", "document", "palette", "lookup", "warning"]);
// Kinds that are shown, not inserted: counted per kind, never as an insert.
const SHOWN_KINDS = Object.freeze(["warning"]);
const PERIODS = Object.freeze(["all", "day", "week", "month"]);
const SOURCES = Object.freeze(["personal", "organization"]);

const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** Count what a person would have had to type: graphemes, not UTF-16 units. */
function graphemes(text) {
  const source = String(text == null ? "" : text);
  if (!source) return 0;
  if (!segmenter) return Array.from(source).length;
  let count = 0;
  for (const part of segmenter.segment(source)) {
    if (part) count++;
  }
  return count;
}

/** Keystrokes saved by inserting `inserted` after typing only `typed`. */
function keystrokesSaved(inserted, typed) {
  return Math.max(0, graphemes(inserted) - graphemes(typed));
}

function charsPerMinute(options) {
  const value = options && Number(options.charsPerMinute);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHARS_PER_MINUTE;
}

/** Estimated seconds a person would have spent typing that many keystrokes. */
function secondsSaved(keystrokes, options) {
  const count = Number(keystrokes);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return count * 60 / charsPerMinute(options);
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Weeks start on Monday, in local time. */
function startOfWeek(date) {
  const day = startOfDay(date);
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function isoWeek(date) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(utc.getUTCFullYear(), 0, 1);
  return { year: utc.getUTCFullYear(), week: Math.ceil(((utc - yearStart) / 86400000 + 1) / 7) };
}

function dayKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

function weekKey(date) {
  const { year, week } = isoWeek(date);
  return year + "-W" + pad(week);
}

function monthKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1);
}

const BUCKETS = Object.freeze({
  day: { start: startOfDay, step: (d, n) => addDays(d, n), key: dayKey },
  week: { start: startOfWeek, step: (d, n) => addDays(d, 7 * n), key: weekKey },
  month: { start: startOfMonth, step: (d, n) => addMonths(d, n), key: monthKey },
});

function asTime(value, fallback) {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalise one raw entry (for example a line read back from disk). */
function normalizeEntry(raw, nowMs) {
  if (!raw || typeof raw !== "object") return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : "expansion";
  const at = asTime(raw.at, nowMs);
  const saved = Math.max(0, Math.floor(Number(raw.keystrokesSaved) || 0));
  const fixed = Math.max(0, Number(raw.fixedSeconds) || 0);
  return {
    at,
    kind,
    app: String(raw.app == null ? "" : raw.app),
    trigger: String(raw.trigger == null ? "" : raw.trigger),
    // Whether the shortcut came from the organisation policy or the person's
    // own library; usage reports name only organisation shortcuts.
    source: SOURCES.includes(raw.source) ? raw.source : "",
    keystrokesSaved: saved,
    fixedSeconds: fixed,
  };
}

function emptyTotals() {
  return { expansions: 0, keystrokesSaved: 0, fixedSeconds: 0, secondsSaved: 0, byKind: {} };
}

function addTo(totals, entry, options) {
  totals.byKind[entry.kind] = (totals.byKind[entry.kind] || 0) + 1;
  if (SHOWN_KINDS.includes(entry.kind)) return;
  totals.expansions += 1;
  totals.keystrokesSaved += entry.keystrokesSaved;
  totals.fixedSeconds += entry.fixedSeconds;
  totals.secondsSaved = secondsSaved(totals.keystrokesSaved, options) + totals.fixedSeconds;
}

/**
 * Create a ledger. `options.charsPerMinute` is the typing-speed assumption
 * used to turn keystrokes into time; changing it re-estimates history, so it
 * is applied when summarising rather than stored on each entry.
 */
function createLedger(options) {
  const settings = Object.assign({ charsPerMinute: DEFAULT_CHARS_PER_MINUTE, now: () => Date.now() }, options || {});
  // An absent or invalid speed (for example `undefined` from a caller's own
  // options) must not replace the default.
  settings.charsPerMinute = charsPerMinute(settings);
  const entries = [];
  const listeners = [];

  function record(event) {
    const data = event && typeof event === "object" ? event : {};
    const nowMs = asTime(settings.now(), Date.now());
    const saved = data.keystrokesSaved != null
      ? data.keystrokesSaved
      : keystrokesSaved(data.inserted, data.typed);
    const entry = normalizeEntry({
      at: data.at == null ? nowMs : data.at,
      kind: data.kind,
      app: data.app,
      trigger: data.trigger,
      source: data.source,
      keystrokesSaved: saved,
      fixedSeconds: data.fixedSeconds,
    }, nowMs);
    entries.push(entry);
    for (const listener of listeners) listener(entry);
    return entry;
  }

  function load(list) {
    const nowMs = asTime(settings.now(), Date.now());
    let accepted = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const entry = normalizeEntry(raw, nowMs);
      if (entry) {
        entries.push(entry);
        accepted++;
      }
    }
    entries.sort((a, b) => a.at - b.at);
    return accepted;
  }

  function onRecord(listener) {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  function between(fromMs, toMs) {
    const totals = emptyTotals();
    for (const entry of entries) {
      if (entry.at >= fromMs && entry.at < toMs) addTo(totals, entry, settings);
    }
    return totals;
  }

  /** Totals for the current day, week or month, or for everything. */
  function summary(query) {
    const period = query && PERIODS.includes(query.period) ? query.period : "all";
    const now = new Date(asTime(query && query.now, asTime(settings.now(), Date.now())));
    if (period === "all") {
      const totals = between(-Infinity, Infinity);
      return Object.assign({ period, from: null, to: null }, totals);
    }
    const bucket = BUCKETS[period];
    const from = bucket.start(now);
    const to = bucket.step(from, 1);
    return Object.assign({ period, key: bucket.key(from), from: from.getTime(), to: to.getTime() }, between(from.getTime(), to.getTime()));
  }

  /** Totals for an arbitrary range [from, to). */
  function range(fromMs, toMs) {
    return Object.assign({ from: asTime(fromMs, -Infinity), to: asTime(toMs, Infinity) }, between(asTime(fromMs, -Infinity), asTime(toMs, Infinity)));
  }

  /** The last `count` day/week/month buckets ending with the current one, oldest first. */
  function series(query) {
    const period = query && BUCKETS[query.period] ? query.period : "day";
    const count = Math.max(1, Math.min(366, Math.floor(Number(query && query.count) || 7)));
    const bucket = BUCKETS[period];
    const now = new Date(asTime(query && query.now, asTime(settings.now(), Date.now())));
    const current = bucket.start(now);
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const from = bucket.step(current, -i);
      const to = bucket.step(from, 1);
      out.push(Object.assign({ key: bucket.key(from), from: from.getTime(), to: to.getTime() }, between(from.getTime(), to.getTime())));
    }
    return out;
  }

  /** Totals per application, most keystrokes saved first. */
  function byApp(query) {
    const fromMs = asTime(query && query.from, -Infinity);
    const toMs = asTime(query && query.to, Infinity);
    const apps = new Map();
    for (const entry of entries) {
      if (entry.at < fromMs || entry.at >= toMs) continue;
      const name = entry.app || "(unknown)";
      if (!apps.has(name)) apps.set(name, Object.assign({ app: name }, emptyTotals()));
      addTo(apps.get(name), entry, settings);
    }
    return [...apps.values()].sort((a, b) => b.keystrokesSaved - a.keystrokesSaved || a.app.localeCompare(b.app));
  }

  /** Drop entries older than `keepDays`; returns how many were removed. */
  function prune(keepDays) {
    const days = Number(keepDays);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = asTime(settings.now(), Date.now()) - days * 86400000;
    const before = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].at < cutoff) entries.splice(i, 1);
    }
    return before - entries.length;
  }

  function setCharsPerMinute(value) {
    settings.charsPerMinute = charsPerMinute({ charsPerMinute: value });
    return settings.charsPerMinute;
  }

  return {
    record,
    load,
    onRecord,
    summary,
    range,
    series,
    byApp,
    prune,
    setCharsPerMinute,
    get charsPerMinute() { return settings.charsPerMinute; },
    entries: () => entries.slice(),
    size: () => entries.length,
  };
}

module.exports = {
  DEFAULT_CHARS_PER_MINUTE,
  KINDS,
  SHOWN_KINDS,
  PERIODS,
  SOURCES,
  graphemes,
  keystrokesSaved,
  secondsSaved,
  dayKey,
  weekKey,
  monthKey,
  startOfDay,
  startOfWeek,
  startOfMonth,
  normalizeEntry,
  createLedger,
};
