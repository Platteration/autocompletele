// Data-backed lookups: "/cust 12345 " inserts a block rendered from the row
// whose key is 12345 in a data source the organisation ships (a CSV or JSON
// file on a share, or an https address). Sources are cached as plain JSON:
// they are organisation reference data already given to the desk in the
// clear, and sealing them with the learning key would make lookups fail on
// desks without a keychain while protecting nothing the source does not.
"use strict";

const { expander, template } = require("./personal.js");
const { sha256 } = require("./policy-signing.js");
const { MIN_REFRESH_MINUTES, MAX_REFRESH_MINUTES } = require("./policy-source.js");

const KINDS = Object.freeze(["csv", "json"]);
const DEFAULTS = Object.freeze({ refreshMinutes: 60, timeoutMs: 15000, maxBytes: 5 * 1024 * 1024, maxRows: 50000, maxArgument: 64 });

function asText(value) {
  return String(value == null ? "" : value).trim();
}

/** Validate the policy's `lookups` list; unusable entries are skipped with a warning. */
function normalizeLookups(list) {
  const warnings = [];
  const lookups = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      warnings.push("lookup " + index + " ignored: not an object");
      return;
    }
    const trigger = asText(raw.trigger);
    const where = trigger || "lookup " + index;
    if (!trigger || /\s/.test(trigger)) {
      warnings.push(where + " ignored: the trigger must be one word");
      return;
    }
    if (seen.has(trigger)) {
      warnings.push(where + " ignored: duplicate trigger");
      return;
    }
    const source = raw.source && typeof raw.source === "object" ? raw.source : {};
    const kind = KINDS.includes(source.kind) ? source.kind : null;
    const url = asText(source.url);
    const path = asText(source.path);
    if (!kind) {
      warnings.push(where + " ignored: source.kind must be csv or json");
      return;
    }
    if (url && !/^https:\/\//i.test(url)) {
      warnings.push(where + " ignored: only https:// sources are allowed");
      return;
    }
    if (!url && !path) {
      warnings.push(where + " ignored: the source needs a path or an https url");
      return;
    }
    const key = asText(source.key);
    if (!key) {
      warnings.push(where + " ignored: source.key names the column to match");
      return;
    }
    const text = String(raw.template == null ? "" : raw.template);
    if (!template.fields(text).length) {
      warnings.push(where + " ignored: the template needs at least one [[field]]");
      return;
    }
    const minutes = Number(source.refreshMinutes);
    seen.add(trigger);
    lookups.push({
      trigger,
      label: asText(raw.label) || trigger,
      source: {
        kind,
        url: url || null,
        path: url ? null : path,
        location: url || path,
        key,
        refreshMinutes: Number.isFinite(minutes) && minutes >= MIN_REFRESH_MINUTES ? Math.min(minutes, MAX_REFRESH_MINUTES) : DEFAULTS.refreshMinutes,
      },
      template: text,
      fields: template.fields(text).map((f) => f.name),
      id: sha256(trigger + "\u0000" + (url || path)).slice(0, 16),
    });
  });
  return { lookups, warnings };
}

/** Parse CSV text (RFC 4180: quoted fields, doubled quotes, CRLF) into row objects keyed by the header. */
function parseCsv(text) {
  const source = String(text == null ? "" : text).replace(/^﻿/, "");
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      records.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    records.push(row);
  }
  const rows = records.filter((r) => r.some((cell) => cell !== ""));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const out = {};
    header.forEach((name, index) => {
      if (name) out[name] = cells[index] == null ? "" : cells[index];
    });
    return out;
  });
}

/** Rows from a source body, by kind. Throws on an unusable body. */
function rowsFrom(kind, text) {
  if (kind === "csv") return parseCsv(text);
  const data = JSON.parse(String(text));
  const list = Array.isArray(data) ? data : data && Array.isArray(data.rows) ? data.rows : null;
  if (!list) throw new Error("JSON must be an array of objects or {\"rows\": [...]}");
  return list.filter((row) => row && typeof row === "object" && !Array.isArray(row));
}

function normalizeKey(value) {
  return asText(value).toLowerCase();
}

/**
 * Recognise "<trigger> <argument> " at the end of the buffer (the person has
 * just typed the space after the argument). The trigger must start at a
 * boundary, like any shortcut; the argument is one word of up to 64 characters.
 * @returns {{lookup:object, argument:string, start:number, typed:string}|null}
 */
function findArgument(buffer, lookups) {
  const text = String(buffer == null ? "" : buffer);
  if (!text.endsWith(" ") || !Array.isArray(lookups) || !lookups.length) return null;
  const body = text.slice(0, -1);
  const space = body.lastIndexOf(" ");
  if (space < 0) return null;
  const argument = body.slice(space + 1);
  if (!argument || argument.length > DEFAULTS.maxArgument || /\s/.test(argument)) return null;
  const before = body.slice(0, space);
  let best = null;
  for (const lookup of lookups) {
    if (!before.endsWith(lookup.trigger)) continue;
    const start = before.length - lookup.trigger.length;
    if (!expander.isBoundary(before[start - 1])) continue;
    if (!best || lookup.trigger.length > best.lookup.trigger.length) best = { lookup, argument, start, typed: text.slice(start) };
  }
  return best;
}

