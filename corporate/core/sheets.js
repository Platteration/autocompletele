// extle core: column-aware completion for spreadsheet cells. A
// column bound to a controlled vocabulary (customers,
// cost centres, product codes) completes to the organisation's one spelling,
// and a strict one to nothing else (checkColumn lists the cells that differ);
// other columns complete from their own values, notes columns from recurring
// sentences; a `/` trigger inserts an approved formula or block of rows. Pure:
// reading cells and writing them back is the Excel / Google Sheets add-in's job.
"use strict";

const { expander } = require("./personal.js");
const { normalize, splitSentences } = require("./phrase-miner.js");
const policyPattern = require("./policy-pattern.js");
// Column rules see a header or sheet name, never more than this.
const NAME_MAX = 200;

const KINDS = Object.freeze(["label", "notes", "number", "date"]);
const DEFAULTS = Object.freeze({
  limit: 8,
  minSubstring: 2,        // one letter found anywhere matches almost everything
  share: 0.8,             // share of cells that makes a column numbers or dates
  notesShare: 0.5,        // share of text cells that are long before a column counts as notes
  labelMaxWords: 6,
  labelMaxLength: 60,
  minSentenceWords: 3,
  minSentenceCount: 2,    // a notes sentence must recur in two cells before it is offered
  maxDistinct: 2000,      // a column of a million IDs must not become a million suggestions
  maxValueLength: 500,
  maxBlockCells: 10000,
});
const NUMBER = /^[-+]?(?:\d{1,3}(?:[ ,.']\d{3})+|\d+)(?:[.,]\d+)?\s?%?$|^[-+]?[.,]\d+$/;
const DATE = /^(?:\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2}))$/;

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fold(value) {
  return normalize(value).toLowerCase();
}

/**
 * A value that Excel and Google Sheets would evaluate as a formula when the
 * add-in writes it into a cell (= + - @, tab, carriage return), unless it is
 * a plain signed number. Stops a vocabulary or column value from injecting a
 * formula into every sheet it is completed into. The full-width forms
 * ＝ ＋ － ＠ (U+FF1D, U+FF0B, U+FF0D, U+FF20) count too, with no number
 * exception: whether a host evaluates them is unconfirmed, so they are kept
 * out of cells the same way.
 */
function formulaLike(value) {
  const text = String(value);
  if (/^[\uFF1D\uFF0B\uFF0D\uFF20]/.test(text)) return true;
  return /^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(?:[.,]\d+)?$/.test(text);
}

/**
 * The first text cell of a block's rows that is formulaLike, 1-based, with
 * its first character; null when there is none. Numbers and booleans are
 * written in the general format and never read as a formula.
 */
function formulaCell(rows) {
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const cell = rows[r][c];
      if (typeof cell === "string" && formulaLike(cell)) return { row: r + 1, column: c + 1, first: cell[0] };
    }
  }
  return null;
}

/** Collects one vocabulary: case-insensitive duplicates and conflicting aliases are warned and skipped. */
function vocabularyBuilder(warnings) {
  const values = [];
  const aliases = {};
  const byKey = new Map();
  const aliasKeys = new Map();
  return {
    value(raw, where) {
      const value = normalize(raw);
      if (!value) return warnings.push(where + ": empty value ignored"), null;
      if (formulaLike(value)) return warnings.push(where + ": value " + JSON.stringify(value) + " ignored: a cell would read it as a formula"), null;
      const key = value.toLowerCase();
      const known = byKey.get(key);
      if (known && known !== value) warnings.push(where + ": " + JSON.stringify(value) + " is spelled differently from " + JSON.stringify(known) + "; kept the first spelling");
      if (known) return known;
      byKey.set(key, value);
      values.push(value);
      return value;
    },
    alias(raw, target, where) {
      const alias = normalize(raw);
      const canonical = byKey.get(fold(target));
      if (!alias || !canonical) return warnings.push(where + ": alias " + JSON.stringify(alias) + " ignored: " + (alias ? "its value " + JSON.stringify(normalize(target)) + " is not in the vocabulary" : "empty")), null;
      const key = alias.toLowerCase();
      if (byKey.has(key) && byKey.get(key) !== canonical) return warnings.push(where + ": alias " + JSON.stringify(alias) + " ignored: it is another value"), null;
      if (aliasKeys.has(key) && aliasKeys.get(key) !== canonical) return warnings.push(where + ": alias " + JSON.stringify(alias) + " ignored: it already means " + JSON.stringify(aliasKeys.get(key))), null;
      aliasKeys.set(key, canonical);
      aliases[alias] = canonical;
      return alias;
    },
    done: () => ({ values, aliases }),
  };
}

