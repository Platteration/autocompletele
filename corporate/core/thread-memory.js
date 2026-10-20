// Template answers remembered per email conversation. When a person fills a
// template's [[blanks]] while writing in a mail client, the answers are kept
// for that conversation (the normalised subject of the focused window, per
// mail application) and offered as defaults the next time a template in the
// same conversation asks for the same blank. Records are sealed with the
// corpus key by the store; this module only decides what is remembered.
//
// What is never stored: values scrubbing would change (card numbers,
// passwords, tokens), values over the length cap, blanks whose name looks
// like a secret, and anything typed outside a recognised mail window.
"use strict";

const crypto = require("node:crypto");
const capture = require("./capture-policy.js");

const DEFAULTS = Object.freeze({ retentionDays: 90, maxThreads: 500, maxAnswersPerThread: 50, maxValueLength: 500 });
const DAY = 86400000;

// Mail applications a conversation can be recognised in, in capture-rule shape.
// Webmail is recognised by the tab title; the browser suffix is stripped first.
const MAIL_APPS = Object.freeze([
  { id: "outlook", processes: ["outlook", "olk"], bundleIds: ["com.microsoft.outlook"], titlePattern: null },
  { id: "thunderbird", processes: ["thunderbird", "org.mozilla.thunderbird"], bundleIds: ["org.mozilla.thunderbird"], titlePattern: null },
  { id: "apple-mail", processes: ["mail"], bundleIds: ["com.apple.mail"], titlePattern: null },
  { id: "evolution", processes: ["evolution"], bundleIds: [], titlePattern: null },
  { id: "gmail", processes: [], bundleIds: [], titlePattern: "\\s[-\\u2013\\u2014]\\sGmail\\b" },
  { id: "outlook-web", processes: [], bundleIds: [], titlePattern: "[-\\u2013\\u2014]\\sOutlook\\b" },
]);

