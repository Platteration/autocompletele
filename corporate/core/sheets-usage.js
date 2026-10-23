// extle usage counts. The add-in counts each completion and block it writes,
// per day, and hands the counts to the desk as a text the person copies from
// the pane and pastes into the desk's extle tab: the add-in contacts no server
// other than its host's own and cannot reach the desk, so this text is the
// only way back. Pure and bundled with
// core/sheets.js (this module and what it requires use no Node builtin): the
// pane records and serializes, the desk parses.
//
// Counts only, as in core/report.js. A counter is a kind, a source, a name,
// a count and the keystrokes saved. The name is kept only for a vocabulary or
// a block trigger of the organisation's configuration (the browser copy), and
// only a short one; a use while a document's own configuration is in use is
// counted under source "document" with no name. Never cell text, typed text,
// sheet, file or document names.
"use strict";

const metrics = require("./metrics.js");

const FORMAT = "extle-usage";
const VERSION = 1;
const LIMITS = Object.freeze({
  days: 120,             // days kept, the newest; older ones are dropped
  namesPerDay: 12,       // named counters a day; a further name is counted without it
  nameLength: 40,        // characters of a name; a longer one is counted without it
  count: 100000,         // uses one counter holds for a day; a use past it is not counted
  keystrokes: 100000000, // keystrokes saved one counter holds for a day; it stops there
  characters: 300000,    // the longest text parseUsage reads; what serializeUsage writes stays below it (test/sheets-usage.test.js)
});
// The sources each kind is counted under, and those that carry a name.
const SOURCES = Object.freeze({ completion: Object.freeze(["vocabulary", "column", "notes", "document"]), block: Object.freeze(["formula", "rows", "document"]) });
const NAMED = Object.freeze({ completion: Object.freeze(["vocabulary"]), block: Object.freeze(["formula", "rows"]) });
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANCE = /^[0-9a-f]{32}$/;
// No control character and no surrogate: a kept name takes at most 3 UTF-8 bytes a character, escapes included.
const NAME_CHARS = /^[^\u0000-\u001f\u007f-\u009f\ud800-\udfff]+$/;

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/** "2026-10-23" -> that day at local midnight; null for anything that is not a real day. */
function dateOf(day) {
  const match = DAY.exec(String(day));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return metrics.dayKey(date) === day ? date : null;
}

/** The local day key of a Date (of any realm) or a time in milliseconds; a day key is kept as it is. Null for anything else. */
function dayOf(value) {
  if (typeof value === "string") return dateOf(value) ? value : null;
  const time = Object.prototype.toString.call(value) === "[object Date]" ? Date.prototype.getTime.call(value) : typeof value === "number" ? value : NaN;
  return Number.isNaN(time) ? null : metrics.dayKey(new Date(time));
}

function shiftDay(day, days) {
  const date = dateOf(day);
  date.setDate(date.getDate() + days);
  return metrics.dayKey(date);
}

/** Whether the add-in keeps this name with a count: text of 1 to 40 characters, no control character or surrogate. */
function keepsName(name) {
  return typeof name === "string" && name.length <= LIMITS.nameLength && NAME_CHARS.test(name);
}