/** Render a lookup's template with a row: fields filled, then built-in placeholders. */
function render(lookup, row, now) {
  const values = {};
  for (const name of lookup.fields) {
    if (row && Object.hasOwn(row, name)) values[name] = String(row[name] == null ? "" : row[name]);
  }
  return template.render(template.fill(lookup.template, values), null, now || new Date());
}

async function fetchBody(lookup, options) {
  const maxBytes = options.maxBytes;
  const tooBig = () => new Error("larger than " + maxBytes + " bytes");
  let text;
  if (lookup.source.url) {
    const doFetch = options.fetch || globalThis.fetch;
    if (typeof doFetch !== "function") throw new Error("this runtime cannot fetch URLs");
    const response = await doFetch(lookup.source.url, { signal: AbortSignal.timeout(options.timeoutMs), redirect: "follow" });
    if (response.url && !/^https:\/\//i.test(response.url)) throw new Error("redirected to a non-https address");
    if (!response.ok) throw new Error("HTTP " + response.status);
    const length = Number(response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : NaN);
    if (Number.isFinite(length) && length > maxBytes) throw tooBig();
    text = await response.text();
  } else if (options.readFile) {
    text = String(await options.readFile(lookup.source.path));
  } else {
    const fs = require("node:fs");
    const stat = await fs.promises.stat(lookup.source.path);
    if (stat.size > maxBytes) throw tooBig();
    text = await fs.promises.readFile(lookup.source.path, "utf8");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooBig();
  return text;
}

/**
 * Loads, caches and searches the data behind each lookup.
 * @param {object} options { lookups, fetch, readFile, cache: {load(id), save(id, value)}, now, maxBytes, maxRows, timeoutMs }
 */
function createLookupStore(options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const now = typeof settings.now === "function" ? settings.now : () => Date.now();
  const lookups = Array.isArray(settings.lookups) ? settings.lookups : [];
  const cache = settings.cache || { load: () => null, save: () => {} };
  const tables = new Map(); // lookup id -> { rows: Map(key -> row), count, fetchedAt, status, error }

  function index(lookup, rows) {
    const map = new Map();
    for (const row of rows.slice(0, settings.maxRows)) {
      const key = normalizeKey(row[lookup.source.key]);
      if (key && !map.has(key)) map.set(key, row);
    }
    return map;
  }

  function remember(lookup, entry) {
    tables.set(lookup.id, entry);
  }

  /** Use the cached copies only (synchronous; for start-up). */
  function loadCached() {
    for (const lookup of lookups) {
      const cached = cache.load(lookup.id);
      if (cached && Array.isArray(cached.rows)) {
        remember(lookup, { rows: index(lookup, cached.rows), count: cached.rows.length, fetchedAt: cached.fetchedAt || null, status: "cached", error: null });
      } else {
        remember(lookup, { rows: new Map(), count: 0, fetchedAt: null, status: "pending", error: null });
      }
    }
    return status();
  }

  function due() {
    return lookups.filter((lookup) => {
      const entry = tables.get(lookup.id);
      if (!entry || !entry.fetchedAt) return true;
      return now() - entry.fetchedAt >= lookup.source.refreshMinutes * 60 * 1000;
    });
  }

  /** Fetch every source (or the given ones); a failure keeps the last good copy with a warning. */
  async function refresh(subset) {
    const targets = Array.isArray(subset) ? subset : lookups;
    const warnings = [];
    for (const lookup of targets) {
      const previous = tables.get(lookup.id);
      try {
        const text = await fetchBody(lookup, settings);
        const rows = rowsFrom(lookup.source.kind, text);
        if (rows.length > settings.maxRows) throw new Error("more than " + settings.maxRows + " rows");
        const fetchedAt = now();
        cache.save(lookup.id, { rows, fetchedAt, trigger: lookup.trigger, location: lookup.source.location });
        remember(lookup, { rows: index(lookup, rows), count: rows.length, fetchedAt, status: "fresh", error: null });
      } catch (error) {
        const message = String(error && error.message || error);
        if (previous && previous.count) {
          remember(lookup, Object.assign({}, previous, { status: "cached", error: message }));
          warnings.push("lookup " + lookup.trigger + ": " + message + "; using the last good copy");
        } else {
          remember(lookup, { rows: new Map(), count: 0, fetchedAt: previous ? previous.fetchedAt : null, status: "failed", error: message });
          warnings.push("lookup " + lookup.trigger + ": " + message + "; it has no data yet");
        }
      }
    }
    return Object.assign(status(), { warnings });
  }

  /** The row for a trigger and argument, or null. */
  function find(trigger, argument) {
    const lookup = lookups.find((l) => l.trigger === trigger);
    const entry = lookup && tables.get(lookup.id);
    if (!entry) return null;
    return entry.rows.get(normalizeKey(argument)) || null;
  }

  function status() {
    return {
      lookups: lookups.map((lookup) => {
        const entry = tables.get(lookup.id) || { count: 0, fetchedAt: null, status: "pending", error: null };
        return { trigger: lookup.trigger, label: lookup.label, location: lookup.source.location, kind: lookup.source.kind, key: lookup.source.key, rows: entry.count, fetchedAt: entry.fetchedAt, status: entry.status, error: entry.error };
      }),
    };
  }

  return { lookups, loadCached, refresh, due, find, status };
}

module.exports = { KINDS, DEFAULTS, normalizeLookups, parseCsv, rowsFrom, findArgument, render, createLookupStore };
