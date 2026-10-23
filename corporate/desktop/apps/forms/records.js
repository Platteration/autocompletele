// cactle: what the app keeps of its own in apps/forms.json, and the
// pure rules over it. Own records (accepted proposals) sit next to the
// policy's records with the policy winning a clash; fills are stored as
// sessions so core/forms.js can propose new records; proposals the person
// dismissed are remembered by a digest, never by their text. No Electron.
//
// The file is plain JSON, outside the encrypted learning corpus, so a stored
// fill holds only what the organisation's policy already put on the desk (a
// record's own text and the lookup row's columns): never what the person typed
// into the plan popover, never a value of a field whose name has one of the
// SECRET_WORDS below as a whole word (other names, such as accountNumber or
// passportNumber, are not recognised), and never a value the scrubber masks
// or gactle's IBAN or national ID detector flags.
"use strict";

const crypto = require("node:crypto");
const core = require("../../../core/forms.js");
const capture = require("../../../core/capture-policy.js");
const guard = require("../../../core/guard.js");
const { template } = require("../../../core/personal.js");

const DATA_VERSION = 1;
const MAX_SESSIONS = 500;
const MAX_TRIGGER = 40;
const DAY_MS = 86400000;
// A field named like this holds a secret, a bank detail or an identity number whatever its value looks like; the value never reaches the disk.
const SECRET_WORDS = new Set([
  "password", "passwd", "passcode", "passphrase", "pass", "pwd", "pin", "secret", "token", "otp", "apikey", "credential", "credentials",
  "cvv", "cvc", "iban", "bic", "ssn", "nino", "dni", "nir",
]);
// gactle's detectors for what the scrubber does not mask: IBANs (mod 97) and national ID numbers (US, GB, ES, FR, checked).
// Card numbers (Luhn), labelled secrets and long tokens are the scrubber's: gactle's card-number and secret detectors use the same patterns, so they find nothing the scrubber left.
const VALUE_DETECTORS = Object.freeze(["iban", "national-id"]);

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

/** True for a value that must not be stored: the scrubber masks it (a card number, a labelled secret, a long token), or gactle's IBAN or national ID detector fires on it. */
function isSensitiveValue(value) {
  const text = String(value == null ? "" : value);
  if (capture.scrub(text).redactions > 0) return true;
  return VALUE_DETECTORS.some((name) => guard.DETECTORS[name](text, {}).length > 0);
}

/**
 * The values of a fill that came from the organisation's policy alone: a
 * record's text and the lookup row's columns. A step that carries anything
 * the person typed into the popover (a record field whose template has an
 * answered blank, or a form field filled straight from an answer) is left
 * out, and so is a record field whose template names a secret blank.
 * `steps` are core.plan steps ({field, value, source}); `answered` maps the
 * blanks the person answered to their text.
 */
function policyValues(record, steps, answered) {
  const typed = new Set(Object.keys(isObject(answered) ? answered : {}));
  const fields = record && isObject(record.fields) ? record.fields : {};
  const out = {};
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || !asText(step.field)) continue;
    if (step.source === "record") {
      const blanks = template.fields(String(fields[step.field] == null ? "" : fields[step.field])).map((field) => field.name);
      if (blanks.some((name) => typed.has(name) || isSecretField(name))) continue;
    } else if (typed.has(step.field)) continue;
    out[step.field] = step.value;
  }
  return out;
}

/** What a fill leaves for learning: non-secret text values only; the form id keys the learning. */
function sessionFrom(form, values, at) {
  const out = {};
  for (const [name, value] of Object.entries(isObject(values) ? values : {})) {
    const text = asText(value);
    if (!asText(name) || !text || isSecretField(name)) continue;
    // A value the scrubber would mask or a detector flags (a card number, a labelled secret, an IBAN, a national ID) is not kept at all.
    if (isSensitiveValue(text)) continue;
    out[asText(name)] = text;
  }
  return { form: asText(form), values: out, at: Number(at) || 0 };
}

function addSession(sessions, session) {
  const list = (Array.isArray(sessions) ? sessions : []).concat([session]);
  return list.length > MAX_SESSIONS ? list.slice(list.length - MAX_SESSIONS) : list;
}

/** The sessions stored within the last `days` days (the policy's retention.corpusDays); no positive number of days keeps them all. */
function pruneSessions(sessions, now, days) {
  const list = Array.isArray(sessions) ? sessions : [];
  const keep = Number(days);
  if (!Number.isFinite(keep) || keep <= 0) return list;
  const cutoff = Number(now) - keep * DAY_MS;
  return list.filter((session) => (Number(session && session.at) || 0) >= cutoff);
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

module.exports = { DATA_VERSION, MAX_SESSIONS, MAX_TRIGGER, normalizeData, digest, mergeRecords, checkTrigger, isSecretField, isSensitiveValue, policyValues, sessionFrom, addSession, pruneSessions, proposals };
