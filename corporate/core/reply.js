// actle Reply: reads the message a person is answering and
// offers the prewritten replies from the organisation library that fit, with
// their [[blanks]] filled from that message (sender name, order and ticket
// references, the first date, an amount). Local rules only: keywords pick the
// replies, fixed and policy-defined patterns find the values. Pure: reading
// the selection or clipboard and inserting the text are the shell's job.
"use strict";

const { expander, template } = require("./personal.js");
const { keywordPattern, MATCH } = require("./keyword-rules.js");
const { findDate, DATE_ORDERS } = require("./filer.js");
const policyPattern = require("./policy-pattern.js");

const DEFAULTS = Object.freeze({ max: 3, maxChars: 20000 });
const MAX_LIMIT = 10;
const BUILTIN_VALUES = Object.freeze(["name", "firstName", "greeted", "order", "reference", "date", "amount"]);
const STAT_EVENTS = Object.freeze({ offered: "offered", inserted: "inserted", edited: "editedBeforeSend" });
const NAME = /^\p{Lu}[\p{L}'’.-]*(?:\s+\p{Lu}[\p{L}'’.-]*){0,3}$/u;
const GREETING = /^(dear|hi|hello|hey|good\s+(?:morning|afternoon|evening))\s+([^,!:]+?)\s*(?:[,!:]|$)/i;
const SIGN_OFF = /^((?:best|kind|warm|many|with)?\s*(?:regards|wishes|thanks)|best|thanks|thank you|cheers|sincerely|yours sincerely|yours truly|all the best|mit freundlichen grüßen|viele grüße)\s*[,.!]?\s*(.*)$/i;
const QUOTE_START = /^(?:-{2,}\s*original message\s*-{2,}|on\s.+\swrote:)$/i;
// Outlook quotes without the dashes: a "From:" line followed closely by one of these.
const HEADER_LINE = /^(?:sent|date|to|cc|subject):\s/i;
// The greeting opens a message, but a copied "Subject:" line may sit above it.
const GREETING_LINES = 3;
// A reference has at least three digits in a row, so "order 3 items" is not one, and is never a date ("order 2026-10-03").
const NOT_A_DATE = "(?!\\d{4}-\\d{2}-\\d{2}\\b|\\d{1,2}-\\d{1,2}-\\d{2,4}\\b)";
const ID = "(?:no\\.?|number|nr\\.?)?\\s*[:#]?\\s*(?=[A-Z0-9-]*\\d{3})" + NOT_A_DATE + "([A-Z0-9][A-Z0-9-]*)";
const ORDER = new RegExp("\\border(?!\\p{L})\\s*" + ID, "iu");
const REFERENCE = new RegExp("\\b(?:ticket|case|ref(?:erence)?|invoice)(?!\\p{L})\\s*" + ID, "iu");
const CURRENCY = "(?:[$€£¥]|\\b(?:USD|EUR|GBP|CHF|JPY|CAD|AUD)\\b)";
const NUMBER = "\\d(?:[\\d,.']*\\d)?";
const AMOUNT = new RegExp(CURRENCY + "\\s?" + NUMBER + "|(?<![\\d.,])" + NUMBER + "\\s?" + CURRENCY, "u");

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(asText).filter(Boolean);
}

function normalizeExtractor(name, raw, where, warnings) {
  const spec = typeof raw === "string" ? { pattern: raw } : raw;
  const skip = (why) => {
    warnings.push(where + " extractor " + name + " ignored: " + why);
    return null;
  };
  if (!isObject(spec)) return skip("not an object");
  const hasPattern = spec.pattern != null;
  if (hasPattern === (spec.after != null)) return skip("needs exactly one of `pattern` or `after`");
  if (!hasPattern) return asText(spec.after) ? { name, after: asText(spec.after) } : skip("empty `after` label");
  const pattern = asText(spec.pattern);
  // Checked here so a bad or backtracking pattern is a policy warning, not a hang while answering mail.
  const refused = policyPattern.check(pattern, "iu");
  if (refused) return skip(refused);
  const groups = new RegExp(pattern + "|", "iu").exec("").length - 1;
  const group = spec.group == null ? 0 : spec.group;
  if (!Number.isInteger(group) || group < 0 || group > groups) return skip("group must be a whole number from 0 to " + groups);
  return { name, pattern, group };
}

