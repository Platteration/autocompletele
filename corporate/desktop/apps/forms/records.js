// actle Forms: what the app keeps of its own in apps/forms.json, and the
// pure rules over it. Own records (accepted proposals) sit next to the
// policy's records with the policy winning a clash; fills are stored as
// sessions so core/forms.js can propose new records; proposals the person
// dismissed are remembered by a digest, never by their text. No Electron.
"use strict";

const crypto = require("node:crypto");
const core = require("../../../core/forms.js");
const capture = require("../../../core/capture-policy.js");

const DATA_VERSION = 1;
const MAX_SESSIONS = 500;
const MAX_TRIGGER = 40;
// A field named like this holds a secret whatever its value looks like; the value never reaches the disk.
const SECRET_WORDS = new Set(["password", "passwd", "passcode", "passphrase", "pwd", "pin", "secret", "token", "otp", "apikey"]);

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The stored file, cleaned: unknown shapes become the empty state rather than a crash. */
function normalizeData(raw) {
  const data = isObject(raw) ? raw : {};
  return {
    version: DATA_VERSION,
    records: Array.isArray(data.records) ? data.records.filter(isObject) : [],
    sessions: Array.isArray(data.sessions) ? data.sessions.filter((s) => isObject(s) && asText(s.form) && isObject(s.values)) : [],
    dismissed: Array.isArray(data.dismissed) ? data.dismissed.filter((d) => typeof d === "string" && d.startsWith("sha256:")) : [],
  };
}

/** One digest per proposal: the form and its field set, so a dismissal survives re-learning and the id order changing. */
function digest(form, fields) {
  const pairs = Object.entries(isObject(fields) ? fields : {}).map(([name, value]) => [name, String(value)]).sort((a, b) => a[0].localeCompare(b[0]));
  return "sha256:" + crypto.createHash("sha256").update(JSON.stringify([asText(form), pairs]), "utf8").digest("hex");
}

/**
 * The policy's records followed by the person's own. An own record whose id
 * a policy record already has is left out; one whose trigger a policy record
 * (or an earlier own record) already has keeps its record but loses the
 * trigger. Both are reported, so the dashboard can say why.
 */
function mergeRecords(policyRecords, ownRecords) {
  const warnings = [];
  const records = (Array.isArray(policyRecords) ? policyRecords : []).map((record) => Object.assign({}, record, { own: false }));
  const ids = new Set(records.map((r) => r.id));
  const triggers = new Set(records.filter((r) => r.trigger).map((r) => r.trigger));
  const own = core.normalizeForms({ records: Array.isArray(ownRecords) ? ownRecords : [] });
  for (const warning of own.warnings) warnings.push("own " + warning);
  for (const record of own.records) {
    if (ids.has(record.id)) {
      warnings.push("own record " + record.id + " ignored: a policy record has this id");
      continue;
    }
    ids.add(record.id);
    const out = { id: record.id, label: record.label, fields: record.fields, own: true };
    if (record.trigger && triggers.has(record.trigger)) warnings.push("own record " + record.id + " trigger " + record.trigger + " ignored: a policy record has this trigger");
    else if (record.trigger) {
      triggers.add(record.trigger);
      out.trigger = record.trigger;
    }
    records.push(out);
  }
  return { records, warnings };
}

/**
 * A trigger for a new own record: one word of at most 40 characters that
 * nothing in `taken` uses (records, shortcuts, document sets, notes
 * documents), so the engine's order (library, document sets, then the apps
 * in registry order) neither hides the new trigger nor lets it hide another.
 */
function checkTrigger(raw, taken) {
  const trigger = asText(raw);
  if (!trigger) return { ok: false, error: "Enter a trigger to type for this record." };
  if (/\s/.test(trigger)) return { ok: false, error: "A trigger has no spaces." };
  if (Array.from(trigger).length > MAX_TRIGGER) return { ok: false, error: "A trigger has at most " + MAX_TRIGGER + " characters." };
  const clash = (Array.isArray(taken) ? taken : []).find((item) => item && item.trigger === trigger);
  if (clash) return { ok: false, error: "The trigger " + trigger + " is already used by " + clash.what + "." };
  return { ok: true, trigger };
}

/**
 * "PIN", "userPin", "api-key", "newPassword" and "password2" name secrets;
 * "shipping", "spinner", "tokenizer" and "secretary" do not: a secret word
 * counts as a whole word, split from the rest at case changes, digits and
 * punctuation.
 */
function isSecretField(name) {
  const words = String(name == null ? "" : name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([a-z])([0-9])/gi, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => SECRET_WORDS.has(word)) || /\bapi key\b/.test(words.join(" "));
}

/** What a fill leaves for learning: non-secret text values only; the form id keys the learning. */
function sessionFrom(form, values, at) {
  const out = {};
  for (const [name, value] of Object.entries(isObject(values) ? values : {})) {
    const text = asText(value);
    if (!asText(name) || !text || isSecretField(name)) continue;
    // A value the scrubber would mask (a card number, a labelled secret) is not kept at all.
    if (capture.scrub(text).redactions > 0) continue;
    out[asText(name)] = text;
  }
  return { form: asText(form), values: out, at: Number(at) || 0 };
}

function addSession(sessions, session) {
  const list = (Array.isArray(sessions) ? sessions : []).concat([session]);
  return list.length > MAX_SESSIONS ? list.slice(list.length - MAX_SESSIONS) : list;
}

/**
 * Proposals from the stored fills, minus those the person dismissed and
 * those that repeat a record that already exists (the policy's or an own
 * one): a fill made from a record must not propose that record back.
 */
function proposals(data, records, options) {
  const known = new Set((Array.isArray(records) ? records : []).map((record) => digest("", record.fields)));
  const dismissed = new Set(data.dismissed);
  return core.learnFieldSets(data.sessions, options).map((proposal) => Object.assign({ digest: digest(proposal.form, proposal.fields) }, proposal))
    .filter((proposal) => !dismissed.has(proposal.digest) && !known.has(digest("", proposal.fields)));
}

module.exports = { DATA_VERSION, MAX_SESSIONS, MAX_TRIGGER, normalizeData, digest, mergeRecords, checkTrigger, isSecretField, sessionFrom, addSession, proposals };
