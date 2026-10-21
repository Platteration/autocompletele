// Document filing: name and file a document from what it contains. A policy
// rule says which documents it covers (keywords, extensions), what to call
// them (a [[blank]] template, the same syntax as fill-in shortcuts) and where
// they belong. Field values are found in the text by lists, aliases and
// patterns; dates are recognised in common spellings. The index of filed
// documents holds names, paths and the values found, never document text.
// Pure: reading, renaming and watching folders are the shell's job.
"use strict";

const { template } = require("./personal.js");
const { keywordPattern, MATCH } = require("./keyword-rules.js");
const capture = require("./capture-policy.js");

const BUILTIN_FIELDS = Object.freeze(["date", "year", "month", "day", "original", "ext"]);
const DATE_ORDERS = Object.freeze(["dmy", "mdy"]);
const MAX_NAME = 150;
const MAX_VALUE = 80;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(asText).filter(Boolean);
}

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

/** A value that will become part of a file or folder name: no separators or control characters. */
function cleanValue(value) {
  return String(value == null ? "" : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
}

/**
 * Make a file name safe on Windows, macOS and Linux: banned characters removed,
 * whitespace collapsed to one underscore, trailing dots and spaces dropped,
 * reserved device names prefixed, length capped while keeping the extension.
 */
function safeName(name, ext) {
  const extension = asText(ext).replace(/^\.+/, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  let stem = String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._\s]+|[._\s]+$/g, "");
  if (!stem) stem = "document";
  if (RESERVED_NAMES.test(stem)) stem = "_" + stem;
  const room = MAX_NAME - (extension ? extension.length + 1 : 0);
  if (stem.length > room) stem = stem.slice(0, Math.max(1, room)).replace(/[._\s]+$/g, "") || "document";
  return extension ? stem + "." + extension : stem;
}

/** A template is usable when it has text or blanks and no path separators outside blanks. */
function validNameTemplate(text) {
  const source = asText(text);
  if (!source) return false;
  const literal = template.parts(source).filter((part) => part.type === "text").map((part) => part.value).join("");
  return !/[\\/]/.test(literal);
}

function normalizeField(name, raw, warnings) {
  const spec = isObject(raw) ? raw : Array.isArray(raw) ? { values: raw } : typeof raw === "string" ? { pattern: raw } : null;
  if (!spec) {
    warnings.push("filing field " + name + " ignored: not an object");
    return null;
  }
  const out = { name, values: list(spec.values), aliases: {}, pattern: null, group: 0 };
  if (isObject(spec.aliases)) {
    for (const [alias, target] of Object.entries(spec.aliases)) {
      if (asText(alias) && asText(target)) out.aliases[asText(alias)] = asText(target);
    }
  }
  if (spec.pattern != null) {
    const pattern = asText(spec.pattern);
    try {
      // Compiled once here so an invalid pattern is a policy warning, not a crash at filing time.
      new RegExp(pattern, "iu");
      out.pattern = pattern;
      out.group = Number.isInteger(spec.group) && spec.group > 0 ? spec.group : 0;
    } catch (error) {
      warnings.push("filing field " + name + " ignored: invalid pattern (" + error.message + ")");
      return null;
    }
  }
  if (!out.values.length && !Object.keys(out.aliases).length && !out.pattern) {
    warnings.push("filing field " + name + " ignored: needs values, aliases or a pattern");
    return null;
  }
  return out;
}

function normalizeRule(raw, index, warnings, ids) {
  if (!isObject(raw)) {
    warnings.push("filing rule " + index + " ignored: not an object");
    return null;
  }
  let id = asText(raw.id) || "filing-" + index;
  while (ids.has(id)) id += "-dup";
  const when = isObject(raw.when) ? raw.when : {};
  const keywords = list(when.keywords);
  const extensions = list(when.extensions).map((ext) => ext.replace(/^\.+/, "").toLowerCase()).filter(Boolean);
  if (!keywords.length && !extensions.length) {
    warnings.push("filing rule " + id + " ignored: `when` needs keywords or extensions (use `fallback` for everything else)");
    return null;
  }
  const name = asText(raw.name);
  if (!validNameTemplate(name)) {
    warnings.push("filing rule " + id + " ignored: `name` is missing or contains a path separator");
    return null;
  }
  ids.add(id);
  return {
    id,
    label: asText(raw.label) || id,
    when: { keywords, extensions, match: MATCH.includes(when.match) ? when.match : "any", caseSensitive: when.caseSensitive === true },
    name,
    folder: asText(raw.folder),
  };
}