function normalizeVocabulary(name, raw, warnings) {
  const spec = Array.isArray(raw) ? { values: raw } : isObject(raw) ? raw : null;
  if (!spec || !Array.isArray(spec.values)) return warnings.push("sheets vocabulary " + name + " ignored: needs a values list"), null;
  const builder = vocabularyBuilder(warnings);
  const where = "sheets vocabulary " + name;
  spec.values.forEach((value) => builder.value(value, where));
  if (isObject(spec.aliases)) for (const [alias, target] of Object.entries(spec.aliases)) builder.alias(alias, target, where);
  else if (spec.aliases != null) warnings.push(where + ": aliases ignored: not an object");
  const vocabulary = builder.done();
  if (!vocabulary.values.length) return warnings.push(where + " ignored: no usable values"), null;
  return vocabulary;
}

function normalizeColumn(raw, index, vocabularies, warnings) {
  const where = "sheets column " + index;
  if (!isObject(raw) || !isObject(raw.match)) return warnings.push(where + " ignored: needs a match object"), null;
  const match = {};
  for (const part of ["header", "sheet"]) {
    if (raw.match[part] == null) continue;
    const pattern = asText(raw.match[part]);
    // Checked here so a bad or backtracking pattern is a policy warning, not a hung pane while typing.
    const refused = policyPattern.check(pattern, "iu");
    if (refused) return warnings.push(where + " ignored: " + (refused.startsWith("invalid pattern") ? "invalid " + part + " pattern" + refused.slice("invalid pattern".length) : part + " pattern refused: " + refused)), null;
    match[part] = pattern;
  }
  if (!match.header && !match.sheet) return warnings.push(where + " ignored: match needs a header or sheet pattern"), null;
  const vocabulary = asText(raw.vocabulary);
  const kind = asText(raw.kind);
  if (!!vocabulary === !!kind) return warnings.push(where + " ignored: give a vocabulary or a kind, not " + (vocabulary ? "both" : "neither")), null;
  if (vocabulary && !Object.hasOwn(vocabularies, vocabulary)) return warnings.push(where + " ignored: unknown vocabulary " + vocabulary), null;
  if (kind && !KINDS.includes(kind)) return warnings.push(where + " ignored: kind must be one of " + KINDS.join(", ")), null;
  // strict: the column takes only the vocabulary's values. The flag is dropped, not the rule, when it cannot apply.
  let strict = false;
  if (raw.strict != null && typeof raw.strict !== "boolean") warnings.push(where + ": strict ignored: give true or false");
  else if (raw.strict === true && !vocabulary) warnings.push(where + ": strict ignored: only a vocabulary column can be strict");
  else strict = raw.strict === true;
  if (!vocabulary) return { match, kind };
  return strict ? { match, vocabulary, strict } : { match, vocabulary };
}

