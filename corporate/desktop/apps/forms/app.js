// cactle: the desktop side of core/forms.js. A record's trigger typed in
// a form (or the record picked in the search palette) opens the "plan"
// popover: the form matched to the focused window, a reference that fills
// the customer fields from a lookup list, the planned values and the blanks
// still open. Fill closes the popover, so the keys reach the form and not
// actle's own window, then types the values in Tab order. The shell cannot
// read the form or reach its fields by selector: the caret has to be in the
// form's first field, and a Tab is pressed for every field passed over.
// Every fill made on a matched form is stored so the core can propose
// records from fields filled together, but only the values that came from
// the policy (records.js policyValues and sessionFrom): never what was typed
// into the popover, a value of a field named with one of records.js's secret
// words, or a value the scrubber masks or gactle's IBAN or national ID
// detector flags. Stored fills older than the policy's retention.corpusDays
// go at start and at every fill, and all go with "Delete learned text"
// (onClearLearning).
"use strict";

const core = require("../../../core/forms.js");
const capture = require("../../../core/capture-policy.js");
const metrics = require("../../../core/metrics.js");
const data = require("./records.js");
const layout = require("./plan.js");
const { simulate } = require("./simulate.js");
const { NAMES } = require("../index.js");

const ID = "forms";
const NO_FORM_NOTE = "No form matched this window: fields are filled in record order with Tab between them.";
const SELECTORS_NOTE = "This shell does not use the form's selectors: the caret has to be in the form's first field, and the values are typed in Tab order with a Tab for every field passed over.";
// After the popover closes, the application behind it needs a moment to get the focus back (main.js waits the same for the palette).
const FOCUS_DELAY_MS = 150;
const OWN_TRIGGER = "own-record";
const INFO_ROWS = 20;
const EMPTY_SECTION = core.normalizeForms(null);
const PAUSED = "Paused by your organisation.";

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Run `fn` on a value that may be a promise (Electron's sender) or plain (the simulator's stand-in), keeping the plain path synchronous. */
function then(value, fn) {
  return value && typeof value.then === "function" ? value.then(fn) : fn(value);
}

/** The shell's settle() gives the focus back to the form (Electron's waits 150 ms; the simulator's stand-in answers at once); a shell without it gets the same pause here. */
function settle(from) {
  return typeof from.settle === "function" ? from.settle() : new Promise((resolve) => setTimeout(resolve, FOCUS_DELAY_MS));
}

function describeRecord(record) {
  return { id: record.id, label: record.label, trigger: record.trigger || null, fields: Object.assign({}, record.fields), blanks: layout.blanksOf(record), own: !!record.own };
}