/**
 * Validate the `filing` section of a policy. Unusable parts are dropped with
 * a warning; the section is never refused.
 */
function normalizeFiling(raw) {
  const warnings = [];
  const out = { watch: [], fields: {}, rules: [], fallback: null, dateOrder: "dmy", warnings };
  const source = isObject(raw) ? raw : {};
  if (raw != null && !isObject(raw)) warnings.push("filing section ignored: not an object");
  const seenPaths = new Set();
  (Array.isArray(source.watch) ? source.watch : source.watch == null ? [] : [source.watch]).forEach((entry, index) => {
    const spec = isObject(entry) ? entry : { path: entry };
    const folder = asText(spec.path);
    if (!folder) {
      warnings.push("filing watch folder " + index + " ignored: no path");
      return;
    }
    if (seenPaths.has(folder)) return;
    seenPaths.add(folder);
    out.watch.push({ path: folder, recursive: spec.recursive === true, label: asText(spec.label) || folder });
  });
  if (isObject(source.fields)) {
    for (const [name, spec] of Object.entries(source.fields)) {
      const key = asText(name);
      if (!key) continue;
      if (BUILTIN_FIELDS.includes(key)) {
        warnings.push("filing field " + key + " ignored: it is built in");
        continue;
      }
      const field = normalizeField(key, spec, warnings);
      if (field) out.fields[key] = field;
    }
  } else if (source.fields != null) {
    warnings.push("filing fields ignored: not an object");
  }
  const ids = new Set();
  (Array.isArray(source.rules) ? source.rules : []).forEach((raw, index) => {
    const rule = normalizeRule(raw, index, warnings, ids);
    if (rule) out.rules.push(rule);
  });
  if (source.fallback != null) {
    if (!isObject(source.fallback)) warnings.push("filing fallback ignored: not an object");
    else if (!validNameTemplate(source.fallback.name)) warnings.push("filing fallback ignored: `name` is missing or contains a path separator");
    else out.fallback = { id: "fallback", label: asText(source.fallback.label) || "Other documents", when: null, name: asText(source.fallback.name), folder: asText(source.fallback.folder) };
  }
  if (source.dateOrder != null) {
    if (DATE_ORDERS.includes(source.dateOrder)) out.dateOrder = source.dateOrder;
    else warnings.push("filing dateOrder ignored: must be dmy or mdy");
  }
  return out;
}

function monthIndex(name) {
  const lower = name.toLowerCase();
  return MONTHS.findIndex((month) => month === lower || month.slice(0, 3) === lower.slice(0, 3));
}

function validDate(year, month, day) {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day, iso: year + "-" + pad(month) + "-" + pad(day) };
}

/**
 * The first date written in the text, in ISO form. Recognises 2026-10-21,
 * 21.10.2026, 21/10/2026 (day first unless `order` is mdy), 21 October 2026
 * and October 21, 2026.
 */
function findDate(text, order) {
  const source = String(text == null ? "" : text);
  const mdy = order === "mdy";
  const month = "(" + MONTHS.map((m) => m.slice(0, 3)).join("|") + ")[a-z]*\\.?";
  const patterns = [
    { re: /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, make: (m) => validDate(+m[1], +m[2], +m[3]) },
    { re: /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/g, make: (m) => (mdy ? validDate(+m[3], +m[1], +m[2]) : validDate(+m[3], +m[2], +m[1])) },
    { re: new RegExp("(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+" + month + ",?\\s+(\\d{4})(?!\\d)", "gi"), make: (m) => validDate(+m[3], monthIndex(m[2]) + 1, +m[1]) },
    { re: new RegExp("\\b" + month + "\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)", "gi"), make: (m) => validDate(+m[3], monthIndex(m[1]) + 1, +m[2]) },
  ];
  let best = null;
  for (const { re, make } of patterns) {
    for (const match of source.matchAll(re)) {
      const found = make(match);
      if (found && (!best || match.index < best.index)) best = Object.assign({ index: match.index }, found);
    }
  }
  return best;
}

function findListValue(text, field) {
  const source = String(text);
  let best = null;
  const candidates = field.values.map((value) => [value, value]).concat(Object.entries(field.aliases));
  for (const [needle, value] of candidates) {
    const match = keywordPattern(needle, false).exec(source);
    if (match && (!best || match.index < best.index)) best = { index: match.index, value };
  }
  return best ? best.value : null;
}