function normalizeExtractors(raw, where, warnings) {
  const out = {};
  if (raw == null) return out;
  if (!isObject(raw)) {
    warnings.push(where + " extract ignored: not an object");
    return out;
  }
  for (const [key, spec] of Object.entries(raw)) {
    const name = asText(key);
    if (!name || /[\[\]\r\n]/.test(name)) {
      warnings.push(where + " extractor " + JSON.stringify(key) + " ignored: not a usable blank name");
      continue;
    }
    const extractor = normalizeExtractor(name, spec, where, warnings);
    if (extractor) out[name] = extractor;
  }
  return out;
}

function normalizeReply(raw, index, warnings, ids) {
  if (!isObject(raw)) {
    warnings.push("reply " + index + " ignored: not an object");
    return null;
  }
  let id = asText(raw.id) || "reply-" + index;
  while (ids.has(id)) id += "-dup";
  const keywords = list(raw.keywords);
  if (!keywords.length) {
    warnings.push("reply " + id + " ignored: no keywords");
    return null;
  }
  const hasText = typeof raw.text === "string" && raw.text !== "";
  const shorthand = asText(raw.shorthand);
  if (hasText === !!shorthand) {
    warnings.push("reply " + id + " ignored: needs exactly one of `text` or `shorthand`");
    return null;
  }
  let match = "any";
  if (MATCH.includes(raw.match)) match = raw.match;
  else if (raw.match != null) warnings.push("reply " + id + ": match must be any or all; using any");
  ids.add(id);
  return {
    id,
    label: asText(raw.label) || id,
    keywords,
    match,
    caseSensitive: raw.caseSensitive === true,
    text: hasText ? raw.text : null,
    shorthand: shorthand || null,
    extract: normalizeExtractors(raw.extract, "reply " + id, warnings),
  };
}

/**
 * Validate the `reply` section of a policy. Unusable parts are dropped with a
 * warning; the section is never refused.
 */
function normalizeReplies(raw) {
  const warnings = [];
  const out = { replies: [], extract: {}, max: DEFAULTS.max, dateOrder: "dmy", warnings };
  if (raw == null) return out;
  if (!isObject(raw)) {
    warnings.push("reply section ignored: not an object");
    return out;
  }
  out.extract = normalizeExtractors(raw.extract, "reply section", warnings);
  if (raw.max != null) {
    if (Number.isInteger(raw.max) && raw.max >= 1 && raw.max <= MAX_LIMIT) out.max = raw.max;
    else warnings.push("reply max ignored: must be a whole number from 1 to " + MAX_LIMIT);
  }
  if (raw.dateOrder != null) {
    if (DATE_ORDERS.includes(raw.dateOrder)) out.dateOrder = raw.dateOrder;
    else warnings.push("reply dateOrder ignored: must be dmy or mdy");
  }
  if (raw.replies != null && !Array.isArray(raw.replies)) warnings.push("reply replies ignored: not a list");
  const ids = new Set();
  (Array.isArray(raw.replies) ? raw.replies : []).forEach((entry, index) => {
    const reply = normalizeReply(entry, index, warnings, ids);
    if (reply) out.replies.push(reply);
  });
  return out;
}

/** Where quoted history starts: "On ... wrote:" on one line or wrapped onto two, the dashed Outlook line, or a From:/Sent:/To:/Subject: block. */
function startsQuote(lines, i) {
  const line = lines[i].trim();
  if (QUOTE_START.test(line)) return true;
  if (/^on\s/i.test(line) && QUOTE_START.test(line + " " + (lines[i + 1] || "").trim())) return true;
  return /^from:\s/i.test(line) && lines.slice(i + 1, i + 4).some((next) => HEADER_LINE.test(next.trim()));
}

/**
 * The part of the incoming text written by its latest sender: quoted lines
 * ("> ...") and everything from the start of quoted history on (startsQuote)
 * are dropped, so an old thread cannot pick the reply or fill its blanks.
 * Only the first DEFAULTS.maxChars characters are kept.
 */
function ownPart(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (startsQuote(lines, i)) break;
    if (!/^\s*>/.test(lines[i])) kept.push(lines[i]);
  }
  const own = kept.join("\n").trim();
  return own.length > DEFAULTS.maxChars ? own.slice(0, DEFAULTS.maxChars) : own;
}