function normalizeBlock(raw, index, seen, warnings) {
  const trigger = isObject(raw) ? asText(raw.trigger) : "";
  const where = "sheets block " + (trigger || index);
  if (!isObject(raw)) return warnings.push(where + " ignored: not an object"), null;
  // A trigger without "/" would fire on ordinary words typed into cells.
  if (!/^\/\S+$/.test(trigger)) return warnings.push(where + " ignored: trigger must start with / and contain no spaces"), null;
  if (seen.has(trigger)) return warnings.push(where + " ignored: duplicate trigger"), null;
  const label = asText(raw.label) || trigger;
  if (raw.formula != null && raw.rows != null) return warnings.push(where + " ignored: give rows or a formula, not both"), null;
  if (raw.formula != null) {
    const formula = asText(raw.formula);
    if (!formula.startsWith("=") || formula.length < 2) return warnings.push(where + " ignored: a formula starts with ="), null;
    seen.add(trigger);
    return { trigger, label, formula };
  }
  const rows = Array.isArray(raw.rows) ? raw.rows.filter(Array.isArray) : [];
  if (!rows.length || (raw.rows.length !== rows.length)) return warnings.push(where + " ignored: rows must be a list of rows (lists of cells)"), null;
  // More rows than cells allowed is refused before any row is looked at, and the
  // width is folded rather than spread: a block of a few hundred thousand rows
  // must become a warning, not a RangeError that stops the policy from loading.
  if (rows.length > DEFAULTS.maxBlockCells) return warnings.push(where + " ignored: more than " + DEFAULTS.maxBlockCells + " cells"), null;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!width || rows.length * width > DEFAULTS.maxBlockCells) return warnings.push(where + " ignored: " + (width ? "more than " + DEFAULTS.maxBlockCells + " cells" : "every row is empty")), null;
  if (rows.some((row) => row.some((cell) => cell != null && !["string", "number", "boolean"].includes(typeof cell)))) return warnings.push(where + " ignored: cells must be text, numbers or booleans"), null;
  // Rows are written as values, which a host may evaluate as a formula; the
  // `formula` field is the one way to write a formula, and its text is shown.
  const formula = formulaCell(rows);
  if (formula) return warnings.push(where + " ignored: the cell in row " + formula.row + ", column " + formula.column + " starts with " + JSON.stringify(formula.first) + ", which a cell would read as a formula"), null;
  seen.add(trigger);
  // Ragged rows are padded: a range is written as a rectangle.
  return { trigger, label, rows: rows.map((row) => Array.from({ length: width }, (_, i) => (row[i] == null ? "" : row[i]))) };
}

/**
 * Validate the `sheets` section of a policy. Unusable vocabularies, columns
 * and blocks are dropped with a warning; the section is never refused.
 */
function normalizeSheets(raw) {
  const warnings = [];
  const out = { vocabularies: {}, columns: [], blocks: [], warnings };
  if (raw != null && !isObject(raw)) warnings.push("sheets section ignored: not an object");
  const source = isObject(raw) ? raw : {};
  if (isObject(source.vocabularies)) {
    for (const [name, spec] of Object.entries(source.vocabularies)) {
      const vocabulary = asText(name) && normalizeVocabulary(asText(name), spec, warnings);
      if (vocabulary) out.vocabularies[asText(name)] = vocabulary;
    }
  } else if (source.vocabularies != null) warnings.push("sheets vocabularies ignored: not an object");
  for (const key of ["columns", "blocks"]) if (source[key] != null && !Array.isArray(source[key])) warnings.push("sheets " + key + " ignored: not a list");
  (Array.isArray(source.columns) ? source.columns : []).forEach((rawColumn, index) => {
    const column = normalizeColumn(rawColumn, index, out.vocabularies, warnings);
    if (column) out.columns.push(column);
  });
  const seen = new Set();
  (Array.isArray(source.blocks) ? source.blocks : []).forEach((rawBlock, index) => {
    const block = normalizeBlock(rawBlock, index, seen, warnings);
    if (block) out.blocks.push(block);
  });
  return out;
}

/** The first column rule, in policy order, whose header and sheet patterns both hold; null when none does. */
function columnFor(header, sheet, config) {
  const columns = config && Array.isArray(config.columns) ? config.columns : [];
  return columns.find((column) => ["header", "sheet"].every((part) => column.match[part] == null || policyPattern.test(column.match[part], "iu", asText(part === "header" ? header : sheet), NAME_MAX))) || null;
}

function cellKind(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : "date";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : null;
  const text = normalize(value);
  if (!text) return null;
  if (NUMBER.test(text)) return "number";
  if (DATE.test(text)) return "date";
  return text.length > DEFAULTS.labelMaxLength || text.split(" ").length > DEFAULTS.labelMaxWords ? "notes" : "label";
}

/** Count case-insensitively; the most frequent spelling is the one shown, then the first seen. */
function tally(table, value) {
  const key = value.toLowerCase();
  let entry = table.get(key);
  if (!entry) table.set(key, (entry = { count: 0, spellings: new Map() }));
  entry.count++;
  entry.spellings.set(value, (entry.spellings.get(value) || 0) + 1);
}

function ranked(table, minCount) {
  const out = [];
  for (const entry of table.values()) {
    if (entry.count < minCount) continue;
    let best = null;
    for (const [value, n] of entry.spellings) if (!best || n > best[1]) best = [value, n];
    out.push({ value: best[0], count: entry.count });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, DEFAULTS.maxDistinct);
}