function findPatternValue(text, field) {
  const match = new RegExp(field.pattern, "iu").exec(String(text));
  if (!match) return null;
  const value = field.group ? match[field.group] : match[0];
  return value == null ? null : String(value);
}

/**
 * Values for the blanks of a rule: built-ins (date, year, month, day,
 * original, ext) and the policy's fields found in the text. Blanks nothing
 * fills are listed in `missing` for the person to answer.
 */
function detectFields(file, filing, rule) {
  const haystack = haystackOf(file);
  const found = findDate(haystack, filing && filing.dateOrder);
  const fallbackDate = file && Number.isFinite(Number(file.modified)) ? new Date(Number(file.modified)) : new Date();
  const date = found || { year: fallbackDate.getFullYear(), month: fallbackDate.getMonth() + 1, day: fallbackDate.getDate(), iso: fallbackDate.getFullYear() + "-" + pad(fallbackDate.getMonth() + 1) + "-" + pad(fallbackDate.getDate()) };
  const ext = String(file && file.ext != null ? file.ext : "").replace(/^\.+/, "").toLowerCase();
  const original = String(file && file.name != null ? file.name : "").replace(/\.[^.]*$/, "");
  const values = { date: date.iso, year: String(date.year), month: pad(date.month), day: pad(date.day), original: cleanValue(original) || "document", ext };
  const sources = { date: found ? "text" : "file" };
  const wanted = new Set(template.fields(rule.name).concat(template.fields(rule.folder || "")).map((f) => f.name));
  const missing = [];
  for (const name of wanted) {
    if (Object.hasOwn(values, name)) continue;
    // Only fields the policy defined: a blank named like an Object member
    // ([[constructor]]) must not find the prototype's function.
    const field = filing && filing.fields && Object.hasOwn(filing.fields, name) ? filing.fields[name] : null;
    let value = null;
    if (field) {
      if (field.values.length || Object.keys(field.aliases).length) value = findListValue(haystack, field);
      if (value == null && field.pattern) value = findPatternValue(haystack, field);
    }
    // A value the scrubber would mask (a card number, a labelled secret, a
    // token) never becomes part of a file name, the index or the audit log:
    // the blank is left for the person to answer.
    if (value != null && cleanValue(value) && capture.scrub(String(value)).redactions === 0) {
      values[name] = cleanValue(value).slice(0, MAX_VALUE);
      sources[name] = "text";
    } else {
      missing.push(name);
    }
  }
  return { values, missing, sources };
}

/** The text plus the file name with its separators opened up, so "Invoice_0412.pdf" contains the word "invoice". */
function haystackOf(file) {
  const name = String(file && file.name != null ? file.name : "").replace(/[_.\-]+/g, " ");
  return String(file && file.text != null ? file.text : "") + "\n" + name;
}

function keywordHits(rule, haystack) {
  return rule.when.keywords.filter((keyword) => keywordPattern(keyword, rule.when.caseSensitive).test(haystack));
}

/**
 * The first rule, in policy order, whose conditions hold for the file; the
 * fallback when none does; null when the policy has no filing at all.
 * @returns {{rule:object, matched:string[], score:number}|null}
 */
function classify(file, filing) {
  if (!filing || (!filing.rules.length && !filing.fallback)) return null;
  const ext = String(file && file.ext != null ? file.ext : "").replace(/^\.+/, "").toLowerCase();
  const haystack = haystackOf(file);
  for (const rule of filing.rules) {
    if (rule.when.extensions.length && !rule.when.extensions.includes(ext)) continue;
    const matched = keywordHits(rule, haystack);
    const need = rule.when.keywords.length;
    if (need && !(rule.when.match === "all" ? matched.length === need : matched.length > 0)) continue;
    return { rule, matched, score: matched.length + (rule.when.extensions.length ? 1 : 0) };
  }
  return filing.fallback ? { rule: filing.fallback, matched: [], score: 0 } : null;
}

/** Fill a template with cleaned values; blanks without a value stay as [[name]]. */
function fillTemplate(text, values) {
  const clean = {};
  for (const [key, value] of Object.entries(values || {})) clean[key] = cleanValue(value);
  return template.fill(text, clean);
}

/**
 * Propose a name and folder for a file. `file` is {name, ext, text, modified}
 * as the shell read it. Values the person supplies (`answers`) win over
 * detected ones. The proposal says which blanks are still missing; a name
 * with missing blanks is not safe to apply yet.
 */
