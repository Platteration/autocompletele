// The headless assistant. A desktop shell feeds it key presses and focus
// changes and carries out the actions it returns (delete the trigger, type the
// expansion, open a template form, list documents, offer a keyword insert).
// Nothing here touches the keyboard, the screen or the disk.
"use strict";

const { expander, template } = require("./personal.js");
const capture = require("./capture-policy.js");
const keywords = require("./keyword-rules.js");
const documents = require("./documents.js");
const metrics = require("./metrics.js");
const orgPolicy = require("./org-policy.js");

const DEFAULTS = Object.freeze({
  maxBuffer: 200,
  // Keyword and compliance rules look at the current field's text, held in
  // memory only, only while the policy has such rules, and never written.
  maxFieldText: 4000,
  minSessionLength: 20,
  // Whether the input adapter swallows the key that completes a trigger (the
  // Windows hook does; uiohook-style listeners cannot, so the character
  // reaches the field and must be deleted too).
  swallowsTriggerKey: false,
});

function mergeLibraries(personal, organization) {
  const own = expander.sanitizeList(personal);
  const seen = new Set(own.map((sh) => sh.trigger));
  const shared = expander.sanitizeList(organization).filter((sh) => !seen.has(sh.trigger));
  return own.map((sh) => Object.assign({ source: "personal" }, sh))
    .concat(shared.map((sh) => Object.assign({ source: "organization" }, sh)));
}

function popGrapheme(text) {
  if (!text) return text;
  let remove = 1;
  const last = text.charCodeAt(text.length - 1);
  if (text.length > 1 && last >= 0xdc00 && last <= 0xdfff) {
    const prev = text.charCodeAt(text.length - 2);
    if (prev >= 0xd800 && prev <= 0xdbff) remove = 2;
  }
  return text.slice(0, -remove);
}

