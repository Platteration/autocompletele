// Finds the parts of similar messages that change ("Hi John" / "Hi Mary") and
// proposes one fill-in template with [[name]] blanks, in the same syntax the
// browser extension already understands. The returned segments drive the diff
// overlay in the desktop app: unchanged text in one colour, each slot in
// another with the values seen so far.
"use strict";

const { tokenize, isSpace, diff, similarity } = require("./diff.js");
const { template: templates } = require("./personal.js");

const DEFAULTS = Object.freeze({ threshold: 0.6, maxSlots: 4 });
const GREETING = /^(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))$/i;
const DATE = /^(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:\d{1,2}(?:st|nd|rd|th)?\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+\d{4})?|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?)$/i;
const NUMBER = /^[-+]?[$€£]?\d[\d,.]*%?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORDER = /^(?:#|no\.?|order|ref|ticket|case|invoice|inv)?\s*[#-]?\s*[A-Z]{0,4}-?\d{3,}$/i;

/** Group texts whose similarity to a group's first member meets the threshold. */
function cluster(texts, options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const groups = [];
  (Array.isArray(texts) ? texts : []).forEach((text, index) => {
    const value = String(text == null ? "" : text);
    const group = groups.find((g) => similarity(g.anchor, value) >= settings.threshold);
    if (group) group.members.push(index);
    else groups.push({ anchor: value, members: [index] });
  });
  return groups.map((g) => g.members);
}

function isPunctuation(token) {
  return token.length === 1 && !isSpace(token) && !/[\p{L}\p{N}_]/u.test(token);
}

function widenToWord(anchor, range) {
  let [start, end] = range;
  while (start > 0 && !isSpace(anchor[start - 1])) start--;
  while (end < anchor.length && !isSpace(anchor[end])) end++;
  while (start < range[0] && isPunctuation(anchor[start])) start++;
  while (end > range[1] && isPunctuation(anchor[end - 1])) end--;
  return [start, end];
}

function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else out.push(range.slice());
  }
  return out;
}

/** Text of `ops` (a diff against the anchor) that corresponds to anchor range [start, end). */
function valueFor(ops, start, end) {
  let value = "";
  for (const op of ops) {
    if (op.type === "insert") {
      if (op.aStart >= start && op.aStart <= end && (start < end || op.aStart === start)) value += op.b.join("");
      continue;
    }
    const from = Math.max(op.aStart, start);
    const to = Math.min(op.aEnd, end);
    if (from >= to) continue;
    if (op.type === "equal") value += op.a.slice(from - op.aStart, to - op.aStart).join("");
    else if (op.type === "replace") {
      // A replacement maps the whole changed anchor span to the whole new span.
      if (from === op.aStart) value += op.b.join("");
    }
  }
  return value;
}

function nameSlot(values, before, index, used) {
  const trimmed = values.map((v) => v.trim()).filter(Boolean);
  const lastWord = before.filter((t) => !isSpace(t)).slice(-1)[0] || "";
  const capitalized = trimmed.length && trimmed.every((v) => /^\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,3}$/u.test(v));
  let name;
  if (trimmed.length && trimmed.every((v) => EMAIL.test(v))) name = "email";
  else if (trimmed.length && trimmed.every((v) => DATE.test(v))) name = "date";
  else if (trimmed.length && trimmed.every((v) => ORDER.test(v))) name = "reference";
  else if (trimmed.length && trimmed.every((v) => NUMBER.test(v))) name = "amount";
  else if (capitalized && (GREETING.test(lastWord) || /^(?:to|with|from|for|cc|attn)$/i.test(lastWord))) name = "name";
  else if (capitalized) name = "name";
  else name = "detail";
  let candidate = name;
  let counter = 2;
  while (used.has(candidate)) candidate = name + counter++;
  used.add(candidate);
  return candidate;
}

// Text the person typed must stay literal in the saved template: a typed
// "[[x]]" would otherwise become a blank and a typed "{date}" today's date.
function escapeLiteral(text) {
  return String(text)
    .replace(/\{([a-z]+)\}/gi, "{{$1}}")
    .replace(/\[\[(?=[^\[\]\r\n]*\]\])/g, "\\[[");
}

function validName(name) {
  return typeof name === "string" && name.trim() !== "" && !/[\[\]\r\n]/.test(name);
}

/**
 * Build the template text from overlay segments, optionally renaming blanks.
 * Two blanks given the same name share one answer, as in any template.
 * @param {Array} segments from detect()
 * @param {object} [names] { originalName: newName }
 * @returns {{ok:true, template:string}|{ok:false, error:string}}
 */