function propose(file, filing, answers) {
  const found = classify(file, filing);
  if (!found) return null;
  const { rule, matched, score } = found;
  const detected = detectFields(file, filing, rule);
  const values = Object.assign({}, detected.values);
  for (const [key, value] of Object.entries(answers || {})) {
    if (cleanValue(value) && capture.scrub(String(value)).redactions === 0) values[key] = cleanValue(value).slice(0, MAX_VALUE);
  }
  const missing = template.fields(rule.name).concat(template.fields(rule.folder || "")).map((f) => f.name).filter((name, index, all) => !Object.hasOwn(values, name) && all.indexOf(name) === index);
  const ext = String(file && file.ext != null ? file.ext : "");
  const filledName = fillTemplate(rule.name, values);
  const filledFolder = fillTemplate(rule.folder || "", values);
  return {
    rule: { id: rule.id, label: rule.label },
    matched,
    score,
    values,
    sources: detected.sources,
    missing,
    nameTemplate: rule.name,
    folderTemplate: rule.folder || "",
    name: missing.length ? filledName : safeName(filledName, ext),
    folder: filledFolder,
    ready: missing.length === 0,
  };
}

/** A name not in `exists`: "name (2).ext", "name (3).ext"... */
function uniqueName(name, exists) {
  if (typeof exists !== "function" || !exists(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 10000; n++) {
    const candidate = stem + " (" + n + ")" + ext;
    if (!exists(candidate)) return candidate;
  }
  return stem + " (" + Date.now() + ")" + ext;
}

// ---- Index of filed documents -------------------------------------------

function normalizeEntry(raw) {
  if (!isObject(raw)) return null;
  const path = asText(raw.path);
  if (!path) return null;
  const values = {};
  if (isObject(raw.values)) {
    for (const [key, value] of Object.entries(raw.values)) values[asText(key) || key] = asText(value);
  }
  return {
    id: asText(raw.id) || path,
    path,
    name: asText(raw.name) || path.replace(/\\/g, "/").split("/").pop(),
    folder: asText(raw.folder),
    originalPath: asText(raw.originalPath),
    originalName: asText(raw.originalName),
    rule: asText(raw.rule),
    ruleLabel: asText(raw.ruleLabel),
    values,
    filedAt: Number.isFinite(Number(raw.filedAt)) ? Number(raw.filedAt) : 0,
    ext: asText(raw.ext).toLowerCase(),
  };
}

function normalizeIndex(raw) {
  const source = isObject(raw) ? raw : {};
  const entries = (Array.isArray(source.entries) ? source.entries : []).map(normalizeEntry).filter(Boolean);
  return { version: 1, entries };
}

function addEntry(index, entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return index;
  const entries = index.entries.filter((e) => e.id !== normalized.id && e.path !== normalized.path);
  entries.push(normalized);
  return { version: 1, entries };
}

function removeEntry(index, id) {
  return { version: 1, entries: index.entries.filter((e) => e.id !== id) };
}

function scoreField(field, token) {
  const f = String(field == null ? "" : field).toLowerCase();
  if (!f) return 0;
  if (f === token) return 3;
  if (f.startsWith(token)) return 2;
  if (f.includes(token)) return 1;
  return 0;
}

/** Rank filed documents for a free-text query; every word must match something. */
function search(query, index, limit) {
  const tokens = asText(query).toLowerCase().split(/\s+/).filter(Boolean);
  const entries = index && Array.isArray(index.entries) ? index.entries : [];
  const out = [];
  for (const entry of entries) {
    const fields = [entry.name, entry.folder, entry.ruleLabel, entry.rule, entry.originalName, ...Object.values(entry.values)];
    let total = 0;
    let all = true;
    for (const token of tokens) {
      const best = Math.max(0, ...fields.map((f) => scoreField(f, token)));
      if (!best) {
        all = false;
        break;
      }
      total += best;
    }
    if (all) out.push({ score: tokens.length ? total : 1, entry });
  }
  out.sort((a, b) => b.score - a.score || b.entry.filedAt - a.entry.filedAt || a.entry.name.localeCompare(b.entry.name));
  return out.slice(0, Math.max(1, Math.floor(Number(limit) || 10)));
}

module.exports = {
  BUILTIN_FIELDS,
  DATE_ORDERS,
  MAX_NAME,
  normalizeFiling,
  cleanValue,
  safeName,
  findDate,
  detectFields,
  classify,
  propose,
  fillTemplate,
  blanksOf: (text) => template.fields(text).map((f) => f.name),
  uniqueName,
  normalizeIndex,
  addEntry,
  removeEntry,
  search,
};
