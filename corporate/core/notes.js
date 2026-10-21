// actle Notes: minutes, handovers, shift logs, incident logs, care notes and
// inspection reports in the organisation's house style. A typed trigger such as
// /mins drops in the structure (headings, attendee list, action items) with the
// date, weekday and the person's name filled; action items written anywhere in
// the note are collected into one summary block at the end. Local and pure: the
// shell owns the editor, the corpus of earlier notes and any saving.
// Work in progress: the policy section and the action heuristics may change.
"use strict";

const { expander, template } = require("./personal.js");
const { keywordPattern } = require("./keyword-rules.js");
const phraseMiner = require("./phrase-miner.js");
const { findDate } = require("./filer.js");

const DEFAULT_ACTIONS = Object.freeze({ heading: "Action items", patterns: Object.freeze(["TODO", "ACTION"]), empty: "None" });
const DATE_ORDERS = Object.freeze(["dmy", "mdy"]);
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
const WEEKDAY = "(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const DUE_WEEKDAY = new RegExp(WORD_START + "(?:(?:by|before|until|due)\\s+(next\\s+)?|(next)\\s+)" + WEEKDAY + WORD_END, "iu");
const DUE_DATE = new RegExp(WORD_START + "(?:by|before|until|due)\\s+", "giu");
const DUE_DAY = new RegExp(WORD_START + "(?:(?:by|before|due)\\s+(today)|(?:(?:by|before|due)\\s+)?(tomorrow))" + WORD_END, "iu");
const DUE_VAGUE = new RegExp(WORD_START + "(?:(?:by|before|due)\\s+)?(?:the\\s+)?(end\\s+of\\s+(?:the\\s+)?(?:day|week|month)|eod|eow|next\\s+week|next\\s+month|asap)" + WORD_END, "iu");
const MENTION = /(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/u;
const LEADING_OWNER = /^(\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)?)\s+(?:will|to)\s/u;
// Capitalised sentence openers that are not people ("Back to normal", "We will").
const NOT_NAMES = new Set(["i", "we", "you", "they", "he", "she", "it", "this", "that", "these", "those", "the", "a", "an", "everyone", "someone", "somebody", "nobody", "all", "both", "who", "what", "when", "where", "why", "how", "there", "here", "back", "due", "next", "need", "needs", "time", "plan", "want", "wanted", "agreed", "decided", "going", "also", "then", "today", "tomorrow"]);
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+(?:\[[ xX]?\]\s+)?|^\s*\[[ xX]?\]\s+/;
const CURSOR = /(?<!\{)\{cursor\}(?!\})/i;
// A list line holding one blank and nothing else; mirrors expandListLines.
const LIST_BLANK = /^[ \t]*[-*•][ \t]+\[\[\s*([^\[\]\r\n]+?)\s*\]\][ \t]*$/gm;

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A blank name as the policy may write it: "author" or "[[author]]". */
function blankName(value) {
  const name = asText(value).replace(/^\[\[\s*|\s*\]\]$/g, "");
  return name && !/[\[\]\r\n]/.test(name) ? name : "";
}

function normalizeActions(raw, inherited, warnings, where) {
  if (raw === false) return null;
  if (raw == null) return inherited;
  if (!isObject(raw)) {
    warnings.push(where + " actions ignored: not an object or false");
    return inherited;
  }
  // A document may switch actions back on when the policy switched them off.
  const base = inherited || DEFAULT_ACTIONS;
  const out = { heading: asText(raw.heading).replace(/\s+/g, " ") || base.heading, patterns: base.patterns, empty: asText(raw.empty) || base.empty };
  if (raw.patterns != null) {
    const list = Array.isArray(raw.patterns) ? raw.patterns : [raw.patterns];
    out.patterns = list.map(asText).filter(Boolean);
    if (out.patterns.length !== list.length) warnings.push(where + " actions: " + (list.length - out.patterns.length) + " empty pattern(s) ignored");
  }
  return out;
}

function normalizeSection(raw, index, warnings, id) {
  const source = typeof raw === "string" ? { heading: raw } : raw;
  if (!isObject(source)) {
    warnings.push("notes document " + id + " section " + index + " ignored: not an object");
    return null;
  }
  const heading = asText(source.heading).replace(/\s+/g, " ");
  const body = Array.isArray(source.body) ? source.body.map((line) => String(line == null ? "" : line)).join("\n") : String(source.body == null ? "" : source.body);
  if (!heading && !body.trim()) {
    warnings.push("notes document " + id + " section " + index + " ignored: no heading or body");
    return null;
  }
  return { heading, body, repeat: source.repeat === true };
}

/**
 * Validate the `notes` section of a policy. Unusable documents, sections and
 * settings are dropped with a warning; the section is never refused.
 */
