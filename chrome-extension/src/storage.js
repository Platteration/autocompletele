// Storage helper shared by the options page, popup, content script and worker.
// Each shorthand is kept under its own key ("sh:<id>"). Chrome uses sync storage;
// Firefox uses local storage. Separate keys avoid Chrome's 8 KB per-item limit.
(function (root) {
  "use strict";

  const PREFIX = "sh:";
  const SETTINGS_KEY = "settings";
  const JOURNAL_KEY = "shorthand-import-journal";
  const BACKUP_KEY = "shorthand-import-backup";
  const USAGE_KEY = "shorthand-usage-counts";
  const DRAFT_KEY = "shorthand-pending-draft";
  const TRASH_KEY = "shorthand-trash";
  const TRASH_LIMIT = 50;
  const AREA = chrome.runtime.getManifest().browser_specific_settings?.gecko ? "local" : "sync";
  const dataStore = chrome.storage[AREA];
  const encoder = new TextEncoder();
  let writes = Promise.resolve();
  let usageWrites = Promise.resolve();
  // pickerTrigger opens the search overlay; an empty string turns it off.
  // phraseWords: words typed before a saved paragraph is offered; 0 is off.
  const DEFAULT_SETTINGS = { enabled: true, excludedHosts: [], pickerTrigger: ";;", animationMode: "expand", suggestionsEnabled: true, phraseWords: 3 };

  function animationMode(value) {
    return ["expand", "casino", "off"].includes(value) ? value : DEFAULT_SETTINGS.animationMode;
  }

  function suggestionsEnabled(value) {
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS.suggestionsEnabled;
  }

  function phraseWords(value) {
    return value === 0 || (Number.isInteger(value) && value >= 2 && value <= 6) ? value : DEFAULT_SETTINGS.phraseWords;
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function getAll() {
    const items = await dataStore.get(null);
    const shorthands = [];
    for (const [key, value] of Object.entries(items)) {
      if (!key.startsWith(PREFIX) || !value || typeof value !== "object") continue;
      shorthands.push({
        id: key.slice(PREFIX.length),
        trigger: String(value.trigger || ""),
        expansion: String(value.expansion || ""),
        order: typeof value.order === "number" ? value.order : 0,
      });
    }
    shorthands.sort((a, b) => a.order - b.order || a.trigger.localeCompare(b.trigger));
    const settings = Object.assign({}, DEFAULT_SETTINGS, items[SETTINGS_KEY] || {});
    settings.animationMode = animationMode(settings.animationMode);
    settings.suggestionsEnabled = suggestionsEnabled(settings.suggestionsEnabled);
    settings.phraseWords = phraseWords(settings.phraseWords);
    return { shorthands, settings };
  }

  // Per-snippet use counts ranking suggestions and search. They are a local
  // convenience only: always storage.local, never synced, never exported,
  // and keyed by shorthand id so renaming a trigger keeps its history.
  function sanitizeUsageCounts(value) {
    const counts = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return counts;
    for (const [id, count] of Object.entries(value)) {
      if (Number.isFinite(count) && count > 0) counts[id] = Math.floor(count);
    }
    return counts;
  }

  async function getUsageCounts() {
    if (!chrome.storage.local) return {};
    const items = await chrome.storage.local.get(USAGE_KEY);
    return sanitizeUsageCounts(items[USAGE_KEY]);
  }

  function recordUse(id) {
    if (!id || !chrome.storage.local) return Promise.resolve();
    // Best effort and approximate across tabs: a lost increment only
    // slightly delays a snippet's rise in the rankings.
    usageWrites = usageWrites.then(async () => {
      const counts = await getUsageCounts();
      counts[id] = (counts[id] || 0) + 1;
      await chrome.storage.local.set({ [USAGE_KEY]: counts });
    }).catch(() => {});
    return usageWrites;
  }

  // Text the person picked with "Save selection as actle shorthand", held in
  // local storage only until the library page consumes it once as a prefilled
  // draft. It is never synced, and saving still needs their trigger and click.
  async function savePendingDraft(text) {
    const expansion = String(text == null ? "" : text);
    if (!expansion || !chrome.storage.local) return false;
    await chrome.storage.local.set({ [DRAFT_KEY]: { expansion, createdAt: Date.now() } });
    return true;
  }

  async function takePendingDraft() {
    if (!chrome.storage.local) return "";
    const items = await chrome.storage.local.get(DRAFT_KEY);
    const draft = items[DRAFT_KEY];
    if (!draft || typeof draft.expansion !== "string" || !draft.expansion) return "";
    await chrome.storage.local.remove(DRAFT_KEY);
    return draft.expansion;
  }

  // Firefox keeps the library in storage.local beside premium accounting, use
  // counts, the selection draft and Recently deleted. Only library or settings
  // changes should make a page reload them; otherwise every expansion in any
  // tab would. Every Writing pad key starts with "pad-" (pad-store.js), and
  // the pad autosaves as the person types.
  const NON_LIBRARY_KEYS = new Set(["actle-premium", USAGE_KEY, DRAFT_KEY, TRASH_KEY]);
  const NON_LIBRARY_PREFIX = "pad-";

  function isLibraryChange(changes, area) {
    return area === AREA && Object.keys(changes || {}).some((key) => !NON_LIBRARY_KEYS.has(key) && !key.startsWith(NON_LIBRARY_PREFIX));
  }

  async function saveShorthand(sh) {
    return withWriteLock(async () => {
      await recoverImport();
      const id = sh.id || newId();
      const order = typeof sh.order === "number" ? sh.order : Date.now();
      await dataStore.set({
        [PREFIX + id]: { trigger: sh.trigger, expansion: sh.expansion, order },
      });
      return id;
    });
  }

  // First-install examples: add-only, and only while the library is still empty
  // under the write lock. On Chrome a synced library can arrive at any moment;
  // replacing here would delete it. Fixed ids make two devices that both seed
  // write the same records instead of duplicates.
  async function seedExamples(list) {
    return withWriteLock(async () => {
      await recoverImport();
      if (Object.keys(records(await dataStore.get(null))).length) return false;
      const payload = {};
      list.forEach((sh, order) => {
        payload[PREFIX + "example-" + sh.trigger.replace(/[^a-z0-9]/gi, "")] = { trigger: sh.trigger, expansion: sh.expansion, order };
      });
      await dataStore.set(payload);
      return true;
    });
  }

  // Recently deleted: copies of deleted shorthands, newest first, at most
  // TRASH_LIMIT. Always storage.local, in both browsers: never synced, never
  // exported, and outside Chrome's sync quota.
  function sanitizeTrash(value) {
    const entries = [];
    if (!Array.isArray(value)) return entries;
    const seen = new Set();
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { id, trigger, expansion, order, deletedAt } = entry;
      if (typeof id !== "string" || !id || typeof trigger !== "string" || typeof expansion !== "string") continue;
      if (seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id, trigger, expansion,
        order: Number.isFinite(order) ? order : 0,
        // A Date holds at most 8.64e15 ms either side of 1970; the page shows it as one.
        deletedAt: Number.isFinite(deletedAt) && Math.abs(deletedAt) <= 8.64e15 ? deletedAt : null,
      });
    }
    return entries;
  }

  async function getTrash() {
    const items = await chrome.storage.local.get(TRASH_KEY);
    return sanitizeTrash(items[TRASH_KEY]);
  }

  function writeTrash(entries) {
    return entries.length ? chrome.storage.local.set({ [TRASH_KEY]: entries }) : chrome.storage.local.remove(TRASH_KEY);
  }

  // An id alone does not say which words a shorthand held: the examples use
  // fixed ids, and sync can bring an id back with other text.
  function sameText(record, entry) {
    return String(record.trigger || "") === entry.trigger && String(record.expansion || "") === entry.expansion;
  }

  // The copy is written before the record is removed. When it cannot be,
  // nothing is deleted and the error carries code "NOT_KEPT"; the page may
  // then pass { withoutCopy: true } once the person agrees.
  async function deleteShorthand(id, options = {}) {
    return withWriteLock(async () => {
      await recoverImport();
      const key = PREFIX + id;
      const value = (await dataStore.get(key))[key];
      if (!value || typeof value !== "object") return { deleted: false, kept: false };
      const trigger = String(value.trigger || "");
      let before = null;
      if (!options.withoutCopy) {
        try {
          before = await getTrash();
          const entry = {
            id, trigger, expansion: String(value.expansion || ""),
            order: typeof value.order === "number" ? value.order : 0, deletedAt: Date.now(),
          };
          // An older copy under this id with other text stays, under an id of its own.
          const older = before.flatMap((old) => old.id !== id ? [old] : sameText(old, entry) ? [] : [{ ...old, id: newId() }]);
          await writeTrash([entry, ...older].slice(0, TRASH_LIMIT));
        } catch (cause) {
          const error = new Error(trigger + " could not be kept in Recently deleted: " + (cause && cause.message ? cause.message : cause));
          error.code = "NOT_KEPT";
          error.trigger = trigger;
          throw error;
        }
      }
      try {
        await dataStore.remove(key);
      } catch (error) {
        // It is still in the library, so it should not also be listed as deleted.
        if (before) await writeTrash(before).catch(() => {});
        throw error;
      }
      return { deleted: true, kept: !options.withoutCopy, trigger };
    });
  }

  // Puts a Recently deleted shorthand back under its original id and order
  // (a new id when that one came back holding other text). A refusal keeps
  // the entry and returns the message for the page to show.
  async function restoreDeleted(id) {
    return withWriteLock(async () => {
      await recoverImport();
      const trash = await getTrash();
      const entry = trash.find((item) => item.id === id);
      const rest = trash.filter((item) => item.id !== id);
      const existing = await dataStore.get(null);
      const current = existing[PREFIX + id];
      const taken = !!current && typeof current === "object";
      if (taken && (!entry || sameText(current, entry))) {
        // Already back, for example synced from another device: drop the copy.
        if (entry) await writeTrash(rest);
        return { restored: true, alreadyThere: true, id, trigger: String(current.trigger || "") };
      }
      if (!entry) return { restored: false, message: "That shorthand is no longer in Recently deleted." };
      // The id came back holding other text: this copy returns as a shorthand
      // of its own rather than being dropped or overwriting that one.
      const key = PREFIX + (taken ? newId() : id);
      if (Object.values(records(existing)).some((value) => value && value.trigger === entry.trigger)) {
        return { restored: false, trigger: entry.trigger, message: entry.trigger + " is already in your library. Rename or delete that one first." };
      }
      const value = { trigger: entry.trigger, expansion: entry.expansion, order: entry.order };
      const reason = quotaError({ ...existing, [key]: value });
      if (reason) {
        return { restored: false, trigger: entry.trigger,
          message: entry.trigger + " would exceed the " + reason + ", so it stays in Recently deleted. Delete or shorten another shorthand first." };
      }
      await dataStore.set({ [key]: value });
      // A copy left behind by a failed cleanup is harmless: while the
      // restored shorthand is unchanged, restoring it again only drops the copy.
      await writeTrash(rest).catch(() => {});
      return { restored: true, id: key.slice(PREFIX.length), trigger: entry.trigger };
    });
  }

  async function forgetDeleted(id) {
    return withWriteLock(async () => {
      const trash = await getTrash();
      const rest = trash.filter((item) => item.id !== id);
      if (rest.length !== trash.length) await writeTrash(rest);
    });
  }

  async function emptyTrash() {
    return withWriteLock(() => chrome.storage.local.remove(TRASH_KEY));
  }

  function withWriteLock(fn) {
    const run = () => {
      if (typeof navigator === "undefined") return fn(); // non-browser tests
      if (!navigator.locks) throw new Error("The storage writer lock is unavailable. Export your library before editing in this browser");
      return navigator.locks.request("shorthand-storage-write", fn);
    };
    const result = writes.then(run, run);
    writes = result.catch(() => {});
    return result;
  }

  function records(items) {
    return Object.fromEntries(Object.entries(items).filter(([key]) => key.startsWith(PREFIX)));
  }

  function quotaError(items) {
    // Chrome sync enforces item-count, per-item and total-byte quotas. storage.local
    // has no item limits; Chrome caps its total bytes and Firefox does not.
    const limits = AREA === "sync"
      ? { items: dataStore.MAX_ITEMS || 512, perItem: dataStore.QUOTA_BYTES_PER_ITEM || 8192, total: dataStore.QUOTA_BYTES || 102400 }
      : { items: Infinity, perItem: Infinity, total: dataStore.QUOTA_BYTES || Infinity };
    const entries = Object.entries(items);
    if (entries.length > limits.items) return AREA + " item-count limit";
    let total = 0;
    for (const [key, value] of entries) {
      const bytes = encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
      if (bytes > limits.perItem) return AREA + " per-item limit";
      total += bytes;
    }
    return total > limits.total ? AREA + " total-byte limit" : null;
  }

  function sameRecord(a, b) {
    if (a === undefined || b === undefined) return a === b;
    return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  }

  async function requireUnchanged(keys, expected) {
    const current = records(await dataStore.get(null));
    if (keys.some((key) => !sameRecord(current[key], expected[key]))) throw new Error("Library changed during import; retry using the latest synced records");
  }

  async function restoreRecords(before, payload) {
    const current = records(await dataStore.get(null));
    const changes = {}, obsolete = [], conflicts = [];
    const attempted = payload || {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(attempted)])) {
      if (sameRecord(current[key], before[key])) continue;
      // Undo only values identifiable as this import's work. Remote edits and
      // unrelated new keys are preserved, including with older journals that
      // did not record the attempted payload.
      const ours = payload ? sameRecord(current[key], attempted[key]) : current[key] === undefined;
      if (!ours) { conflicts.push(key); continue; }
      if (before[key] === undefined) obsolete.push(key);
      else changes[key] = before[key];
    }
    if (obsolete.length) await dataStore.remove(obsolete);
    if (Object.keys(changes).length) await dataStore.set(changes);
    const restored = records(await dataStore.get(null));
    if (obsolete.some((key) => restored[key] !== undefined) || Object.keys(changes).some((key) => !sameRecord(restored[key], changes[key]))) throw new Error("Original library could not be restored; its local backup is retained");
    return { conflicts };
  }

  async function recoverImport() {
    const saved = await chrome.storage.local.get(JOURNAL_KEY);
    const journal = saved[JOURNAL_KEY];
    if (!journal) return { conflicts: [] };
    const result = !journal.committed ? await restoreRecords(journal.before, journal.payload) : { conflicts: [] };
    await chrome.storage.local.remove(JOURNAL_KEY);
    return result;
  }

  /** Resume an interrupted import before the options page permits editing. */
  function recoverPendingImport() { return withWriteLock(recoverImport); }

  async function getImportBackup() {
    const saved = await chrome.storage.local.get(BACKUP_KEY);
    const backup = saved[BACKUP_KEY];
    return backup ? Object.values(backup).map((s) => ({ trigger: s.trigger, expansion: s.expansion })) : null;
  }

  /** Import transaction, with a local recovery copy outside sync quotas. */
  async function replaceAll(list, options = {}) {
    return withWriteLock(async () => {
      await recoverImport();
      const existing = await dataStore.get(null);
      const before = records(existing);
      const other = Object.fromEntries(Object.entries(existing).filter(([key]) => !key.startsWith(PREFIX)));
      const byTrigger = new Map(Object.entries(before).map(([key, value]) => [value.trigger, key]));
      let payload = options.merge ? { ...before } : {};
      let nextOrder = Math.max(0, ...Object.values(before).map((value) => typeof value.order === "number" ? value.order : 0)) + 1;
      const skipped = [];
      list.forEach((sh, i) => {
        // Updates reuse the trigger's existing key, so they need no second storage slot.
        const key = byTrigger.get(sh.trigger) || PREFIX + newId();
        const order = options.merge ? (before[key] ? before[key].order : nextOrder++) : i;
        const value = { trigger: sh.trigger, expansion: sh.expansion, order };
        const reason = quotaError({ ...other, ...payload, [key]: value });
        if (reason) skipped.push({ trigger: sh.trigger, reason });
        else payload[key] = value;
      });
      if (skipped.length) {
        // An incomplete replacement must not discard the user's library.
        // Apply the entries that fit as a merge and warn about each skip.
        const accepted = Object.entries(payload);
        payload = { ...before };
        for (const [key, value] of accepted) {
          const reason = quotaError({ ...other, ...payload, [key]: value });
          if (reason) skipped.push({ trigger: value.trigger, reason });
          else payload[key] = value;
        }
      }
      const reason = quotaError({ ...other, ...payload });
      if (reason) throw new Error("Original library exceeds the " + reason + "; export it before importing");
      const toRemove = Object.keys(before).filter((key) => !Object.prototype.hasOwnProperty.call(payload, key));
      // Both writes must succeed before the library's storage is touched.
      await chrome.storage.local.set({ [BACKUP_KEY]: before, [JOURNAL_KEY]: { before, payload, committed: false } });
      try {
        // Prefer writing first. Only free obsolete keys first when the
        // temporary union would exceed a quota; the journal covers that case.
        const removeFirst = !!quotaError({ ...existing, ...payload });
        if (removeFirst && toRemove.length) {
          await requireUnchanged(toRemove, before);
          await dataStore.remove(toRemove);
        }
        await requireUnchanged(Object.keys(payload), before);
        if (Object.keys(payload).length) await dataStore.set(payload);
        if (!removeFirst && toRemove.length) {
          await requireUnchanged(toRemove, before);
          await dataStore.remove(toRemove);
        }
        const actual = records(await dataStore.get(null));
        // Compare record by record: the browser returns dictionaries with their
        // keys alphabetised, so a serialised comparison rejects every write.
        const persisted = new Set([...Object.keys(actual), ...Object.keys(payload)]);
        if ([...persisted].some((key) => !sameRecord(actual[key], payload[key]))) throw new Error("Imported library did not persist completely");
        await chrome.storage.local.set({ [JOURNAL_KEY]: { before, payload, committed: true } });
      } catch (error) {
        let recovery;
        try {
          recovery = await restoreRecords(before, payload);
          await chrome.storage.local.remove(JOURNAL_KEY);
        } catch (_) {
          throw new Error("Import interrupted. Your original library is saved locally; reopen options to retry recovery or export the pre-import backup. " + error.message);
        }
        if (recovery.conflicts.length) throw new Error("Import failed; concurrent edits were preserved. Export the pre-import backup to review originals. " + error.message);
        throw error;
      }
      // Cleanup failure is harmless: recovery sees committed=true.
      await chrome.storage.local.remove(JOURNAL_KEY).catch(() => {});
      return { skipped, preservedExisting: skipped.length > 0 };
    });
  }

  async function saveSettings(patch) {
    return withWriteLock(async () => {
      await recoverImport();
      const { settings } = await getAll();
      const next = Object.assign({}, settings, patch);
      next.animationMode = animationMode(next.animationMode);
      next.suggestionsEnabled = suggestionsEnabled(next.suggestionsEnabled);
      next.phraseWords = phraseWords(next.phraseWords);
      await dataStore.set({ [SETTINGS_KEY]: next });
      return next;
    });
  }

  /** Serialise to the cross-platform file format described in shared/SPEC.md. */
  function toExportJson(shorthands) {
    return JSON.stringify(
      {
        version: 1,
        shorthands: shorthands.map((s) => ({ trigger: s.trigger, expansion: s.expansion })),
      },
      null,
      2
    );
  }

  root.ShorthandStorage = {
    getAll,
    saveShorthand,
    deleteShorthand,
    getTrash,
    restoreDeleted,
    forgetDeleted,
    emptyTrash,
    replaceAll,
    recoverPendingImport,
    getImportBackup,
    saveSettings,
    seedExamples,
    getUsageCounts,
    recordUse,
    savePendingDraft,
    takePendingDraft,
    isLibraryChange,
    toExportJson,
    DEFAULT_SETTINGS,
    AREA,
    TRASH_KEY,
    TRASH_LIMIT,
  };
})(typeof self !== "undefined" ? self : this);