/**
 * Learn a column from the values already in it: its kind (number, date,
 * label, notes or empty), the distinct values with counts, and the sentences
 * that recur across notes cells. Values a cell would read as a formula are
 * counted for the kind but never offered.
 */
function createColumnProfile(values) {
  const counts = { number: 0, date: 0, label: 0, notes: 0 };
  const distinct = new Map();
  const sentences = new Map();
  for (const raw of Array.isArray(values) ? values : []) {
    const kind = cellKind(raw);
    if (!kind) continue;
    counts[kind]++;
    // Numbers are kept too: a column rule may declare a column of numeric codes a label column.
    const text = raw instanceof Date ? "" : normalize(raw);
    if (!text || text.length > DEFAULTS.maxValueLength || formulaLike(text)) continue;
    tally(distinct, text);
    if (kind !== "label" && kind !== "notes") continue;
    // Counted once per cell, so a sentence repeated inside one note does not recur.
    const seen = new Set();
    for (const sentence of splitSentences(text)) {
      if (sentence.split(" ").length < DEFAULTS.minSentenceWords || formulaLike(sentence) || seen.has(sentence.toLowerCase())) continue;
      seen.add(sentence.toLowerCase());
      tally(sentences, sentence);
    }
  }
  const total = counts.number + counts.date + counts.label + counts.notes;
  const text = counts.label + counts.notes;
  let kind = "empty";
  if (total && counts.number >= total * DEFAULTS.share) kind = "number";
  else if (total && counts.date >= total * DEFAULTS.share) kind = "date";
  else if (text && counts.notes >= text * DEFAULTS.notesShare) kind = "notes";
  else if (total) kind = "label";
  return { kind, total, counts, distinct: ranked(distinct, 1), sentences: ranked(sentences, DEFAULTS.minSentenceCount) };
}

function matchType(candidate, query) {
  const lower = candidate.toLowerCase();
  if (lower.startsWith(query)) return "prefix";
  return query.length >= DEFAULTS.minSubstring && lower.includes(query) ? "substring" : null;
}

/**
 * Ranked completions for the text typed in a cell. Vocabulary values come
 * first (an alias completes to the canonical spelling), then the column's own
 * values by frequency; within each, prefix matches before substring matches.
 * In a notes column only the sentence being typed is completed, from
 * sentences that recur; number and date columns complete from the vocabulary
 * only. `start` is where the completion replaces the typed text. With
 * `strict` (a strict vocabulary column) only the vocabulary's values are
 * offered, for the whole cell; the column's own values only count towards them.
 * context: { vocabulary: name|{values,aliases}, profile, config, kind, strict, limit }
 */