/** Names: the greeting's ("Hi Sam,") is who the message was written to; the sign-off's is the sender, whom a reply addresses. */
function findNames(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const out = {};
  for (const line of lines.slice(0, GREETING_LINES)) {
    const greeting = GREETING.exec(line);
    if (greeting && NAME.test(greeting[2])) {
      out.greeted = greeting[2];
      break;
    }
  }
  // The sign-off is the last such line: read from the bottom, a "Thanks Sam" in the body is not the sender.
  for (let i = lines.length - 1; i >= 0 && !out.name; i--) {
    const signOff = SIGN_OFF.exec(lines[i]);
    if (!signOff) continue;
    const candidate = signOff[2] ? signOff[2].replace(/^[,\s]+/, "") : lines[i + 1] || "";
    if (NAME.test(candidate)) out.name = candidate;
  }
  if (out.name) out.firstName = out.name.split(/\s+/)[0];
  return out;
}

function runExtractor(text, extractor) {
  if (extractor.pattern != null) {
    const match = policyPattern.exec(extractor.pattern, "iu", text, DEFAULTS.maxChars);
    return match && match[extractor.group] != null ? asText(match[extractor.group]) : "";
  }
  // "after a label": the rest of that line, without the separator after the label.
  const label = keywordPattern(extractor.after, false);
  for (const match of text.matchAll(new RegExp(label.source, label.flags + "g"))) {
    const rest = text.slice(match.index + match[0].length).split("\n")[0].replace(/^[\s:#=-]+/, "").trim();
    if (rest) return rest;
  }
  return "";
}

/** The values the given policy extractors find in `text` (already the own part); absent ones are left out. */
function runExtractors(text, extractors) {
  const values = {};
  for (const extractor of Object.values(isObject(extractors) ? extractors : {})) {
    const value = runExtractor(text, extractor);
    if (value) values[extractor.name] = value;
  }
  return values;
}

/**
 * Values for blanks found in the incoming message: the built-in ones
 * (BUILTIN_VALUES) and then each policy extractor, which wins over a
 * built-in of the same name when it finds something. Absent values are left
 * out rather than set empty, so their blanks stay visible.
 */
function extractValues(incomingText, extractors, options) {
  const text = ownPart(incomingText);
  const values = findNames(text);
  const order = ORDER.exec(text);
  if (order) values.order = order[1].replace(/-+$/, "");
  const reference = REFERENCE.exec(text);
  if (reference) values.reference = reference[1].replace(/-+$/, "");
  const date = findDate(text, options && options.dateOrder);
  if (date) values.date = date.iso;
  const amount = AMOUNT.exec(text);
  if (amount) values.amount = amount[0];
  return Object.assign(values, runExtractors(text, extractors));
}

/** A reply's text: its own, or the expansion of the shorthand it names in the library (null when that is absent). */
function bodyOf(reply, library) {
  if (!isObject(reply)) return null;
  if (reply.text != null) return reply.text;
  const found = expander.sanitizeList(library).find((entry) => entry.trigger === reply.shorthand);
  return found ? found.expansion : null;
}

/** Warnings for replies whose shorthand is not in the library they will be ranked against; rank() skips those. */
function checkLibrary(config, library) {
  return (config && Array.isArray(config.replies) ? config.replies : [])
    .filter((reply) => reply.shorthand && bodyOf(reply, library) == null)
    .map((reply) => "reply " + reply.id + " skipped: shorthand " + reply.shorthand + " is not in the library");
}

/**
 * The replies that fit an incoming message, best first: score is the number
 * of the reply's keywords found (all of them for match "all", at least one
 * for "any"); equal scores keep policy order. `text` is rendered with
 * template.render, so placeholders in the reply ({date}, {cursor}) work and
 * values taken from the message stay literal; blanks without a value stay as
 * [[name]] and are listed in `missing` for the person to answer.
 * @returns {Array<{reply:object, score:number, matched:string[], body:string, values:object, text:string, cursorOffset:number, missing:string[]}>}
 */
function rank(incomingText, config, library, options) {
  const settings = Object.assign({ now: new Date() }, options || {});
  const replies = config && Array.isArray(config.replies) ? config.replies : [];
  const text = ownPart(incomingText);
  if (!text || !replies.length) return [];
  const shared = extractValues(text, config.extract, { dateOrder: config.dateOrder });
  const hits = [];
  replies.forEach((reply, position) => {
    const matched = reply.keywords.filter((keyword) => keywordPattern(keyword, reply.caseSensitive).test(text));
    if (!(reply.match === "all" ? matched.length === reply.keywords.length : matched.length > 0)) return;
    const body = bodyOf(reply, library);
    if (body == null) return;
    // Only the reply's own extractors are layered on: running the built-ins again would undo a section extractor's override.
    const values = Object.keys(reply.extract).length ? Object.assign({}, shared, runExtractors(text, reply.extract)) : shared;
    const blanks = template.fields(body).map((field) => field.name);
    const used = Object.fromEntries(blanks.filter((name) => Object.hasOwn(values, name)).map((name) => [name, values[name]]));
    const rendered = template.render(body, used, settings.now);
    hits.push({
      position,
      candidate: { reply, score: matched.length, matched, body, values: used, text: rendered.text, cursorOffset: rendered.cursorOffset, missing: blanks.filter((name) => !Object.hasOwn(used, name)) },
    });
  });
  hits.sort((a, b) => b.candidate.score - a.candidate.score || a.position - b.position);
  const max = Number.isInteger(settings.max) && settings.max >= 1 ? settings.max : config.max || DEFAULTS.max;
  return hits.slice(0, max).map((hit) => hit.candidate);
}

/**
 * The text to insert for a chosen reply: `answers` (typed by the person) fill
 * the blanks the message did not and may replace a found value; an empty
 * answer counts as none. Answers and values stay literal (template.render
 * never renders placeholders in them), so "{clipboard}" typed into a blank is
 * inserted as typed. `missing` lists the blanks still open; the shell refuses
 * to insert while it is not empty, so no mail goes out with [[name]] in it.
 * @returns {{text:string, cursorOffset:number, values:object, missing:string[]}}
 */
function fill(body, values, answers, options) {
  const source = String(body == null ? "" : body);
  const blanks = template.fields(source).map((field) => field.name);
  const merged = {};
  for (const name of blanks) {
    const answer = isObject(answers) && Object.hasOwn(answers, name) ? asText(answers[name]) : "";
    if (answer) merged[name] = answer;
    else if (isObject(values) && Object.hasOwn(values, name)) merged[name] = asText(values[name]);
  }
  const rendered = template.render(source, merged, (options && options.now) || new Date());
  return { text: rendered.text, cursorOffset: rendered.cursorOffset, values: merged, missing: blanks.filter((name) => !Object.hasOwn(merged, name)) };
}

/** Organisation items a usage report may name: one per reply, kind "reply" (core/report.js). */
function organizationItems(section) {
  return (section && Array.isArray(section.replies) ? section.replies : [])
    .filter((reply) => isObject(reply) && typeof reply.id === "string" && reply.id)
    .map((reply) => ({ trigger: reply.id, kind: "reply" }));
}

// ---- Per-reply counts ----------------------------------------------------

function count(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Clean counts read back from storage: unknown fields dropped, bad numbers zeroed. */
function normalizeStats(raw) {
  const entries = Object.entries(isObject(raw) ? raw : {}).filter(([id]) => asText(id));
  return Object.fromEntries(entries.map(([id, row]) => {
    const source = isObject(row) ? row : {};
    return [id, { offered: count(source.offered), inserted: count(source.inserted), editedBeforeSend: count(source.editedBeforeSend) }];
  }));
}

/**
 * A copy of `stats` with one event counted for a reply: "offered" (shown in
 * the list), "inserted" (chosen) or "edited" (changed before sending). An
 * unknown event or empty id returns the counts unchanged.
 */
function recordStat(stats, id, event) {
  const key = asText(id);
  const out = normalizeStats(stats);
  if (!key || !Object.hasOwn(STAT_EVENTS, event)) return out;
  const row = Object.hasOwn(out, key) ? out[key] : { offered: 0, inserted: 0, editedBeforeSend: 0 };
  row[STAT_EVENTS[event]] += 1;
  // Built with fromEntries so any id, "__proto__" included, stays an ordinary key (hygiene).
  const entries = Object.entries(out);
  const at = entries.findIndex(([k]) => k === key);
  if (at < 0) entries.push([key, row]);
  else entries[at] = [key, row];
  return Object.fromEntries(entries);
}

module.exports = {
  DEFAULTS,
  BUILTIN_VALUES,
  STAT_EVENTS,
  normalizeReplies,
  ownPart,
  extractValues,
  bodyOf,
  checkLibrary,
  rank,
  fill,
  organizationItems,
  normalizeStats,
  recordStat,
};
