// Writing pad storage: drafts, Recently deleted drafts, pad preferences and
// dismissed phrase suggestions. Everything lives in chrome.storage.local in
// both browsers: never in sync storage and never in the library's JSON export.
// Every key starts with "pad-", which storage.isLibraryChange ignores, so an
// autosave does not make open pages reload the library.
(function (root) {
  "use strict";

  const DRAFT_PREFIX = "pad-draft:";
  const TRASH_KEY = "pad-trash";
  const PREFS_KEY = "pad-prefs";
  const DISMISSED_KEY = "pad-dismissed";
  const TRASH_LIMIT = 20;
  const DISMISSED_LIMIT = 200;
  const WRITE_LOCK = "actle-pad-write";
  const DEFAULT_PREFS = { suggestions: true, lastDraftId: null };
  // A Date holds at most 8.64e15 ms either side of 1970.
  const MAX_TIME = 8.64e15;
  let writes = Promise.resolve();

  // Read chrome.storage.local at call time, never cached, so a page that
  // replaces it (or a test double) is what gets used.
  function area() {
    return chrome.storage.local;
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function time(value) {
    return Number.isFinite(value) && Math.abs(value) <= MAX_TIME ? value : null;
  }

  const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

  function countWords(text) {
    const words = String(text == null ? "" : text).match(WORD);
    return words ? words.length : 0;
  }

  // The same normalization the phrase suggestions compare with: case-insensitive,
  // runs of whitespace collapsed to one space, trimmed.
  function normalizePhrase(text) {
    return String(text == null ? "" : text).toLowerCase().replace(/\s+/g, " ").trim();
  }

  // A plain download name from a draft title (the browser still has the
  // final say over the name it saves under).
  function fileNameFor(title) {
    let base = String(title == null ? "" : title)
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, "");
    if (base.length > 80) base = base.slice(0, 80).trim();
    return (base || "Untitled draft") + ".txt";
  }

  // A stored draft, or null when the value is not one. The key is the id.
  function sanitizeDraft(id, value) {
    if (typeof id !== "string" || !id || !value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.body !== "string") return null;
    const rev = Number.isInteger(value.rev) && value.rev >= 0 ? value.rev : 0;
    return {
      id,
      title: typeof value.title === "string" ? value.title : "",
      body: value.body,
      createdAt: time(value.createdAt),
      updatedAt: time(value.updatedAt),
      rev,
    };
  }

  function draftRecord(draft) {
    return { id: draft.id, title: draft.title, body: draft.body, createdAt: draft.createdAt, updatedAt: draft.updatedAt, rev: draft.rev };
  }

  function sameText(a, b) {
    return a.title === b.title && a.body === b.body;
  }

  // Serialized in this tab, and across tabs with a Web Lock when the browser
  // has one. Without it the pad still saves: the rev check in saveDraft keeps
  // two tabs from overwriting each other's text.
  function withWriteLock(fn) {
    const run = () => {
      const locks = typeof navigator !== "undefined" ? navigator.locks : null;
      if (!locks || typeof locks.request !== "function") return fn();
      let started = false;
      return Promise.resolve().then(() => locks.request(WRITE_LOCK, () => {
        started = true;
        return fn();
      })).catch((error) => {
        if (started) throw error;
        // The lock manager refused the request itself: save anyway.
        return fn();
      });
    };
    const result = writes.then(run, run);
    writes = result.catch(() => {});
    return result;
  }

  async function readDraft(id) {
    const key = DRAFT_PREFIX + id;
    const items = await area().get(key);
    return sanitizeDraft(id, items && items[key]);
  }

  /** Every saved draft, newest edit first, each with its word count. */
  async function listDrafts() {
    const items = await area().get(null);
    const drafts = [];
    for (const [key, value] of Object.entries(items || {})) {
      if (!key.startsWith(DRAFT_PREFIX)) continue;
      const draft = sanitizeDraft(key.slice(DRAFT_PREFIX.length), value);
      if (draft) drafts.push({ ...draft, words: countWords(draft.body) });
    }
    drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return drafts;
  }

  function getDraft(id) {
    return readDraft(String(id));
  }

  async function createDraft({ title = "", body = "" } = {}) {
    return withWriteLock(async () => {
      const now = Date.now();
      const draft = { id: newId(), title: String(title), body: String(body), createdAt: now, updatedAt: now, rev: 1 };
      await area().set({ [DRAFT_PREFIX + draft.id]: draftRecord(draft) });
      return draft;
    });
  }

  // Saves only over the version this tab last saw. When another tab saved
  // first (or deleted the draft), nothing is written and the stored version
  // comes back as `current` (null when it is gone), so the page can keep both.
  async function saveDraft(id, { title = "", body = "" } = {}, baseRev) {
    return withWriteLock(async () => {
      const current = await readDraft(String(id));
      if (!current || current.rev !== baseRev) return { ok: false, conflict: true, current };
      const next = { ...current, title: String(title), body: String(body) };
      if (sameText(next, current)) return { ok: true, draft: current };
      next.updatedAt = Date.now();
      next.rev = current.rev + 1;
      await area().set({ [DRAFT_PREFIX + next.id]: draftRecord(next) });
      return { ok: true, draft: next };
    });
  }

  function sanitizeTrash(value) {
    const entries = [];
    if (!Array.isArray(value)) return entries;
    const seen = new Set();
    for (const item of value) {
      const draft = sanitizeDraft(item && item.id, item);
      if (!draft || seen.has(draft.id)) continue;
      seen.add(draft.id);
      entries.push({ ...draft, deletedAt: time(item.deletedAt) });
    }
    return entries;
  }

  async function getTrash() {
    const items = await area().get(TRASH_KEY);
    return sanitizeTrash(items && items[TRASH_KEY]);
  }

  function writeTrash(entries) {
    return entries.length ? area().set({ [TRASH_KEY]: entries.map((entry) => ({ ...draftRecord(entry), deletedAt: entry.deletedAt })) })
      : area().remove(TRASH_KEY);
  }

  // The copy in Recently deleted drafts is written first. When it cannot be,
  // nothing is deleted and the error (code "NOT_KEPT") says why.
  async function deleteDraft(id) {
    return withWriteLock(async () => {
      const draft = await readDraft(String(id));
      if (!draft) return { deleted: false };
      const entry = { ...draft, deletedAt: Date.now() };
      let before;
      try {
        before = await getTrash();
        // An older copy under this id with other text stays, under an id of its own.
        const older = before.flatMap((old) => old.id !== draft.id ? [old] : sameText(old, draft) ? [] : [{ ...old, id: newId() }]);
        await writeTrash([entry, ...older].slice(0, TRASH_LIMIT));
      } catch (cause) {
        const error = new Error("It could not be kept in Recently deleted drafts (" + (cause && cause.message ? cause.message : String(cause)) + "), so it was not deleted.");
        error.code = "NOT_KEPT";
        throw error;
      }
      try {
        await area().remove(DRAFT_PREFIX + draft.id);
      } catch (error) {
        // It is still a draft, so it should not also be listed as deleted.
        await writeTrash(before).catch(() => {});
        throw error;
      }
      return { deleted: true, entry };
    });
  }

  // Puts a deleted draft back under its own id, or under a new id when that
  // id now holds other text: a restore never overwrites a draft.
  async function restoreDraft(id) {
    return withWriteLock(async () => {
      const trash = await getTrash();
      const entry = trash.find((item) => item.id === id);
      if (!entry) return { restored: false, message: "That draft is no longer in Recently deleted drafts." };
      const rest = trash.filter((item) => item.id !== id);
      const existing = await readDraft(entry.id);
      if (existing && sameText(existing, entry)) {
        await writeTrash(rest).catch(() => {});
        return { restored: true, alreadyThere: true, draft: existing };
      }
      // Under its own id the rev moves past the deleted one, so a tab still
      // holding the old version cannot save over the restored draft unseen.
      const draft = existing
        ? { ...draftRecord(entry), id: newId(), rev: 1 }
        : { ...draftRecord(entry), rev: entry.rev + 1 };
      await area().set({ [DRAFT_PREFIX + draft.id]: draftRecord(draft) });
      // A copy left behind by a failed cleanup is harmless: restoring it
      // again finds the same text and only drops the copy.
      await writeTrash(rest).catch(() => {});
      return { restored: true, draft };
    });
  }

  async function forgetDraft(id) {
    return withWriteLock(async () => {
      const trash = await getTrash();
      const rest = trash.filter((item) => item.id !== id);
      if (rest.length !== trash.length) await writeTrash(rest);
      return rest.length !== trash.length;
    });
  }

  function emptyTrash() {
    return withWriteLock(() => area().remove(TRASH_KEY));
  }

  // Valid fields of `value` over `base`; anything else keeps the base value.
  function sanitizePrefs(value, base = DEFAULT_PREFS) {
    const prefs = { suggestions: base.suggestions, lastDraftId: base.lastDraftId };
    if (!value || typeof value !== "object" || Array.isArray(value)) return prefs;
    if (typeof value.suggestions === "boolean") prefs.suggestions = value.suggestions;
    if (typeof value.lastDraftId === "string" && value.lastDraftId) prefs.lastDraftId = value.lastDraftId;
    return prefs;
  }

  async function getPrefs() {
    const items = await area().get(PREFS_KEY);
    return sanitizePrefs(items && items[PREFS_KEY]);
  }

  async function savePrefs(patch) {
    return withWriteLock(async () => {
      const next = sanitizePrefs(patch, await getPrefs());
      await area().set({ [PREFS_KEY]: next });
      return next;
    });
  }

  function sanitizeDismissed(value) {
    const phrases = [];
    if (!Array.isArray(value)) return phrases;
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== "string") continue;
      const phrase = normalizePhrase(item);
      if (!phrase || seen.has(phrase)) continue;
      seen.add(phrase);
      phrases.push(phrase);
    }
    return phrases.slice(0, DISMISSED_LIMIT);
  }

  async function getDismissed() {
    const items = await area().get(DISMISSED_KEY);
    return sanitizeDismissed(items && items[DISMISSED_KEY]);
  }

  // Newest first; at most DISMISSED_LIMIT are kept, the oldest dropping off.
  async function dismissPhrase(text) {
    const phrase = normalizePhrase(text);
    if (!phrase) return getDismissed();
    return withWriteLock(async () => {
      const next = [phrase, ...(await getDismissed()).filter((item) => item !== phrase)].slice(0, DISMISSED_LIMIT);
      await area().set({ [DISMISSED_KEY]: next });
      return next;
    });
  }

  function isPadKey(key) {
    return typeof key === "string" && key.startsWith("pad-");
  }

  root.ActlePadStore = {
    listDrafts,
    getDraft,
    createDraft,
    saveDraft,
    deleteDraft,
    getTrash,
    restoreDraft,
    forgetDraft,
    emptyTrash,
    getPrefs,
    savePrefs,
    getDismissed,
    dismissPhrase,
    countWords,
    normalizePhrase,
    fileNameFor,
    isPadKey,
    DRAFT_PREFIX,
    TRASH_KEY,
    PREFS_KEY,
    DISMISSED_KEY,
    TRASH_LIMIT,
    DISMISSED_LIMIT,
    DEFAULT_PREFS,
  };
})(typeof self !== "undefined" ? self : this);