function complete(prefix, context) {
  const ctx = context || {};
  const typed = String(prefix == null ? "" : prefix);
  const strict = ctx.strict === true;
  const kind = KINDS.includes(ctx.kind) ? ctx.kind : ctx.profile && ctx.profile.kind;
  let start = 0;
  if (kind === "notes" && !strict) {
    const ends = [...typed.matchAll(/[.!?]+["'”’)]*\s+/g)];
    if (ends.length) start = ends[ends.length - 1].index + ends[ends.length - 1][0].length;
  }
  const raw = normalize(typed.slice(start));
  const query = raw.toLowerCase();
  if (!query) return [];
  const vocabularies = ctx.config && isObject(ctx.config.vocabularies) ? ctx.config.vocabularies : {};
  const named = typeof ctx.vocabulary === "string";
  const vocabulary = named ? (Object.hasOwn(vocabularies, ctx.vocabulary) ? vocabularies[ctx.vocabulary] : null) : ctx.vocabulary;
  const learned = !ctx.profile ? [] : kind === "notes" ? ctx.profile.sentences || [] : kind === "label" ? ctx.profile.distinct || [] : [];
  const frequency = new Map(learned.map((entry) => [entry.value.toLowerCase(), entry.count]));
  const covered = new Set();
  const rank = (c) => (c.source === "vocabulary" ? 0 : 2) + (c.match === "prefix" ? 0 : 1);
  const out = new Map();
  const offer = (value, source, match, alias) => {
    const candidate = Object.assign({ value, source, match, count: frequency.get(value.toLowerCase()) || 0, start }, alias ? { alias } : {});
    const known = out.get(value.toLowerCase());
    if (value !== raw && (!known || rank(candidate) < rank(known))) out.set(value.toLowerCase(), candidate);
  };
  if (vocabulary && Array.isArray(vocabulary.values)) {
    const canonical = new Map(vocabulary.values.map((value) => [value.toLowerCase(), value]));
    const aliases = Object.entries(isObject(vocabulary.aliases) ? vocabulary.aliases : {}).filter(([, value]) => canonical.has(String(value).toLowerCase()));
    // A column value that is another spelling or an alias of a vocabulary value counts towards it, and is not offered itself.
    for (const key of canonical.keys()) covered.add(key);
    for (const [alias, value] of aliases) {
      const key = alias.toLowerCase();
      if (!canonical.has(key) && frequency.has(key)) frequency.set(value.toLowerCase(), (frequency.get(value.toLowerCase()) || 0) + frequency.get(key));
      covered.add(key);
    }
    for (const value of vocabulary.values) {
      const match = matchType(value, query);
      if (match) offer(value, "vocabulary", match);
    }
    for (const [alias, value] of aliases) {
      const match = matchType(alias, query);
      if (match) offer(canonical.get(value.toLowerCase()), "vocabulary", match, alias);
    }
  }
  for (const entry of strict ? [] : learned) {
    const match = covered.has(entry.value.toLowerCase()) ? null : matchType(entry.value, query);
    if (match) offer(entry.value, "column", match);
  }
  const limit = Math.max(1, Math.floor(Number(ctx.limit) || DEFAULTS.limit));
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.value.localeCompare(b.value)).slice(0, limit);
}

/**
 * The block or formula whose trigger ends at the caret, under the same
 * boundary rule as text shortcuts. @returns {{block:object, start:number}|null}
 */
function blockFor(textBeforeCaret, config) {
  const blocks = config && Array.isArray(config.blocks) ? config.blocks : [];
  const match = expander.findMatch(String(textBeforeCaret == null ? "" : textBeforeCaret), blocks.map((b) => ({ trigger: b.trigger, expansion: "" })));
  if (!match) return null;
  const block = blocks.find((b) => b.trigger === match.shorthand.trigger);
  return block ? { block, start: match.start } : null;
}

/** Split CSV text into records with their first line number; quotes may hold commas, quotes and newlines. */
function parseCsv(text) {
  const source = String(text == null ? "" : text).replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/).find((line) => line.trim()) || "";
  const delimiter = [",", ";", "\t"].find((d) => firstLine.includes(d)) || ",";
  const records = [];
  let fields = [""];
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') fields[fields.length - 1] += '"', i++;
      else if (ch === '"') quoted = false;
      else fields[fields.length - 1] += ch, line += ch === "\n" ? 1 : 0;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) fields.push("");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      records.push({ line: startLine, fields });
      fields = [""];
      startLine = ++line;
    } else fields[fields.length - 1] += ch;
  }
  records.push({ line: startLine, fields, unterminated: quoted });
  return records;
}

/**
 * A vocabulary from CSV: one column (value) or two (value, alias). An
 * optional header row "value" / "value,alias" is skipped; bad lines are
 * skipped with a warning naming the line. Comma, semicolon and tab
 * separators are recognised from the first line.
 */
function importCsv(text) {
  const warnings = [];
  const builder = vocabularyBuilder(warnings);
  parseCsv(text).forEach((record, index) => {
    const where = "line " + record.line;
    if (record.unterminated) return warnings.push(where + ": ignored with every line after it: unterminated quote");
    const fields = record.fields.map(asText);
    if (fields.every((field) => !field)) return;
    if (index === 0 && /^value$/i.test(fields[0]) && (fields.length === 1 || /^alias$/i.test(fields[1]))) return;
    if (fields.length > 2) return warnings.push(where + ": ignored: more than two columns");
    if (/[\r\n]/.test(fields.join(""))) return warnings.push(where + ": ignored: a value spans several lines");
    const value = builder.value(fields[0], where);
    if (value && fields[1]) builder.alias(fields[1], value, where);
  });
  return Object.assign(builder.done(), { warnings });
}