const BROWSER_SUFFIX = /\s[-–—]\s(?:Google Chrome|Chromium|(?:Mozilla )?Firefox|Microsoft​? ?Edge|Safari|Brave|Opera|Vivaldi)$/i;
const BROWSER_EXTRA = [/\sand \d+ more pages?$/i, /\s-\sProfile \d+$/i];
const CLIENT_SUFFIX = [
  /\s-\sMessage \((?:HTML|Plain Text|Rich Text)\)$/i,
  /\s[-–—]\s(?:Microsoft )?Outlook$/i,
  /\s[-–—]\s(?:Mozilla )?Thunderbird$/i,
  /\s[-–—]\sGmail$/i,
  /\s[-–—]\sMail$/i,
];
const ACCOUNT_SUFFIX = /\s[-–—]\s\S+@\S+$/;
const COMPOSE_PREFIX = [/^(?:Write|Compose|Verfassen):\s*/i, /^\(\d+\)\s*/];
const REPLY_PREFIX = /^(?:re|fw|fwd|aw|wg|sv|vs|tr|rv|antw|enc|res|odp)(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;
const FOLDERS = ["inbox", "sent", "sent items", "drafts", "outbox", "junk", "junk email", "spam", "trash", "deleted items", "archive", "all mail", "starred",
  "calendar", "contacts", "mail", "new message", "untitled", "(no subject)", "no subject", "posteingang", "gesendete elemente", "entwürfe", "kein betreff"];
const FOLDER_TAIL = /(?:\s*\(\d+\))?(?:\s[-–—]\s.*)?$/;
// Blanks whose name says they hold a secret are never remembered.
const SECRET_NAME = /password|passcode|passphrase|\bpin\b|\botp\b|secret|token|api ?key|\bcvv\b|\bcvc\b|security code|verification code|credential/i;

function stripAll(text, patterns) {
  let out = text;
  let before;
  do {
    before = out;
    for (const pattern of patterns) out = out.replace(pattern, "");
    out = out.trim();
  } while (out !== before);
  return out;
}

/** The conversation subject a window title stands for, or "" when it is a folder, a view or nothing. */
function normalizeSubject(title) {
  let text = String(title == null ? "" : title).trim();
  text = stripAll(text, [BROWSER_SUFFIX].concat(BROWSER_EXTRA));
  text = stripAll(text, CLIENT_SUFFIX);
  text = stripAll(text, [ACCOUNT_SUFFIX]);
  text = stripAll(text, COMPOSE_PREFIX);
  text = stripAll(text, [REPLY_PREFIX]);
  text = text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  text = capture.scrub(text).text;
  if (text.length < 3) return "";
  const head = text.replace(FOLDER_TAIL, "").trim();
  if (FOLDERS.includes(head)) return "";
  return text;
}

/** The mail application a focused window belongs to, or null. */
function mailApp(context) {
  const ctx = context && typeof context === "object" ? context : {};
  const found = MAIL_APPS.find((rule) => capture.ruleMatches(rule, ctx));
  return found ? found.id : null;
}

/**
 * The conversation a focused window stands for: { id, app, subject } or null.
 * The id is a digest used in memory and over IPC; it is never written to disk.
 */
function threadKey(context) {
  const ctx = context && typeof context === "object" ? context : {};
  if (ctx.ownWindow === true || capture.isSensitiveContext(ctx)) return null;
  const app = mailApp(ctx);
  if (!app) return null;
  const subject = normalizeSubject(ctx.title);
  if (!subject) return null;
  return { id: crypto.createHash("sha256").update(app + "|" + subject).digest("hex").slice(0, 16), app, subject };
}

function idOf(record) {
  return crypto.createHash("sha256").update(record.app + "|" + record.subject).digest("hex").slice(0, 16);
}

/**
 * @param {{load:Function, save:Function, now?:Function, retentionDays?:number, maxThreads?:number, maxAnswersPerThread?:number, maxValueLength?:number, presets?:object}} options
 *   `load()` returns the stored records (already unsealed); `save(records)` returns false when nothing can be written.
 */
function createThreadMemory(options) {
  const opts = Object.assign({ now: () => Date.now(), load: () => [], save: () => false, presets: {} }, DEFAULTS, options || {});
  let records = null;

  function fresh(record, at) {
    return Number(record.updatedAt || record.createdAt || 0) >= at - opts.retentionDays * DAY;
  }

  function all() {
    if (!records) {
      records = (opts.load() || []).filter((r) => r && typeof r === "object" && typeof r.app === "string" && typeof r.subject === "string" && Array.isArray(r.answers));
    }
    return records;
  }

  function persist() {
    return opts.save(records.slice()) !== false;
  }

  /** Drop expired records, then the oldest beyond the caps. Returns how many went. */
  function prune() {
    const at = opts.now();
    const before = all().length;
    records = all().filter((r) => fresh(r, at)).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, opts.maxThreads);
    for (const r of records) if (r.answers.length > opts.maxAnswersPerThread) r.answers = r.answers.slice(-opts.maxAnswersPerThread);
    const removed = before - records.length;
    if (removed) persist();
    return removed;
  }

  function find(thread) {
    return all().find((r) => r.app === thread.app && r.subject === thread.subject) || null;
  }

  /** Defaults for a template's fields in this conversation. Expired records are not offered. */
  function defaults(thread, fieldNames) {
    const values = Object.create(null);
    if (!thread) return { values, pronouns: null, updatedAt: null };
    const record = find(thread);
    if (!record || !fresh(record, opts.now())) return { values, pronouns: null, updatedAt: null };
    const wanted = new Set(Array.isArray(fieldNames) ? fieldNames : []);
    for (const answer of record.answers) if (wanted.has(answer.name)) values[answer.name] = answer.value;
    return { values, pronouns: record.pronouns || null, updatedAt: record.updatedAt };
  }

  function acceptable(name, value) {
    if (typeof name !== "string" || !name.trim() || SECRET_NAME.test(name)) return false;
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > opts.maxValueLength) return false;
    if (capture.scrub(text).redactions > 0) return false;
    return true;
  }

  /** Remember the answers given for the template's fields. Returns how many were kept. */
  function remember(thread, values, fieldNames, pronounPreset) {
    if (!thread) return 0;
    const wanted = new Set(Array.isArray(fieldNames) ? fieldNames : []);
    const at = opts.now();
    let record = find(thread);
    if (!record) {
      record = { app: thread.app, subject: thread.subject, answers: [], pronouns: null, createdAt: at, updatedAt: at };
      all().push(record);
    }
    let kept = 0;
    for (const name of Object.keys(values && typeof values === "object" ? values : {})) {
      if (!wanted.has(name) || !acceptable(name, values[name])) continue;
      const value = String(values[name]).trim();
      record.answers = record.answers.filter((a) => a.name !== name);
      record.answers.push({ name, value, at });
      kept++;
    }
    if (typeof pronounPreset === "string" && Object.hasOwn(opts.presets, pronounPreset)) record.pronouns = pronounPreset;
    if (!record.answers.length && !record.pronouns) {
      records = all().filter((r) => r !== record);
      return 0;
    }
    record.updatedAt = at;
    if (record.answers.length > opts.maxAnswersPerThread) record.answers = record.answers.slice(-opts.maxAnswersPerThread);
    if (all().length > opts.maxThreads) prune();
    persist();
    return kept;
  }

  /** Conversations with their answers, newest first, for the dashboard. */
  function list() {
    const at = opts.now();
    return all().filter((r) => fresh(r, at)).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).map((r) => ({
      id: idOf(r),
      app: r.app,
      subject: r.subject,
      answers: r.answers.map((a) => ({ name: a.name, value: a.value })),
      pronouns: r.pronouns || null,
      updatedAt: r.updatedAt,
    }));
  }

  function forget(id) {
    const before = all().length;
    records = all().filter((r) => idOf(r) !== id);
    if (records.length !== before) persist();
    return before - records.length;
  }

  function clear() {
    const count = all().length;
    records = [];
    persist();
    return count;
  }

  return { defaults, remember, list, forget, clear, prune, size: () => all().length };
}

module.exports = { DEFAULTS, MAIL_APPS, SECRET_NAME, normalizeSubject, mailApp, threadKey, createThreadMemory };
