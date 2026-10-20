// Writing pad storage: drafts, Recently deleted drafts, pad preferences,
// dismissed phrase suggestions and the text of tabs that closed before their
// last save finished. Everything lives in chrome.storage.local in
// both browsers: never in sync storage and never in the library's JSON export.
// Every key starts with "pad-", which storage.isLibraryChange ignores, so an
// autosave does not make open pages reload the library.
(function (root) {
  "use strict";

  const DRAFT_PREFIX = "pad-draft:";
  const TRASH_KEY = "pad-trash";
  const PREFS_KEY = "pad-prefs";
  const DISMISSED_KEY = "pad-dismissed";
  const RESCUE_PREFIX = "pad-rescue:";
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
  // has one (current Chrome and Firefox do), which makes saveDraft's read,
  // rev check and write one step. Without a lock manager, or when it refuses
  // the request, the pad still saves, but two tabs saving the same draft at
  // the same moment could both pass the rev check and the later write would
  // win.
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

  // `id` lets the page name a new draft before it is first saved (newDraftId),
  // so that text rescued while that first save runs finds the same draft.
  async function createDraft({ title = "", body = "", id = null } = {}) {
    return withWriteLock(async () => {
      const now = Date.now();
      const draft = { id: typeof id === "string" && id ? id : newId(), title: String(title), body: String(body), createdAt: now, updatedAt: now, rev: 1 };
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
  // nothing is deleted and the error (code "NOT_KEPT", with the browser's
  // reason) says why; the page may then pass { withoutCopy: true } once the
  // person agrees, as when storage is too full to hold the copy.
  async function deleteDraft(id, options = {}) {
    return withWriteLock(async () => {
      const draft = await readDraft(String(id));
      if (!draft) return { deleted: false };
      const entry = { ...draft, deletedAt: Date.now() };
      let before = null;
      if (!options.withoutCopy) {
        try {
          before = await getTrash();
          // An older copy under this id with other text stays, under an id of its own.
          const older = before.flatMap((old) => old.id !== draft.id ? [old] : sameText(old, draft) ? [] : [{ ...old, id: newId() }]);
          await writeTrash([entry, ...older].slice(0, TRASH_LIMIT));
        } catch (cause) {
          const reason = cause && cause.message ? cause.message : String(cause);
          const error = new Error("It could not be kept in Recently deleted drafts (" + reason + "), so it was not deleted.");
          error.code = "NOT_KEPT";
          error.reason = reason;
          throw error;
        }
      }
      try {
        await area().remove(DRAFT_PREFIX + draft.id);
      } catch (error) {
        // It is still a draft, so it should not also be listed as deleted.
        if (before) await writeTrash(before).catch(() => {});
        throw error;
      }
      return options.withoutCopy ? { deleted: true, kept: false } : { deleted: true, kept: true, entry };
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

  // ---- text a closing tab could not save ------------------------------------
  //
  // A save needs a lock, a read and a write, and none of that finishes once a
  // tab is closed or reloaded. So as a pad tab goes away with unsaved text it
  // makes one write that needs neither: pad-rescue:<tab>. A later pad tab puts
  // that text where it belongs with recoverRescue, once the tab that wrote it
  // is gone.

  function sanitizeText(value) {
    return value && typeof value === "object" && typeof value.title === "string" && typeof value.body === "string"
      ? { title: value.title, body: value.body } : null;
  }

  function sanitizeRescue(value) {
    const text = sanitizeText(value);
    if (!text || Array.isArray(value)) return null;
    if (typeof value.draftId !== "string" || !value.draftId || !Number.isInteger(value.baseRev) || value.baseRev < 0) return null;
    return { draftId: value.draftId, baseRev: value.baseRev, ...text, saving: sanitizeText(value.saving) };
  }

  // draftId and baseRev: the open draft and the rev this tab last saw (0 for
  // a new draft whose first save has not landed, under the id it will get);
  // saving: the text of a save still running, which may land after all.
  // Never throws: it runs as the page goes away, where nobody could see an error.
  function writeRescue(tab, { draftId, baseRev, title = "", body = "", saving = null } = {}) {
    try {
      const entry = { draftId, baseRev, title: String(title), body: String(body), saving, at: Date.now() };
      return Promise.resolve(area().set({ [RESCUE_PREFIX + tab]: entry })).catch(() => {});
    } catch (_) {
      return Promise.resolve();
    }
  }

  function clearRescue(tab) {
    return withWriteLock(() => area().remove(RESCUE_PREFIX + tab));
  }

  /** The tabs that left text to recover. */
  async function rescuedTabs() {
    const items = await area().get(null);
    return Object.keys(items || {}).filter((key) => key.startsWith(RESCUE_PREFIX)).map((key) => key.slice(RESCUE_PREFIX.length));
  }

  // Puts a closed tab's unsaved text where the save would have: over its draft
  // when no other save came in between (the rev is the one it started from,
  // or the next one holding exactly the text its running save was writing),
  // under its own id when its first save never landed, else into a new draft
  // titled copyTitle(text), so nothing is overwritten. The rescue is removed
  // only after the text is stored. Resolves { draft, inPlace } with the draft
  // that now holds the text (stored already when its save landed after all),
  // or null when there was nothing to keep.
  async function recoverRescue(tab, copyTitle = (text) => text.title) {
    return withWriteLock(async () => {
      const key = RESCUE_PREFIX + tab;
      const items = await area().get(key);
      const entry = sanitizeRescue(items && items[key]);
      let result = null;
      if (entry) {
        const stored = await readDraft(entry.draftId);
        const now = Date.now();
        const own = stored && (stored.rev === entry.baseRev
          || (stored.rev === entry.baseRev + 1 && entry.saving && sameText(stored, entry.saving)));
        let draft = null;
        if (stored && sameText(stored, entry)) {
          // That save landed after all.
          result = { draft: stored, inPlace: true };
        } else if (own) {
          draft = { ...stored, title: entry.title, body: entry.body, updatedAt: now, rev: stored.rev + 1 };
        } else if (!stored && entry.baseRev === 0) {
          // A new draft whose first save never landed.
          if (entry.title.trim() || entry.body.trim()) draft = { id: entry.draftId, title: entry.title, body: entry.body, createdAt: now, updatedAt: now, rev: 1 };
        } else {
          // Saved again or deleted in another tab since: keep both.
          draft = { id: newId(), title: String(copyTitle({ title: entry.title, body: entry.body })), body: entry.body, createdAt: now, updatedAt: now, rev: 1 };
        }
        if (draft) {
          await area().set({ [DRAFT_PREFIX + draft.id]: draftRecord(draft) });
          result = { draft, inPlace: draft.id === entry.draftId };
        }
      }
      await area().remove(key);
      return result;
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

  function clearDismissed() {
    return withWriteLock(() => area().remove(DISMISSED_KEY));
  }

  function isPadKey(key) {
    return typeof key === "string" && key.startsWith("pad-");
  }

  root.ActlePadStore = {
    listDrafts,
    getDraft,
    createDraft,
    newDraftId: newId,
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
    clearDismissed,
    writeRescue,
    clearRescue,
    rescuedTabs,
    recoverRescue,
    countWords,
    normalizePhrase,
    fileNameFor,
    isPadKey,
    DRAFT_PREFIX,
    TRASH_KEY,
    PREFS_KEY,
    DISMISSED_KEY,
    RESCUE_PREFIX,
    TRASH_LIMIT,
    DISMISSED_LIMIT,
    DEFAULT_PREFS,
  };
})(typeof self !== "undefined" ? self : this);