/**
 * Everything the add-in and the dashboard's "Try it" need for one cell: the
 * column rule, the column's learned profile (counts only), the completions
 * for the text typed, and the block or formula whose trigger ends at the
 * caret. input: { header, sheet, text, values (a list, or text one per line), limit }
 */
function suggest(input, config) {
  const given = isObject(input) ? input : {};
  const values = Array.isArray(given.values) ? given.values : String(given.values == null ? "" : given.values).split(/\r?\n/);
  const column = columnFor(given.header, given.sheet, config);
  const profile = createColumnProfile(values);
  const text = String(given.text == null ? "" : given.text);
  const context = { profile, config, limit: given.limit, strict: !!(column && column.strict) };
  if (column) context[column.vocabulary ? "vocabulary" : "kind"] = column.vocabulary || column.kind;
  const hit = blockFor(text, config);
  return {
    column,
    profile: { kind: profile.kind, total: profile.total, counts: profile.counts, distinct: profile.distinct.length, sentences: profile.sentences.length },
    completions: complete(text, context),
    block: hit ? Object.assign({ start: hit.start }, hit.block) : null,
  };
}

/**
 * Compare a column's cells with a vocabulary, for a strict column. A cell is
 * canonical when its text is exactly a vocabulary value. A cell that is a
 * value in other capitals or spacing, or an alias, is a fix: `value` is the
 * vocabulary's spelling. Anything else is unknown. Blank cells are skipped.
 * cells: [{ row, text }] in row order; vocabulary: { values, aliases }.
 * @returns {{checked:number, canonical:number, fixes:{row:number,text:string,value:string,alias:boolean}[], unknown:{row:number,text:string}[]}}
 */
function checkColumn(cells, vocabulary) {
  const values = vocabulary && Array.isArray(vocabulary.values) ? vocabulary.values : [];
  const canonical = new Map(values.map((value) => [value.toLowerCase(), value]));
  const aliases = new Map();
  for (const [alias, value] of Object.entries(vocabulary && isObject(vocabulary.aliases) ? vocabulary.aliases : {})) {
    if (canonical.has(String(value).toLowerCase())) aliases.set(fold(alias), canonical.get(String(value).toLowerCase()));
  }
  const out = { checked: 0, canonical: 0, fixes: [], unknown: [] };
  for (const cell of Array.isArray(cells) ? cells : []) {
    const text = String(cell && cell.text != null ? cell.text : "");
    const key = fold(text);
    if (!key) continue;
    out.checked++;
    if (canonical.get(key) === text) out.canonical++;
    else if (canonical.has(key)) out.fixes.push({ row: cell.row, text, value: canonical.get(key), alias: false });
    else if (aliases.has(key)) out.fixes.push({ row: cell.row, text, value: aliases.get(key), alias: true });
    else out.unknown.push({ row: cell.row, text });
  }
  return out;
}

/** The section as the add-in takes it: the three lists and nothing else. A parsed section comes back unchanged. */
function exportConfig(section) {
  const config = normalizeSheets(section);
  return JSON.parse(JSON.stringify({ vocabularies: config.vocabularies, columns: config.columns, blocks: config.blocks }));
}

/**
 * Read a configuration pasted into the add-in: an exported section, a whole
 * policy file (its `sheets` section is used), or the JSON text of either.
 * Bad JSON is a warning and an empty configuration, never a throw.
 */
function parseConfig(input) {
  const warnings = [];
  let source = input;
  if (typeof input === "string") {
    try {
      source = input.trim() ? JSON.parse(input) : undefined;
    } catch (error) {
      warnings.push("configuration is not valid JSON: " + error.message);
      source = undefined;
    }
  }
  if (isObject(source) && isObject(source.sheets) && !["vocabularies", "columns", "blocks"].some((key) => key in source)) source = source.sheets;
  const config = normalizeSheets(source);
  warnings.push(...config.warnings);
  delete config.warnings;
  return { config, warnings };
}

/** Organisation items a usage report may name: the block and formula triggers. */
function organizationItems(section) {
  return (section && Array.isArray(section.blocks) ? section.blocks : []).map((block) => ({ trigger: block.trigger, kind: "block" }));
}

module.exports = { KINDS, DEFAULTS, normalizeSheets, columnFor, createColumnProfile, complete, blockFor, importCsv, formulaLike, suggest, checkColumn, exportConfig, parseConfig, organizationItems };