function normalizeNotes(raw) {
  const warnings = [];
  const source = isObject(raw) ? raw : {};
  if (raw != null && !isObject(raw)) warnings.push("notes section ignored: not an object");
  const out = { documents: [], author: "author", dateOrder: "dmy", actions: null, warnings };
  if (source.author != null) {
    if (blankName(source.author)) out.author = blankName(source.author);
    else warnings.push("notes author ignored: not a blank name");
  }
  if (source.dateOrder != null) {
    if (DATE_ORDERS.includes(source.dateOrder)) out.dateOrder = source.dateOrder;
    else warnings.push("notes dateOrder ignored: must be dmy or mdy");
  }
  out.actions = normalizeActions(source.actions, Object.assign({}, DEFAULT_ACTIONS), warnings, "notes");
  const ids = new Set();
  const triggers = new Set();
  (Array.isArray(source.documents) ? source.documents : []).forEach((doc, index) => {
    if (!isObject(doc)) {
      warnings.push("notes document " + index + " ignored: not an object");
      return;
    }
    let id = asText(doc.id) || "notes-" + index;
    while (ids.has(id)) id += "-dup";
    const trigger = asText(doc.trigger);
    if (!trigger || triggers.has(trigger)) {
      warnings.push("notes document " + id + " ignored: " + (trigger ? "duplicate trigger " + trigger : "no trigger"));
      return;
    }
    const sections = (Array.isArray(doc.sections) ? doc.sections : []).map((s, i) => normalizeSection(s, i, warnings, id)).filter(Boolean);
    if (!sections.length) {
      warnings.push("notes document " + id + " ignored: no usable sections");
      return;
    }
    ids.add(id);
    triggers.add(trigger);
    out.documents.push({ id, trigger, label: asText(doc.label) || id, title: asText(doc.title), sections, actions: normalizeActions(doc.actions, out.actions, warnings, "notes document " + id), dateOrder: out.dateOrder });
  });
  return out;
}

/**
 * The document whose trigger ends at the caret, under the same boundary rule
 * as text shortcuts. @returns {{document:object, start:number}|null}
 */
function findDocument(textBeforeCaret, config) {
  const list = config && Array.isArray(config.documents) ? config.documents : [];
  const match = expander.findMatch(textBeforeCaret, list.map((d) => ({ trigger: d.trigger, expansion: "" })));
  if (!match) return null;
  return { document: list.find((d) => d.trigger === match.shorthand.trigger), start: match.start };
}

/** A list line holding only an array blank ("- [[attendees]]") becomes one line per item. */
function expandListLines(text, arrays, answers) {
  let out = text;
  for (const [name, items] of Object.entries(arrays)) {
    const line = new RegExp("^([ \\t]*[-*•][ \\t]+)\\[\\[\\s*" + escapeRegExp(name) + "\\s*\\]\\][ \\t]*$", "gm");
    out = out.replace(line, (whole, prefix) => items.map((item, i) => {
      answers[name + "#" + (i + 1)] = item;
      return prefix + "[[" + name + "#" + (i + 1) + "]]";
    }).join("\n"));
  }
  return out;
}

/**
 * Render a document for insertion. Values with only whitespace count as
 * missing so the blank stays visible. A `repeat` section is written once per
 * item of the longest array among its blanks; a shorter array leaves its blank
 * open in the later copies and is listed in `short` with the counts, so a
 * form can say how many values the blank needs. The caret goes to the first
 * {cursor}, else the first empty section, else the end of the last section.
 * @returns {{text:string, fields:string[], short:Object<string,{given:number, needed:number}>, caret:number, ready:boolean}}
 */
function render(doc, values, now) {
  const short = {};
  const scalars = {};
  const arrays = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (Array.isArray(value)) {
      const items = value.map(asText).filter(Boolean);
      if (items.length) arrays[key] = items;
    } else if (asText(value)) {
      scalars[key] = String(value);
    }
  }
  const joined = Object.assign({}, scalars);
  for (const [name, items] of Object.entries(arrays)) joined[name] = items.join(", ");
  const pieces = [];
  if (doc.title) pieces.push({ text: "# " + doc.title, answers: joined });
  for (const section of doc.sections) {
    const source = (section.heading ? "## " + section.heading + "\n" : "") + section.body;
    const used = template.fields(source).map((f) => f.name).filter((name) => arrays[name]);
    const copies = section.repeat ? Math.max(1, ...used.map((name) => arrays[name].length)) : 1;
    for (let i = 0; i < copies; i++) {
      const answers = Object.assign({}, section.repeat ? scalars : joined);
      for (const [name, items] of Object.entries(arrays)) {
        if (!section.repeat || !used.includes(name)) continue;
        if (items[i] != null) answers[name] = items[i];
        else short[name] = { given: items.length, needed: copies };
      }
      const text = section.repeat ? source : expandListLines(source, arrays, answers);
      pieces.push({ text, answers, empty: !!section.heading && !section.body.trim() });
    }
  }
  if (doc.actions && !doc.sections.some((s) => s.heading.toLowerCase() === doc.actions.heading.toLowerCase())) {
    pieces.push({ text: "## " + doc.actions.heading + "\n- " + doc.actions.empty, answers: joined, block: true });
  }
  let text = "";
  let cursorCaret = null;
  let emptyCaret = null;
  let sectionsEnd = 0;
  const missing = [];
  for (const piece of pieces) {
    if (text) text += "\n\n";
    const rendered = template.render(piece.text, piece.answers, now);
    if (cursorCaret == null && CURSOR.test(piece.text)) cursorCaret = text.length + rendered.cursorOffset;
    if (emptyCaret == null && piece.empty) emptyCaret = text.length + rendered.text.length;
    for (const field of template.fields(piece.text)) {
      if (!Object.hasOwn(piece.answers, field.name) && !missing.includes(field.name)) missing.push(field.name);
    }
    text += rendered.text;
    if (!piece.block) sectionsEnd = text.length;
  }
  const caret = cursorCaret != null ? cursorCaret : emptyCaret != null ? emptyCaret : sectionsEnd;
  return { text: text + "\n", fields: missing, short, caret, ready: missing.length === 0 };
}