function createApp(host) {
  let shell = null;
  let lastContext = {};
  // apps/forms.json, read once: this app is its only writer.
  let cache = null;
  // The merged record list and the proposals, kept until the policy object or the stored data changes:
  // the trigger hook runs on every key typed, the info channel on every dashboard render.
  let recordsMemo = null;
  let proposalsMemo = null;

  function config() {
    const section = host.policy().forms;
    return section && Array.isArray(section.records) ? section : EMPTY_SECTION;
  }

  function paused() {
    const state = host.policy().paused;
    return !!(state && state.active);
  }

  function retentionDays() {
    const retention = host.policy().retention;
    return retention ? retention.corpusDays : undefined;
  }

  /**
   * The stored data, read once (at start, from onStart); fills older than the
   * policy's retention.corpusDays are dropped from the file then and at every
   * new fill. The read can happen inside the keystroke hook, so a write that
   * fails here (disk full, read-only folder) is logged, never thrown: the
   * pruned list stays in memory and the next write carries it.
   */
  function loadData() {
    if (!cache) {
      const loaded = data.normalizeData(host.appData(ID).load({}));
      const kept = data.pruneSessions(loaded.sessions, host.now(), retentionDays());
      cache = kept.length === loaded.sessions.length ? loaded : Object.assign({}, loaded, { sessions: kept });
      if (cache !== loaded) {
        try {
          host.appData(ID).save(cache);
        } catch (error) {
          host.log("forms: expired stored fills could not be removed from the file: " + error.message);
        }
      }
    }
    return cache;
  }

  function saveData(next) {
    cache = next;
    recordsMemo = null;
    proposalsMemo = null;
    host.appData(ID).save(next);
  }

  function merged() {
    const section = config();
    const own = loadData();
    if (!recordsMemo || recordsMemo.section !== section || recordsMemo.own !== own) recordsMemo = { section, own, value: data.mergeRecords(section.records, own.records) };
    return recordsMemo.value;
  }

  function allRecords() {
    return merged().records;
  }

  function recordById(id) {
    return allRecords().find((record) => record.id === id) || null;
  }

  function formById(id) {
    return id ? config().forms.find((form) => form.id === id) || null : null;
  }

  /** The form for the window that had the focus when the trigger was typed (actle's own windows keep the last context). */
  function currentForm() {
    return core.findForm(lastContext, config());
  }

  // Electron 44's clipboard answers with a promise (readText(): Promise<string>);
  // the tests' and the simulator's stand-ins answer at once. Either way the
  // caller gets text, or a promise of text, never a rejection.
  function readClipboard(from) {
    const fail = (error) => {
      host.log("forms: the clipboard could not be read: " + (error && error.message || error));
      return "";
    };
    let value;
    try {
      value = from.clipboard.readText();
    } catch (error) {
      return fail(error);
    }
    const text = (v) => String(v == null ? "" : v);
    return value && typeof value.then === "function" ? value.then(text, fail) : text(value);
  }

  /**
   * The plan for a record on a form: the lookup row for the reference under
   * the person's answers. Without a form the record's own fields, in record
   * order, stand in for it.
   */
  function prepare(recordId, formId, reference, answers) {
    const record = recordById(asText(recordId));
    if (!record) return { ok: false, error: "This record is no longer available." };
    const form = formById(asText(formId));
    const key = asText(reference);
    const hit = key ? core.lookup(key, config()) : null;
    const values = Object.assign({}, hit ? hit.row : {});
    // Answers are for the record's blanks only: the popover asks for nothing else.
    const blanks = layout.blanksOf(record);
    const given = {};
    for (const [name, value] of Object.entries(isObject(answers) ? answers : {})) {
      if (!asText(value) || !blanks.includes(name)) continue;
      values[name] = asText(value);
      given[name] = asText(value);
    }
    const target = form || { id: null, fields: Object.keys(record.fields).map((name) => ({ name, label: name, selector: "" })) };
    const planned = core.plan(record, target, { values });
    return {
      ok: true,
      record: { id: record.id, label: record.label, own: !!record.own, blanks },
      form: form ? { id: form.id, label: form.label, selectors: form.fields.map((field) => field.selector) } : null,
      lookup: hit ? { lookup: hit.lookup, key: hit.key, via: hit.via, row: Object.assign({}, hit.row) } : null,
      reference: key,
      answers: given,
      plan: { steps: layout.withTabs(planned.steps, target.fields), missing: planned.missing.slice(), skipped: planned.skipped.slice(), ready: planned.ready },
      // What a complete fill may store for learning: the steps whose value came from the policy alone (never shown to a page).
      learnable: data.policyValues(record, planned.steps, given),
    };
  }

  /** The plan for the dashboard's "try": everything prepare() returns but what only a fill stores. */
  function preview(recordId, formId, reference, answers) {
    const prepared = prepare(recordId, formId, reference, answers);
    delete prepared.learnable;
    return prepared;
  }

  /** The popover state for a record, with the clipboard tried once for a reference; null while paused. */
  function planAction(record, via) {
    if (!record || paused()) return null;
    const form = currentForm();
    let reference = "";
    // The trigger path cannot wait: with Electron 44's asynchronous clipboard
    // the popover asks for the reference itself once it is open (forms:clipboardReference).
    let clipboardPending = false;
    if (shell) {
      const copied = readClipboard(shell);
      if (copied && typeof copied.then === "function") {
        clipboardPending = true;
      } else {
        const hit = core.lookup(copied, config());
        if (hit) reference = hit.key;
      }
    }
    const prepared = prepare(record.id, form ? form.id : "", reference, {});
    return { popover: "plan", recordId: record.id, formId: form ? form.id : null, reference, clipboardPending, via, record: prepared.record, form: prepared.form, lookup: prepared.lookup, plan: prepared.plan, notes: { noForm: NO_FORM_NOTE, selectors: SELECTORS_NOTE } };
  }

  /** A key that failed: the popover is gone by now, so the person is told through a notification, and nothing is counted. */
  function failure(key, count, result, from) {
    const reason = result && result.error ? ": " + result.error + "." : ".";
    const error = "Could not " + key.what + " " + key.step.label + " (" + (key.index + 1) + " of " + count + ")" + reason + (key.index > 0 ? " The fields before it were filled; the rest was not." : "");
    from.notify(error);
    return { ok: false, error, close: true };
  }

  function countFill(prepared, state, from) {
    const steps = prepared.plan.steps;
    const backspaces = Math.max(0, Math.floor(Number(state.backspaces) || 0));
    // What the person typed into the popover (a reference the clipboard did not give, the answers) is not a saving.
    const typedReference = prepared.reference && prepared.reference !== asText(state.reference) ? metrics.graphemes(prepared.reference) : 0;
    const typedAnswers = Object.values(prepared.answers).reduce((sum, value) => sum + metrics.graphemes(value), 0);
    // The trigger was typed into the field only when it has to be deleted. It
    // goes in as spent keystrokes, not as `typed`: the engine took the trigger
    // out of its field and session text at the hit, and `typed` would take the
    // same characters out a second time.
    const spent = Math.max(0, Math.floor(Number(state.spentKeystrokes) || 0)) + typedReference + typedAnswers + (backspaces ? metrics.graphemes(asText(state.trigger)) : 0);
    // The engine reports "form" inserts as the organisation's: an own record's fill is counted under one shared name, so no desk-local id reaches a usage report.
    const entry = host.recordInsert({ kind: "form", trigger: prepared.record.own ? OWN_TRIGGER : prepared.record.id, inserted: steps.map((step) => step.value).join("\n"), typed: "", spentKeystrokes: spent });
    // Only a fill on a matched form can teach anything: the form id keys the
    // learning. What is stored came from the policy (the record's text and the
    // lookup row); what was typed into the popover is never written.
    if (prepared.form) {
      const stored = loadData();
      const kept = data.pruneSessions(stored.sessions, host.now(), retentionDays());
      stored.sessions = data.addSession(kept, data.sessionFrom(prepared.form.id, prepared.learnable, host.now()));
      saveData(stored);
    }
    const keystrokesSaved = entry ? entry.keystrokesSaved : 0;
    // Ids and counts only: never a value, an answer or the reference.
    host.audit({ event: "form-filled", record: prepared.record.id, form: prepared.form ? prepared.form.id : null, via: state.via || "trigger", fields: steps.length, blanksAnswered: Object.keys(prepared.answers).length, lookup: prepared.lookup ? prepared.lookup.lookup : null, keystrokesSaved });
    // A system notification outlives the fill (notification centre, lock screen): a count, plus the label of an organisation record (policy text); an own record's label, learned or typed, never.
    from.notify("Filled " + steps.length + " field" + (steps.length === 1 ? "" : "s") + (prepared.record.own ? "." : " of " + prepared.record.label + "."));
    return { ok: true, record: prepared.record.id, form: prepared.form ? prepared.form.id : null, fields: steps.length, keystrokesSaved };
  }

  /**
   * The keys of a fill, in order: for each step a Tab per field passed over,
   * then the paste. The typed trigger goes with the first paste, or on its
   * own when the first value belongs to a later field. A key that fails
   * stops the fill; only a complete fill is counted and stored.
   */
  function typeAll(prepared, state, from) {
    const steps = prepared.plan.steps;
    const backspaces = Math.max(0, Math.floor(Number(state.backspaces) || 0));
    const keys = [];
    steps.forEach((step, index) => {
      const first = index === 0;
      if (first && backspaces && step.tabs) keys.push({ what: "delete the trigger before", step, index, send: () => from.sender.replace({ backspaces, text: "", cursorOffset: 0 }) });
      if (step.tabs) keys.push({ what: "move to", step, index, send: () => from.sender.press("tab", step.tabs) });
      keys.push({ what: "fill", step, index, send: () => from.sender.replace({ backspaces: first && !step.tabs ? backspaces : 0, text: step.value, cursorOffset: step.value.length }) });
    });
    const send = (i) => {
      if (i >= keys.length) return countFill(prepared, state, from);
      return then(keys[i].send(), (result) => (!result || result.ok === false ? failure(keys[i], steps.length, result, from) : send(i + 1)));
    };
    return send(0);
  }

  /**
   * The plan popover's Fill: plan again with the answers, refuse while a
   * blank is open (the popover stays open with the reason), then close the
   * popover so the keys reach the form and type the values.
   */
  function submit(state, payload, from) {
    // A popover opened before the organisation paused the desk types nothing after it.
    if (paused()) return { ok: false, error: PAUSED };
    const given = payload && isObject(payload.answers) ? payload.answers : {};
    const reference = payload && payload.reference != null ? payload.reference : state.reference;
    const prepared = prepare(state.recordId, state.formId, reference, given);
    if (!prepared.ok) return prepared;
    const plan = prepared.plan;
    if (plan.missing.length) {
      const noRow = prepared.reference && !prepared.lookup ? " (no lookup row matches " + prepared.reference + ")" : "";
      return { ok: false, error: "Fill in: " + plan.missing.join(", ") + noRow, missing: plan.missing };
    }
    if (!plan.steps.length) return { ok: false, error: "Nothing to fill: the form " + prepared.form.label + " has none of this record's fields." };
    from.closePopover();
    return then(settle(from), () => {
      // A pause that arrived while the focus went back types nothing; a fill that has started typing finishes (half a form is worse).
      if (paused()) {
        from.notify(PAUSED);
        return { ok: false, error: PAUSED, close: true };
      }
      return typeAll(prepared, state, from);
    });
  }

  /**
   * The proposals from the stored fills, each under a neutral label: a
   * number and the policy's form label, never a learned value (an accepted
   * proposal keeps this label unless the person names it). The number is the
   * lowest that no record and no earlier proposal uses with that label, so
   * accepting proposals under their default labels gives distinct names.
   */
  function proposals() {
    const stored = loadData();
    const records = allRecords();
    if (!proposalsMemo || proposalsMemo.stored !== stored || proposalsMemo.records !== records) {
      const taken = new Set(records.map((record) => record.label));
      const value = data.proposals(stored, records).map((proposal) => {
        const form = formById(proposal.form);
        const on = " on " + (form ? form.label : proposal.form);
        let n = 1;
        while (taken.has("Learned record " + n + on)) n += 1;
        const label = "Learned record " + n + on;
        taken.add(label);
        return Object.assign({}, proposal, { label });
      });
      proposalsMemo = { stored, records, value };
    }
    return proposalsMemo.value;
  }

  /** Every trigger a typed key can already fire: records, library shortcuts, document sets and the notes documents (the other app with typed triggers). */
  function takenTriggers() {
    const taken = allRecords().filter((record) => record.trigger).map((record) => ({ trigger: record.trigger, what: "the record " + record.label }));
    const library = host.engine && Array.isArray(host.engine.library) ? host.engine.library : [];
    for (const sh of library) taken.push({ trigger: sh.trigger, what: "the shortcut " + sh.trigger });
    const documents = host.policy().documents;
    for (const set of documents && Array.isArray(documents.shortcuts) ? documents.shortcuts : []) taken.push({ trigger: set.trigger, what: "the document set " + set.trigger });
    const notes = host.policy().notes;
    for (const doc of notes && Array.isArray(notes.documents) ? notes.documents : []) taken.push({ trigger: doc.trigger, what: "the notes document " + (doc.label || doc.id) });
    return taken;
  }

  /** A learned proposal becomes one of the person's own records, under a trigger they choose. */
  function acceptProposal(payload) {
    const proposal = proposals().find((p) => p.digest === (payload && payload.digest));
    if (!proposal) return { ok: false, error: "This proposal has changed. Look at the " + NAMES[ID].name + " tab again." };
    const checked = data.checkTrigger(payload.trigger, takenTriggers());
    if (!checked.ok) return checked;
    const stored = loadData();
    const own = { id: "own-" + proposal.digest.slice(7, 15), label: asText(payload.label) || proposal.label, trigger: checked.trigger, fields: proposal.fields, form: proposal.form, acceptedAt: host.now() };
    stored.records = stored.records.concat([own]);
    saveData(stored);
    host.audit({ event: "form-record-accepted", record: own.id, form: proposal.form, fields: Object.keys(own.fields).length, fills: proposal.count });
    return { ok: true, record: { id: own.id, label: own.label, trigger: own.trigger }, broadcast: { apps: true } };
  }

  function dismissProposal(payload) {
    const digest = payload && typeof payload.digest === "string" && payload.digest.startsWith("sha256:") ? payload.digest : "";
    if (!digest) return { ok: false, error: "No proposal given." };
    const stored = loadData();
    if (!stored.dismissed.includes(digest)) stored.dismissed = stored.dismissed.concat([digest]);
    saveData(stored);
    host.audit({ event: "form-proposal-dismissed" });
    return { ok: true, broadcast: { apps: true } };
  }

  function deleteOwnRecord(payload) {
    const id = asText(payload && payload.id);
    const stored = loadData();
    if (!stored.records.some((record) => asText(record.id) === id)) return { ok: false, error: "This record is not one of yours." };
    stored.records = stored.records.filter((record) => asText(record.id) !== id);
    saveData(stored);
    host.audit({ event: "form-record-deleted", record: id });
    return { ok: true, broadcast: { apps: true } };
  }

  function clearSessions() {
    const stored = loadData();
    const count = stored.sessions.length;
    stored.sessions = [];
    saveData(stored);
    host.audit({ event: "form-sessions-cleared", sessions: count });
    return { ok: true, removed: count, broadcast: { apps: true } };
  }

  /** "Delete learned text" (assistant.clearLearning): the stored fills go too; own records and dismissals are the person's decisions and stay. */
  function clearLearning() {
    if (!loadData().sessions.length) return;
    clearSessions();
  }

  function info() {
    const cfg = config();
    const all = merged();
    const form = currentForm();
    return {
      configured: cfg.records.length > 0 || cfg.lookups.length > 0 || cfg.forms.length > 0,
      paused: paused(),
      notes: { noForm: NO_FORM_NOTE, selectors: SELECTORS_NOTE },
      records: all.records.filter((record) => !record.own).map(describeRecord),
      ownRecords: all.records.filter((record) => record.own).map(describeRecord),
      lookups: cfg.lookups.map((lookup) => ({ id: lookup.id, key: lookup.key, keyPattern: lookup.keyPattern, rowCount: lookup.rows.length, rows: lookup.rows.slice(0, INFO_ROWS).map((row) => Object.assign({}, row)) })),
      forms: cfg.forms.map((item) => ({ id: item.id, label: item.label, match: { title: item.match.title, process: item.match.process.slice() }, fields: item.fields.map((field) => Object.assign({}, field)) })),
      context: { process: capture.baseName(lastContext.process), title: asText(lastContext.title), form: form ? { id: form.id, label: form.label } : null },
      proposals: proposals(),
      sessions: loadData().sessions.length,
      maxSessions: data.MAX_SESSIONS,
      retentionDays: retentionDays(),
      learning: { minCount: core.DEFAULTS.minCount, minFields: core.DEFAULTS.minFields },
      warnings: all.warnings,
    };
  }

  function paletteKey(record) {
    return record.trigger || "form:" + record.id;
  }

  const app = {
    id: ID,
    title: NAMES[ID].name,
    tab: true,
    ipc: {
      "forms:info": () => info(),
      "forms:lookup": (payload) => ({ ok: true, hit: core.lookup(payload && payload.text != null ? String(payload.text) : "", config()) }),
      // The key of the lookup row the copied text names, or "": the copied text itself never reaches the page.
      "forms:clipboardReference": () => {
        if (!shell || paused()) return { ok: true, reference: "" };
        const keyOf = (text) => {
          const hit = core.lookup(text, config());
          return { ok: true, reference: hit ? hit.key : "" };
        };
        const copied = readClipboard(shell);
        return copied && typeof copied.then === "function" ? copied.then(keyOf) : keyOf(copied);
      },
      "forms:plan": (payload) => preview(payload && payload.recordId, payload && payload.formId, payload && payload.reference, payload && payload.answers),
      "forms:acceptProposal": (payload) => acceptProposal(payload || {}),
      "forms:dismissProposal": (payload) => dismissProposal(payload || {}),
      "forms:deleteOwnRecord": (payload) => deleteOwnRecord(payload || {}),
      "forms:clearSessions": () => clearSessions(),
    },
    extension: {
      id: ID,
      trigger: (textBeforeCaret) => {
        if (paused()) return null;
        const found = core.findRecord(textBeforeCaret, { records: allRecords() });
        return found ? { trigger: found.record.trigger, action: planAction(found.record, "trigger") } : null;
      },
      reset: () => {},
    },
    popovers: {
      plan: { file: "apps/forms-plan", size: layout.size, submit },
    },
    palette: {
      items: () => (paused() ? [] : allRecords().map((record) => ({
        trigger: paletteKey(record),
        expansion: [record.label, record.id].concat(Object.keys(record.fields), Object.values(record.fields)).join(" "),
        source: record.own ? "personal" : "organization",
        preview: (record.label + ": " + Object.entries(record.fields).map(([name, value]) => name + " = " + value).join("; ")).replace(/\s+/g, " ").slice(0, 140),
      }))),
      choose: (choice) => {
        const found = choice ? allRecords().find((record) => paletteKey(record) === choice.trigger) : null;
        const action = planAction(found, "palette");
        return action ? Object.assign({ type: "app", app: ID, trigger: choice.trigger, backspaces: 0, spentKeystrokes: Math.max(0, Math.floor(Number(choice.spentKeystrokes) || 0)) }, action) : null;
      },
    },
    onFocus: (context) => { lastContext = isObject(context) ? context : {}; },
    onClearLearning: () => clearLearning(),
    onStart: (started) => {
      shell = started;
      // Expired stored fills leave the file at start, as the learning corpus does.
      loadData();
    },
    onStop: () => { shell = null; },
    simulate: (sim) => simulate(sim, { host, createApp, app }),
  };
  return app;
}

module.exports = { createApp, NO_FORM_NOTE, SELECTORS_NOTE, SIZE: layout.SIZE, FOCUS_DELAY_MS, OWN_TRIGGER, PAUSED };