function templateFrom(segments, names) {
  const renames = names && typeof names === "object" ? names : {};
  let out = "";
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment.type === "same") {
      out += escapeLiteral(segment.text);
      continue;
    }
    const wanted = Object.hasOwn(renames, segment.name) && String(renames[segment.name]).trim() !== ""
      ? String(renames[segment.name]).trim() : segment.name;
    if (!validName(wanted)) return { ok: false, error: "A blank's name cannot contain brackets or line breaks: " + JSON.stringify(wanted) };
    out += "[[" + wanted + "]]";
  }
  return { ok: true, template: out };
}

/**
 * Detect variable slots across similar texts.
 * @returns {{template:string, slots:Array<{name:string,values:string[]}>, segments:Array, similarity:number}|null}
 *   null when the texts are not similar enough, identical, or differ in too many places.
 */
function detect(texts, options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const inputs = (Array.isArray(texts) ? texts : []).map((t) => String(t == null ? "" : t)).filter((t) => t.trim());
  if (inputs.length < 2) return null;
  const anchor = tokenize(inputs[0]);
  const diffs = [];
  let minSimilarity = 1;
  const ranges = [];
  for (const text of inputs.slice(1)) {
    const score = similarity(inputs[0], text);
    minSimilarity = Math.min(minSimilarity, score);
    if (score < settings.threshold) return null;
    const ops = diff(anchor, tokenize(text));
    diffs.push(ops);
    for (const op of ops) {
      if (op.type === "equal") continue;
      ranges.push([op.aStart, op.aEnd]);
    }
  }
  if (!ranges.length) return null;
  // A change inside a word ("$120.50" / "$99", "bob@example.com" /
  // "alice@example.org") makes the whole word the slot; punctuation on the
  // word's edges stays outside it.
  let slots = mergeRanges(mergeRanges(ranges).map((range) => widenToWord(anchor, range)));
  // Widen a slot over whitespace that sits between two changed runs, so
  // "Mary" and "Mary Ann" become one slot rather than two.
  const widened = [];
  for (const range of slots) {
    const last = widened[widened.length - 1];
    if (last && range[0] - last[1] === 1 && isSpace(anchor[last[1]] || "")) last[1] = range[1];
    else widened.push(range);
  }
  slots = widened;
  if (slots.length > settings.maxSlots) return null;

  const used = new Set();
  const segments = [];
  const slotInfo = [];
  let cursor = 0;
  for (const [start, end] of slots) {
    const values = [anchor.slice(start, end).join("")].concat(diffs.map((ops) => valueFor(ops, start, end)));
    const name = nameSlot(values, anchor.slice(0, start), slotInfo.length, used);
    if (cursor < start) segments.push({ type: "same", text: anchor.slice(cursor, start).join("") });
    segments.push({ type: "slot", name, values });
    slotInfo.push({ name, values });
    cursor = end;
  }
  if (cursor < anchor.length) segments.push({ type: "same", text: anchor.slice(cursor).join("") });
  // "[" or "\\" right before a blank, or "]" right after it, would merge with
  // the blank's own brackets ("[[[reference]]]") or escape it. Such a
  // character moves into the blank, so every value carries it.
  for (let i = 0; i < segments.length; i++) {
    const slot = segments[i];
    if (slot.type !== "slot") continue;
    const before = segments[i - 1];
    while (before && before.type === "same" && /[\[\\]$/.test(before.text)) {
      const ch = before.text.slice(-1);
      before.text = before.text.slice(0, -1);
      slot.values = slot.values.map((value) => ch + value);
    }
    const after = segments[i + 1];
    while (after && after.type === "same" && after.text.startsWith("]")) {
      after.text = after.text.slice(1);
      slot.values = slot.values.map((value) => value + "]");
    }
  }
  const kept = segments.filter((segment) => segment.type === "slot" || segment.text !== "");
  segments.length = 0;
  segments.push(...kept);
  for (const info of slotInfo) info.values = segments.find((segment) => segment.type === "slot" && segment.name === info.name).values;
  const template = templateFrom(segments).template;
  // Backstop: the template must parse back into exactly these blanks.
  const parsed = templates.fields(template).map((field) => field.name);
  if (parsed.join("\n") !== slotInfo.map((info) => info.name).join("\n")) return null;
  return { template, slots: slotInfo, segments, similarity: minSimilarity, count: inputs.length };
}

module.exports = { DEFAULTS, cluster, detect, templateFrom, escapeLiteral };