function randomBytes(count) {
  const bytes = new Uint8Array(count);
  if (typeof crypto !== "undefined" && crypto && typeof crypto.getRandomValues === "function") return crypto.getRandomValues(bytes);
  // Without the Web Crypto API the id is only less random: it tells instances apart, it protects nothing.
  for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/**
 * An empty usage state with a new instance id: 32 hexadecimal characters
 * from crypto.getRandomValues where the host has it.
 * options: { random(count) -> bytes } in place of the host's random source.
 */
function createUsage(options) {
  const random = options && typeof options.random === "function" ? options.random : randomBytes;
  const bytes = random(16);
  let instance = "";
  for (let i = 0; i < 16; i++) instance += ((Number(bytes[i]) & 255) + 256).toString(16).slice(1);
  return { instance, days: {} };
}

/**
 * Drop the days before the LIMITS.days that end on `today`, then the oldest
 * past LIMITS.days. Days after `today` (a clock that went back, a time zone
 * crossed westwards) are kept.
 */
function prune(state, today) {
  const first = shiftDay(today, 1 - LIMITS.days);
  const kept = [];
  for (const key of Object.keys(state.days).sort()) {
    if (key < first) delete state.days[key];
    else kept.push(key);
  }
  for (const key of kept.slice(0, Math.max(0, kept.length - LIMITS.days))) delete state.days[key];
}

/**
 * Count one use on `day` (a day key, a Date or a time). event: { kind:
 * "completion" | "block", source (completion: vocabulary, column, notes;
 * block: formula, rows), name (the vocabulary's name or the block's
 * trigger), inserted (the text written), typed (the text in the pane's box
 * before), document (true while the document's own configuration is in use) }.
 * Keystrokes saved: graphemes inserted minus graphemes typed, never below 0.
 * A name the add-in does not keep (keepsName), or one past LIMITS.namesPerDay
 * on that day, is counted without it.
 * @returns {{kind:string, source:string, name:string, keystrokes:number, day:string}|null} what was counted;
 *   null for an event or day this cannot count, or a counter already at LIMITS.count
 */
function record(state, event, day) {
  const given = event && typeof event === "object" ? event : {};
  const key = dayOf(day);
  const kind = given.kind;
  if (!key || !own(SOURCES, kind) || !SOURCES[kind].includes(given.source)) return null;
  const source = given.document === true ? "document" : given.source;
  const counter = counterFor(state, key, kind, source, NAMED[kind].includes(source) && keepsName(given.name) ? given.name : "");
  if (counter[3] >= LIMITS.count) return null;
  const keystrokes = metrics.keystrokesSaved(given.inserted, given.typed);
  counter[3] += 1;
  counter[4] = Math.min(LIMITS.keystrokes, counter[4] + keystrokes);
  prune(state, key);
  return { kind, source, name: counter[2], keystrokes, day: key };
}

/** The day's counter for kind, source and name, made when missing; a new name past LIMITS.namesPerDay gets the unnamed counter. */
function counterFor(state, day, kind, source, name) {
  const list = own(state.days, day) ? state.days[day] : (state.days[day] = []);
  const same = (counter, n) => counter[0] === kind && counter[1] === source && counter[2] === n;
  const kept = name && (list.some((counter) => same(counter, name)) || list.filter((counter) => counter[2]).length < LIMITS.namesPerDay) ? name : "";
  let counter = list.find((c) => same(c, kept));
  if (!counter) list.push((counter = [kind, source, kept, 0, 0]));
  return counter;
}

/**
 * Add the counters of `delta` (uses counted since the last save) to `state`
 * (what is stored now, perhaps saved by another pane), under the limits
 * record keeps; days are then dropped as record drops them, from the newest
 * day of `delta`. `state` is changed and returned.
 */
function mergeUsage(state, delta) {
  const days = Object.keys(delta.days).sort();
  for (const day of days) {
    for (const [kind, source, name, count, keystrokes] of delta.days[day]) {
      const counter = counterFor(state, day, kind, source, name);
      counter[3] = Math.min(LIMITS.count, counter[3] + count);
      counter[4] = Math.min(LIMITS.keystrokes, counter[4] + keystrokes);
    }
  }
  if (days.length) prune(state, days[days.length - 1]);
  return state;
}

/** Uses and keystrokes saved over the `count` days that end on `today`. */
function totals(state, today, count) {
  const out = { uses: 0, keystrokes: 0 };
  const last = dayOf(today);
  if (!last) return out;
  const first = shiftDay(last, 1 - Math.max(1, Math.floor(Number(count) || 1)));
  for (const [key, list] of Object.entries(state.days)) {
    if (key < first || key > last) continue;
    for (const counter of list) {
      out.uses += counter[3];
      out.keystrokes += counter[4];
    }
  }
  return out;
}

/** The usage text: JSON with the format marker, the version, the instance id and the days, oldest first. */
function serializeUsage(state) {
  const days = {};
  for (const key of Object.keys(state.days).sort()) if (state.days[key].length) days[key] = state.days[key].map((counter) => counter.slice());
  return JSON.stringify({ format: FORMAT, version: VERSION, instance: state.instance, days });
}

/** A value from pasted text, quoted and cut short for a message. */
function shown(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    text = "";
  }
  text = String(text);
  return text.length > 40 ? text.slice(0, 39) + "…" : text;
}