function actionsOf(config) {
  return config && config.actions !== undefined ? config.actions : DEFAULT_ACTIONS;
}

/** Lines [start, end) of the action block: its heading and the list lines right under it. */
function blockRange(lines, actions) {
  const heading = new RegExp("^#{1,6}\\s+" + escapeRegExp(actions.heading) + "\\s*#*\\s*$", "i");
  for (let start = lines.length - 1; start >= 0; start--) {
    if (!heading.test(lines[start])) continue;
    let end = start + 1;
    while (end < lines.length && LIST_MARKER.test(lines[end])) end++;
    return { start, end };
  }
  return null;
}

function addDays(now, days) {
  return expander.render("{date}", new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)).text;
}

/** "by Friday" is the next Friday after today; "next Friday" is Friday of next week (weeks start on Monday). */
function weekdayDue(now, word, next) {
  const target = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(word.toLowerCase().slice(0, 3));
  if (!next) return addDays(now, (target - now.getDay() + 7) % 7 || 7);
  return addDays(now, ((8 - now.getDay()) % 7 || 7) + (target + 6) % 7);
}

/** The earliest due phrase in a sentence; `due` is ISO when a weekday or date is given. */
function findDue(sentence, now, order) {
  const found = [];
  let m = DUE_WEEKDAY.exec(sentence);
  if (m) found.push({ index: m.index, due: weekdayDue(now, m[3], !!(m[1] || m[2])), dueText: m[0] });
  for (const by of sentence.matchAll(DUE_DATE)) {
    const rest = sentence.slice(by.index + by[0].length, by.index + by[0].length + 40);
    const date = findDate(rest, order);
    if (date && date.index === 0) {
      // The date as written is the shortest start of `rest` that still reads as a date; `rest` itself does, so this ends.
      let length = 1;
      while (!findDate(rest.slice(0, length), order)) length++;
      found.push({ index: by.index, due: date.iso, dueText: by[0] + rest.slice(0, length) });
      break;
    }
  }
  if ((m = DUE_DAY.exec(sentence))) found.push({ index: m.index, due: addDays(now, m[1] ? 0 : 1), dueText: m[0] });
  if ((m = DUE_VAGUE.exec(sentence))) found.push({ index: m.index, due: m[1].replace(/\s+/g, " "), dueText: m[0] });
  found.sort((a, b) => a.index - b.index);
  return found[0] || null;
}

function findOwner(sentence, prefix) {
  const mention = MENTION.exec(sentence);
  if (mention) return mention[1];
  const lead = LEADING_OWNER.exec(sentence.replace(prefix, ""));
  return lead && !NOT_NAMES.has(lead[1].split(/\s+/)[0].toLowerCase()) ? lead[1] : "";
}

/** "- text (due ISO)": the owner is always part of the text it was found in. */
function itemLine(item) {
  return "- " + item.text + (/^\d{4}-\d\d-\d\d$/.test(item.due) ? " (due " + item.due + ")" : "");
}

/**
 * Action items in a note: sentences with an owner (@name, or a leading name
 * followed by "will" or "to"), a due phrase, or one of the policy's patterns.
 * Headings and the action block itself are skipped, so collecting is stable.
 * @returns {{items:Array<{owner:string, due:string, dueText:string, text:string, line:number}>, block:string}}
 */