function createEngine(options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const now = typeof settings.now === "function" ? settings.now : () => Date.now();
  const ledger = settings.ledger || metrics.createLedger({ now });
  let policy = settings.policy && Array.isArray(settings.policy.keywordRules) ? settings.policy : orgPolicy.parse(settings.policy);
  let personal = expander.sanitizeList(settings.library);
  let library = mergeLibraries(personal, policy.library);
  const keywordState = keywords.createState();

  let buffer = "";
  let fieldText = "";
  let context = {};
  let decision = { mode: policy.capture.defaultMode, reason: "default", rule: null };
  let session = null;
  let undo = null;
  let pendingRecord = null;
  let enabled = true;

  function decideMode() {
    if (policy.paused && policy.paused.active) return { mode: "off", reason: "paused by the organisation", rule: null };
    if (!enabled) return { mode: "off", reason: "paused", rule: null };
    return capture.decide(context, policy.capture);
  }

  function appName() {
    return capture.baseName(context.process) || String(context.app || "").trim() || "";
  }

  function commitPending() {
    if (!pendingRecord) return;
    const entry = pendingRecord;
    pendingRecord = null;
    ledger.record(entry);
  }

  function clearUndo() {
    undo = null;
    commitPending();
  }

  function startSession() {
    session = { app: appName(), startedAt: now(), text: "", redactions: 0 };
  }

  function flushSession() {
    const ended = session;
    session = null;
    if (!ended) return null;
    const scrubbed = capture.scrub(ended.text);
    if (scrubbed.text.trim().length < settings.minSessionLength) return null;
    return { app: ended.app, startedAt: ended.startedAt, endedAt: now(), text: scrubbed.text, redactions: scrubbed.redactions };
  }

  function tracksField() {
    return policy.keywordRules.length > 0;
  }

  function capField() {
    if (fieldText.length > settings.maxFieldText) fieldText = fieldText.slice(fieldText.length - settings.maxFieldText);
  }

  function sessionAppend(text) {
    if (session) session.text += text;
    if (tracksField()) {
      fieldText += text;
      capField();
    }
  }

  // Learning is about what the person types. Where actle inserts text, the
  // learning session gets a paragraph break instead, so the miner never
  // proposes actle's own output (a signature, an address) back as a phrase.
  // The field text keeps the insertion: a disclaimer inserted by a shortcut
  // must count for compliance rules.
  const LEARN_GAP = "\n\n";

  function sessionTail(remove, add) {
    if (!session) return;
    if (remove > 0) session.text = session.text.slice(0, Math.max(0, session.text.length - remove));
    session.text += add;
  }

  function fieldTail(remove, add) {
    if (!tracksField()) return;
    if (remove > 0) fieldText = fieldText.slice(0, Math.max(0, fieldText.length - remove));
    fieldText += add;
    capField();
  }

  /** actle replaced `typedChars` just typed with `inserted`. */
  function insertedText(typedChars, inserted) {
    sessionTail(typedChars, inserted ? LEARN_GAP : "");
    fieldTail(typedChars, inserted);
  }

  /** Tell the engine which window has the focus. Returns the learning session that just ended, if any. */
  function focusChanged(nextContext) {
    clearUndo();
    buffer = "";
    fieldText = "";
    keywordState.reset();
    const ended = flushSession();
    context = nextContext && typeof nextContext === "object" ? Object.assign({}, nextContext) : {};
    decision = decideMode();
    if (decision.mode === "learn") startSession();
    return { mode: decision.mode, reason: decision.reason, session: ended };
  }

  /** End the current field session without a new focus (shutdown, pause). */
  function endSession() {
    clearUndo();
    buffer = "";
    fieldText = "";
    keywordState.reset();
    const ended = flushSession();
    if (decision.mode === "learn") startSession();
    return ended;
  }

  function expandAction(match, keyText) {
    const sh = match.shorthand;
    const typedInField = settings.swallowsTriggerKey ? sh.trigger.length - keyText.length : sh.trigger.length;
    const backspaces = Math.max(0, typedInField);
    buffer = "";
    if (template.requiresInput(sh.expansion)) {
      return {
        type: "template",
        trigger: sh.trigger,
        expansion: sh.expansion,
        fields: template.fields(sh.expansion),
        variables: template.variables(sh.expansion),
        backspaces,
        source: sh.source,
      };
    }
    const rendered = template.render(sh.expansion, null, new Date(now()));
    undo = { trigger: sh.trigger, text: rendered.text, cursorOffset: rendered.cursorOffset, learned: rendered.text ? LEARN_GAP.length : 0 };
    pendingRecord = { kind: "expansion", trigger: sh.trigger, source: sh.source, inserted: rendered.text, typed: sh.trigger, app: appName() };
    insertedText(sh.trigger.length, rendered.text);
    return {
      type: "expand",
      trigger: sh.trigger,
      text: rendered.text,
      cursorOffset: rendered.cursorOffset,
      backspaces,
      keystrokesSaved: metrics.keystrokesSaved(rendered.text, sh.trigger),
      source: sh.source,
    };
  }

  /**
   * Feed one key press. `key` is {text, isBackspace, resetsBuffer}; text is the
   * characters the key produced ("" for non-text keys).
   * @returns {Array<object>} actions for the shell, possibly empty
   */
  function keyTyped(key) {
    const k = key && typeof key === "object" ? key : { text: String(key == null ? "" : key) };
    const text = String(k.text == null ? "" : k.text);
    if (decision.mode === "off") return [];

    if (k.isBackspace && undo) {
      const reverted = undo;
      undo = null;
      pendingRecord = null;
      buffer = reverted.trigger;
      sessionTail(reverted.learned, reverted.trigger);
      fieldTail(reverted.text.length, reverted.trigger);
      return [{
        type: "undo",
        trigger: reverted.trigger,
        charsBeforeCaret: reverted.cursorOffset,
        charsAfterCaret: reverted.text.length - reverted.cursorOffset,
      }];
    }
    // A modifier or dead key on its own keeps the undo window open.
    if (!k.isBackspace && !k.resetsBuffer && text.length === 0) return [];
    clearUndo();

    if (k.isBackspace) {
      buffer = popGrapheme(buffer);
      if (session) session.text = popGrapheme(session.text);
      fieldText = popGrapheme(fieldText);
      return [];
    }
    if (k.resetsBuffer) {
      buffer = "";
      if (text === "\n" || text === "\t") sessionAppend(text);
      return [];
    }
    if (context.ownWindow) {
      buffer = "";
      return [];
    }

    buffer += text;
    if (buffer.length > settings.maxBuffer) buffer = buffer.slice(buffer.length - settings.maxBuffer);
    sessionAppend(text);

    const actions = [];
    const match = expander.findMatch(buffer, library);
    if (match) {
      actions.push(expandAction(match, text));
      return actions;
    }
    const doc = documents.findShortcut(buffer, policy.documents);
    if (doc) {
      const typedInField = settings.swallowsTriggerKey ? doc.shortcut.trigger.length - text.length : doc.shortcut.trigger.length;
      buffer = "";
      insertedText(doc.shortcut.trigger.length, "");
      actions.push({
        type: "documents",
        trigger: doc.shortcut.trigger,
        label: doc.shortcut.label,
        documents: doc.shortcut.documents.slice(),
        backspaces: Math.max(0, typedInField),
      });
      return actions;
    }
    // Keywords are checked when a word ends, so "invoices" is not offered on "inv".
    if (policy.keywordRules.length && !expander.isBoundary(buffer[buffer.length - 2]) && expander.isBoundary(text[text.length - 1])) {
      const hits = keywords.detect(fieldText, policy.keywordRules, keywordState);
      const warnings = hits.filter((hit) => hit.rule.action === "warn");
      const offers = hits.filter((hit) => hit.rule.action !== "warn");
      if (warnings.length) actions.push({ type: "warning", hits: warnings });
      if (offers.length) actions.push({ type: "keyword", hits: offers });
    }
    return actions;
  }

  /**
   * Record something the shell inserted on the person's behalf after a
   * template form, a keyword offer, a document attachment or a suggestion.
   */
  function recordInsert(event) {
    const data = event && typeof event === "object" ? event : {};
    const kind = metrics.KINDS.includes(data.kind) ? data.kind : "suggestion";
    const inserted = String(data.inserted == null ? "" : data.inserted);
    const typed = String(data.typed == null ? "" : data.typed);
    // Keystrokes spent outside the field (a palette query and its Enter key)
    // are subtracted so the statistics do not flatter the palette.
    const spent = Math.max(0, Math.floor(Number(data.spentKeystrokes) || 0));
    if (inserted) insertedText(typed.length, inserted);
    const fixedSeconds = kind === "document"
      ? Math.max(1, Math.floor(Number(data.count) || 1)) * policy.typing.secondsPerAttachment
      : Number(data.fixedSeconds) || 0;
    // Keyword rules and document sets only exist in the organisation policy.
    const source = kind === "document" || kind === "keyword" ? "organization" : data.source;
    const keystrokesSaved = Math.max(0, metrics.keystrokesSaved(inserted, typed) - spent);
    return ledger.record({ kind, trigger: data.trigger, source, keystrokesSaved, fixedSeconds, app: appName() });
  }

  function setLibrary(next) {
    personal = expander.sanitizeList(Array.isArray(next) ? next : next && next.personal);
    library = mergeLibraries(personal, policy.library);
  }

  function setPolicy(next) {
    policy = next && Array.isArray(next.keywordRules) ? next : orgPolicy.parse(next);
    library = mergeLibraries(personal, policy.library);
    if (!tracksField()) fieldText = "";
    ledger.setCharsPerMinute(policy.typing.charsPerMinute);
    decision = decideMode();
    if (decision.mode !== "learn") session = null;
    else if (!session) startSession();
  }

  function setEnabled(value) {
    enabled = value !== false;
    return focusChanged(context);
  }

  return {
    focusChanged,
    endSession,
    keyTyped,
    recordInsert,
    setLibrary,
    setPolicy,
    setEnabled,
    ledger,
    get enabled() { return enabled; },
    get paused() { return !!(policy.paused && policy.paused.active); },
    get mode() { return decision.mode; },
    get decision() { return decision; },
    get context() { return Object.assign({}, context); },
    get buffer() { return buffer; },
    get library() { return library.slice(); },
    get policy() { return policy; },
    get session() { return session ? Object.assign({}, session) : null; },
    get fieldText() { return fieldText; },
  };
}

module.exports = { DEFAULTS, mergeLibraries, createEngine };