function counterProblem(counter) {
  if (!Array.isArray(counter) || counter.length !== 5) return "a counter is not [kind, source, name, count, keystrokes]";
  const [kind, source, name, count, keystrokes] = counter;
  if (typeof kind !== "string" || !own(SOURCES, kind)) return "unknown kind " + shown(kind);
  if (!SOURCES[kind].includes(source)) return "unknown source " + shown(source) + " for " + kind;
  if (typeof name !== "string") return "a name is not text";
  if (name && (!NAMED[kind].includes(source) || !keepsName(name))) return "the name " + shown(name) + " is not one the add-in keeps for " + kind + " " + source;
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.count) return "a count is not a whole number from 1 to " + LIMITS.count;
  if (!Number.isInteger(keystrokes) || keystrokes < 0 || keystrokes > LIMITS.keystrokes) return "a keystroke count is not a whole number from 0 to " + LIMITS.keystrokes;
  return null;
}

/**
 * Read a usage text: the add-in's own stored copy, or what a person pasted
 * into the desk. Anything malformed or past a limit is refused with the
 * reason; nothing is skipped and nothing throws.
 * @returns {{ok:true, usage:{instance:string, days:object}}|{ok:false, error:string}}
 */
function parseUsage(text) {
  const fail = (error) => ({ ok: false, error });
  if (typeof text !== "string" || !text.trim()) return fail("there is no text; copy it from the Usage section of the extle add-in");
  if (text.length > LIMITS.characters) return fail("it is longer than " + LIMITS.characters + " characters, more than the extle add-in writes");
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return fail("it is not valid JSON (" + error.message + ")");
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data.format !== FORMAT) return fail("it is not a usage text from the extle add-in (format " + FORMAT + ")");
  if (data.version !== VERSION) return fail("it is version " + shown(data.version) + " of the usage text; this version reads " + VERSION);
  if (typeof data.instance !== "string" || !INSTANCE.test(data.instance)) return fail("its instance id is not 32 hexadecimal characters");
  if (!data.days || typeof data.days !== "object" || Array.isArray(data.days)) return fail("its days are not an object");
  const keys = Object.keys(data.days);
  if (keys.length > LIMITS.days) return fail("it holds " + keys.length + " days, more than the " + LIMITS.days + " the add-in keeps");
  const days = {};
  for (const key of keys) {
    if (!dateOf(key)) return fail("day " + shown(key) + " is not a date (YYYY-MM-DD)");
    const list = data.days[key];
    if (!Array.isArray(list)) return fail("day " + key + " is not a list of counters");
    const seen = new Set();
    let named = 0;
    const out = [];
    for (const counter of list) {
      const problem = counterProblem(counter);
      if (problem) return fail("day " + key + ": " + problem);
      const id = JSON.stringify(counter.slice(0, 3));
      if (seen.has(id)) return fail("day " + key + ": " + shown(counter.slice(0, 3)) + " is counted twice");
      seen.add(id);
      if (counter[2] && ++named > LIMITS.namesPerDay) return fail("day " + key + ": more than " + LIMITS.namesPerDay + " names");
      out.push(counter.slice());
    }
    days[key] = out;
  }
  return { ok: true, usage: { instance: data.instance, days } };
}

module.exports = { FORMAT, VERSION, LIMITS, SOURCES, NAMED, createUsage, record, mergeUsage, totals, serializeUsage, parseUsage, keepsName, dayOf, dateOf };