function collectActions(text, config, now) {
  const actions = actionsOf(config) || DEFAULT_ACTIONS;
  const today = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const order = config && DATE_ORDERS.includes(config.dateOrder) ? config.dateOrder : "dmy";
  const keywords = actions.patterns.map((p) => keywordPattern(p, false));
  const prefix = actions.patterns.length ? new RegExp("^(?:" + actions.patterns.map(escapeRegExp).join("|") + ")" + WORD_END + "\\s*[:\\-–]?\\s*", "iu") : /^/;
  const lines = String(text == null ? "" : text).split("\n");
  const block = blockRange(lines, actions);
  const items = [];
  lines.forEach((raw, index) => {
    if ((block && index >= block.start && index < block.end) || /^\s*#{1,6}\s/.test(raw)) return;
    const line = raw.replace(LIST_MARKER, "").trim();
    for (const piece of line.split(/(?<=[.!?])\s+(?=[\p{Lu}@\d"'(])/u)) {
      const sentence = piece.trim();
      if (!sentence) continue;
      const owner = findOwner(sentence, prefix);
      const due = findDue(sentence, today, order);
      if (!owner && !due && !keywords.some((k) => k.test(sentence))) continue;
      items.push({ owner, due: due ? due.due : "", dueText: due ? due.dueText : "", text: sentence.replace(/[.!?]+$/, ""), line: index + 1 });
    }
  });
  const body = items.length ? items.map(itemLine) : ["- " + actions.empty];
  return { items, block: ["## " + actions.heading].concat(body).join("\n") };
}

/**
 * Replace the action block, or append one when the note has items and no
 * block. List lines in the old block that the new block does not produce
 * (typed there by hand, or left from an edited item) are kept, never dropped.
 */
function updateActionBlock(text, config, now) {
  const actions = actionsOf(config);
  const source = String(text == null ? "" : text);
  if (!actions) return source;
  const { items, block } = collectActions(source, config, now);
  const lines = source.split("\n");
  const range = blockRange(lines, actions);
  if (!range) {
    if (!items.length) return source;
    return source + (source.endsWith("\n\n") || !source ? "" : source.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
  }
  const generated = block.split("\n");
  const emptyLine = "- " + actions.empty;
  const kept = lines.slice(range.start + 1, range.end).filter((line) => !generated.includes(line) && line.trim() !== emptyLine);
  const next = items.length || !kept.length ? generated.concat(kept) : [generated[0]].concat(kept);
  return lines.slice(0, range.start).concat(next, lines.slice(range.end)).join("\n");
}

/**
 * Recurring phrasings across a person's earlier notes (strings), mined from
 * the prose only: headings, the action block and template text are left out.
 */
function phrasings(earlierNotes, config, options) {
  const settings = Object.assign({}, options);
  const boilerplate = (config && Array.isArray(config.documents) ? config.documents : []).flatMap((d) => d.sections.map((s) => s.body)).filter((b) => b.trim());
  settings.existing = boilerplate.concat(Array.isArray(settings.existing) ? settings.existing : []);
  const actions = actionsOf(config);
  const prose = (Array.isArray(earlierNotes) ? earlierNotes : []).map((note) => {
    const lines = String(note == null ? "" : note).split("\n");
    const range = actions ? blockRange(lines, actions) : null;
    return lines.filter((line, i) => !(range && i >= range.start && i < range.end) && !/^\s*#{1,6}\s/.test(line)).join("\n");
  });
  return phraseMiner.mine(prose, settings);
}

/**
 * The blanks a document asks for, in order of first use. A blank is a list
 * when a list line holds it alone ("- [[attendees]]") or it is used only in
 * repeat sections; a form then takes several values for it.
 * @returns {Array<{name:string, list:boolean}>}
 */
function blanks(doc) {
  const seen = new Map();
  const note = (name, where) => {
    const entry = seen.get(name) || { name, plain: false, repeat: false, listLine: false };
    entry[where] = true;
    seen.set(name, entry);
  };
  if (doc && doc.title) for (const field of template.fields(doc.title)) note(field.name, "plain");
  for (const section of doc && Array.isArray(doc.sections) ? doc.sections : []) {
    const body = String(section.body == null ? "" : section.body);
    for (const field of template.fields(String(section.heading == null ? "" : section.heading) + "\n" + body)) note(field.name, section.repeat ? "repeat" : "plain");
    for (const line of body.matchAll(LIST_BLANK)) note(line[1], "listLine");
  }
  return [...seen.values()].map((entry) => ({ name: entry.name, list: entry.listLine || (entry.repeat && !entry.plain) }));
}

/** The policy items a usage report may name: one per document, counted under kind "notes". */
function organizationItems(section) {
  const list = section && Array.isArray(section.documents) ? section.documents : [];
  return list.filter((doc) => doc && typeof doc.id === "string" && doc.id).map((doc) => ({ trigger: doc.id, kind: "notes" }));
}

module.exports = { DEFAULT_ACTIONS, normalizeNotes, findDocument, blanks, render, collectActions, updateActionBlock, phrasings, organizationItems };
