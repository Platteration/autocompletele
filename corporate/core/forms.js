// actle Forms: fill a whole form, not one field. In CRM, ERP, ticketing tools
// and internal portals the same dozen fields are filled together; a named
// record ("Refund case") sets category, priority, reply template, SLA and
// notes at once, and a local lookup list fills the customer fields from an
// order reference. Record values are [[blank]] templates, the same syntax as
// fill-in shortcuts. Pure and local: finding the fields in the accessibility
// tree and setting them is the shell's job.
"use strict";

const { expander, template } = require("./personal.js");
const capture = require("./capture-policy.js");
const detector = require("./variable-detector.js");

const DEFAULTS = Object.freeze({ minCount: 3, minFields: 2, limit: 20 });

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Field values are text; numbers and booleans are written as text; anything else has no text form. */
function scalar(value) {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

function section(source, name, warnings) {
  if (source[name] == null) return [];
  if (Array.isArray(source[name])) return source[name];
  warnings.push("forms " + name + " ignored: not a list");
  return [];
}

function uniqueId(raw, fallback, ids, warnings, kind) {
  let id = asText(raw) || fallback;
  if (ids.has(id)) warnings.push(kind + " " + id + " renamed: duplicate id");
  while (ids.has(id)) id += "-dup";
  ids.add(id);
  return id;
}

/** A key pattern only counts where it stands as a whole word: "A-123456" is not order "A-12345". */
function boundaryPattern(pattern) {
  return new RegExp("(?<![\\p{L}\\p{N}_])(?:" + pattern + ")(?![\\p{L}\\p{N}_])", "giu");
}

function normalizeRecord(raw, index, warnings, ids, triggers) {
  if (!isObject(raw)) {
    warnings.push("form record " + index + " ignored: not an object");
    return null;
  }
  const where = asText(raw.id) || "record-" + index;
  const fields = {};
  for (const [name, value] of Object.entries(isObject(raw.fields) ? raw.fields : {})) {
    const key = asText(name);
    const text = scalar(value);
    if (!key || text == null) warnings.push("form record " + where + " field " + (key || "(no name)") + " ignored: needs a name and a text value");
    else fields[key] = text;
  }
  if (!Object.keys(fields).length) {
    warnings.push("form record " + where + " ignored: no fields");
    return null;
  }
  const id = uniqueId(raw.id, "record-" + index, ids, warnings, "form record");
  const record = { id, label: asText(raw.label) || id, fields };
  const trigger = asText(raw.trigger);
  // The record stays usable from the picker; only the clashing trigger goes.
  if (trigger && triggers.has(trigger)) warnings.push("form record " + id + " trigger " + trigger + " ignored: duplicate trigger");
  else if (trigger) {
    triggers.add(trigger);
    record.trigger = trigger;
  }
  return record;
}

function normalizeLookup(raw, index, warnings, ids) {
  if (!isObject(raw)) {
    warnings.push("form lookup " + index + " ignored: not an object");
    return null;
  }
  const where = asText(raw.id) || "lookup-" + index;
  const key = asText(raw.key);
  if (!key) {
    warnings.push("form lookup " + where + " ignored: no key column");
    return null;
  }
  let keyPattern = null;
  if (raw.keyPattern != null) {
    try {
      // Compiled here exactly as lookup() uses it, so a bad pattern is a policy warning, not a crash on paste.
      boundaryPattern(asText(raw.keyPattern));
      keyPattern = asText(raw.keyPattern) || null;
    } catch (error) {
      warnings.push("form lookup " + where + " keyPattern ignored: invalid pattern (" + error.message + ")");
    }
  }
  const seen = new Set();
  const rows = [];
  (Array.isArray(raw.rows) ? raw.rows : []).forEach((row, rowIndex) => {
    const keyValue = isObject(row) ? asText(scalar(row[key])) : "";
    if (!keyValue) return warnings.push("form lookup " + where + " row " + rowIndex + " ignored: no " + key);
    if (seen.has(keyValue.toLowerCase())) return warnings.push("form lookup " + where + " row " + keyValue + " ignored: duplicate key");
    seen.add(keyValue.toLowerCase());
    const out = {};
    for (const [name, value] of Object.entries(row)) {
      if (asText(name) && scalar(value) != null) out[asText(name)] = scalar(value);
    }
    out[key] = keyValue;
    rows.push(out);
  });
  if (!rows.length) {
    warnings.push("form lookup " + where + " ignored: no rows");
    return null;
  }
  return { id: uniqueId(raw.id, "lookup-" + index, ids, warnings, "form lookup"), key, keyPattern, rows };
}

function normalizeForm(raw, index, warnings, ids) {
  if (!isObject(raw)) {
    warnings.push("form " + index + " ignored: not an object");
    return null;
  }
  const where = asText(raw.id) || "form-" + index;
  const match = isObject(raw.match) ? raw.match : {};
  const process = (Array.isArray(match.process) ? match.process : [match.process]).map(capture.baseName).filter(Boolean);
  const title = asText(match.title);
  // A form with no condition would match every window, and its selectors would be tried everywhere.
  if (!process.length && !title) {
    warnings.push("form " + where + " ignored: `match` needs a title or a process");
    return null;
  }
  if (title) {
    try {
      new RegExp(title, "iu");
    } catch (error) {
      warnings.push("form " + where + " ignored: invalid title pattern (" + error.message + ")");
      return null;
    }
  }
  const names = new Set();
  const fields = [];
  (Array.isArray(raw.fields) ? raw.fields : []).forEach((field, fieldIndex) => {
    const name = isObject(field) ? asText(field.name) : "";
    const selector = isObject(field) ? asText(field.selector) : "";
    if (!name || !selector) return warnings.push("form " + where + " field " + (name || fieldIndex) + " ignored: needs a name and a selector");
    if (names.has(name)) return warnings.push("form " + where + " field " + name + " ignored: duplicate name");
    names.add(name);
    fields.push({ name, label: asText(field.label) || name, selector });
  });
  if (!fields.length) {
    warnings.push("form " + where + " ignored: no fields");
    return null;
  }
  const id = uniqueId(raw.id, "form-" + index, ids, warnings, "form");
  return { id, label: asText(raw.label) || id, match: { title, process }, fields };
}

/**
 * Validate the `forms` section of a policy: {records, lookups, forms}.
 * Unusable parts are dropped with a warning; the section is never refused.
 */
function normalizeForms(raw) {
  const warnings = [];
  const out = { records: [], lookups: [], forms: [], warnings };
  if (raw != null && !isObject(raw)) warnings.push("forms section ignored: not an object");
  const source = isObject(raw) ? raw : {};
  const [recordIds, triggers, lookupIds, formIds] = [new Set(), new Set(), new Set(), new Set()];
  out.records = section(source, "records", warnings).map((r, i) => normalizeRecord(r, i, warnings, recordIds, triggers)).filter(Boolean);
  out.lookups = section(source, "lookups", warnings).map((l, i) => normalizeLookup(l, i, warnings, lookupIds)).filter(Boolean);
  out.forms = section(source, "forms", warnings).map((f, i) => normalizeForm(f, i, warnings, formIds)).filter(Boolean);
  return out;
}

/** The record whose trigger ends at the caret, under the same boundary rule as text shortcuts. */
function findRecord(textBeforeCaret, config) {
  const records = (config && Array.isArray(config.records) ? config.records : []).filter((r) => r.trigger);
  const match = expander.findMatch(textBeforeCaret, records.map((r) => ({ trigger: r.trigger, expansion: "" })));
  return match ? { record: records.find((r) => r.trigger === match.shorthand.trigger), start: match.start } : null;
}

/** The first form whose process and title conditions both hold for the focused window. */
function findForm(context, config) {
  const ctx = isObject(context) ? context : {};
  const process = capture.baseName(ctx.process);
  const title = String(ctx.title == null ? "" : ctx.title);
  for (const form of config && Array.isArray(config.forms) ? config.forms : []) {
    if (form.match.process.length && !form.match.process.includes(process)) continue;
    if (form.match.title && !new RegExp(form.match.title, "iu").test(title)) continue;
    return form;
  }
  return null;
}

function hit(list, via, key) {
  for (const lookup of list) {
    const row = lookup.rows.find((r) => r[lookup.key].toLowerCase() === key.toLowerCase());
    if (row) return { lookup: lookup.id, key: row[lookup.key], row: Object.assign({}, row), via };
  }
  return null;
}

/**
 * The lookup row for a key typed or pasted: an exact key (any case) first,
 * then a key pattern found inside longer text ("Re: order A-12345 late").
 * @returns {{lookup:string, key:string, row:object, via:"exact"|"pattern"}|null}
 */
function lookup(value, config) {
  const text = String(value == null ? "" : value);
  const lookups = config && Array.isArray(config.lookups) ? config.lookups : [];
  if (!text.trim()) return null;
  const exact = hit(lookups, "exact", text.trim());
  if (exact) return exact;
  for (const entry of lookups) {
    if (!entry.keyPattern) continue;
    for (const match of text.matchAll(boundaryPattern(entry.keyPattern))) {
      const found = hit([entry], "pattern", match[0]);
      if (found) return found;
    }
  }
  return null;
}

function cleanValues(values) {
  const out = {};
  for (const [name, value] of Object.entries(isObject(values) ? values : {})) {
    if (scalar(value) != null) out[name] = scalar(value);
  }
  return out;
}

/**
 * The field values to set, in the form's field order. A record's value wins
 * for the fields it names, with its blanks filled from `context.values` (a
 * lookup row merged with the person's answers); a field the record leaves
 * out is filled straight from `context.values` when it has one. Blanks
 * nothing answers stay as [[name]] and are listed; record fields the form
 * does not have are reported as `skipped`. Only a `ready` plan is safe to apply.
 */
function plan(record, form, context) {
  const values = cleanValues(context && context.values);
  const fields = record && isObject(record.fields) ? record.fields : {};
  const formFields = form && Array.isArray(form.fields) ? form.fields : [];
  const steps = [];
  for (const field of formFields) {
    if (Object.hasOwn(fields, field.name)) {
      const text = fields[field.name];
      const missing = template.fields(text).map((f) => f.name).filter((name) => !Object.hasOwn(values, name));
      steps.push({ field: field.name, label: field.label, selector: field.selector, value: template.fill(text, values), missing, source: "record" });
    } else if (Object.hasOwn(values, field.name)) {
      steps.push({ field: field.name, label: field.label, selector: field.selector, value: values[field.name], missing: [], source: "values" });
    }
  }
  const names = new Set(formFields.map((f) => f.name));
  const missing = [...new Set(steps.flatMap((step) => step.missing))];
  return {
    record: record ? record.id : null,
    form: form ? form.id : null,
    steps,
    skipped: Object.keys(fields).filter((name) => !names.has(name)),
    missing,
    ready: steps.length > 0 && missing.length === 0,
  };
}

/** A session's non-empty values; values the scrubber would mask (card numbers, tokens, labelled secrets) never become a proposal. */
function sessionValues(values) {
  const out = {};
  for (const [name, value] of Object.entries(isObject(values) ? values : {})) {
    const text = asText(scalar(value));
    if (asText(name) && text && capture.scrub(text).redactions === 0) out[asText(name)] = text;
  }
  return out;
}

/**
 * Propose records from form sessions [{form, values:{field:value}}]: sets of
 * at least `minFields` field=value pairs filled together in at least
 * `minCount` sessions of one form, each as large as those sessions share.
 * A field present in every supporting session whose values differ only in
 * places (a name in a note) becomes a [[blank]] template through the variable
 * detector. Deterministic: same sessions, same proposals.
 */
function learnFieldSets(sessions, options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const minCount = Math.max(2, Math.floor(Number(settings.minCount) || DEFAULTS.minCount));
  const minFields = Math.max(1, Math.floor(Number(settings.minFields) || DEFAULTS.minFields));
  const byForm = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const form = isObject(session) ? asText(session.form) : "";
    if (!form) continue;
    if (!byForm.has(form)) byForm.set(form, []);
    byForm.get(form).push(sessionValues(session.values));
  }
  const proposals = [];
  for (const [form, list] of byForm) {
    const counts = new Map();
    const pairsOf = list.map((values) => Object.entries(values).map((pair) => JSON.stringify(pair)));
    for (const pairs of pairsOf) for (const pair of pairs) counts.set(pair, (counts.get(pair) || 0) + 1);
    const candidates = new Map();
    for (const pairs of pairsOf) {
      const frequent = pairs.filter((pair) => counts.get(pair) >= minCount).sort();
      if (frequent.length >= minFields) candidates.set(frequent.join("\n"), frequent);
    }
    // Each candidate is one session's whole frequent set, so a smaller candidate always has
    // more support than a larger one containing it: every candidate is already maximal.
    const found = [...candidates.values()].map((pairs) => ({
      pairs,
      support: pairsOf.map((p, i) => (pairs.every((pair) => p.includes(pair)) ? i : -1)).filter((i) => i >= 0),
    })).filter((c) => c.support.length >= minCount);
    for (const c of found) {
      const fields = {};
      const constant = [];
      for (const [name, value] of c.pairs.map((pair) => JSON.parse(pair))) {
        // Typed text stays literal: a typed "[[x]]" must not turn into a blank.
        fields[name] = detector.escapeLiteral(value);
        constant.push(name);
      }
      const templated = [];
      const rest = Object.keys(list[c.support[0]]).filter((name) => !constant.includes(name) && c.support.every((i) => Object.hasOwn(list[i], name)));
      for (const name of rest.sort()) {
        const detected = detector.detect(c.support.map((i) => list[i][name]));
        if (detected) {
          fields[name] = detected.template;
          templated.push(name);
        }
      }
      const short = constant.map((name) => list[c.support[0]][name]).filter((v) => v.length <= 40).slice(0, 2);
      proposals.push({ form, label: short.join(" / ") || constant.join(", "), count: c.support.length, fields, constant, templated });
    }
  }
  proposals.sort((a, b) => b.count - a.count || b.constant.length - a.constant.length || a.form.localeCompare(b.form) || a.label.localeCompare(b.label));
  return proposals.slice(0, Math.max(1, Math.floor(Number(settings.limit) || DEFAULTS.limit)))
    .map((p, i) => Object.assign({ id: "learned-" + (i + 1) }, p));
}

module.exports = { DEFAULTS, normalizeForms, findRecord, findForm, lookup, plan, learnFieldSets };
