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
  const AREA = chrome.runtime.getManifest().browser_specific_settings?.gecko ? "local" : "sync";
  const dataStore = chrome.storage[AREA];
  const encoder = new TextEncoder();
  let writes = Promise.resolve();
  let usageWrites = Promise.resolve();
  // pickerTrigger opens the search overlay; an empty string turns it off.
  const DEFAULT_SETTINGS = { enabled: true, excludedHosts: [], pickerTrigger: ";;", animationMode: "expand", suggestionsEnabled: true };

  function animationMode(value) {
    return ["expand", "casino", "off"].includes(value) ? value : DEFAULT_SETTINGS.animationMode;
  }

  function suggestionsEnabled(value) {
    return typeof value === "boolean" ? value : DEFAULT_SETTINGS.suggestionsEnabled;
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

  async function deleteShorthand(id) {
    return withWriteLock(async () => {
      await recoverImport();
      await dataStore.remove(PREFIX + id);
    });
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
    replaceAll,
    recoverPendingImport,
    getImportBackup,
    saveSettings,
    getUsageCounts,
    recordUse,
    savePendingDraft,
    takePendingDraft,
    toExportJson,
    DEFAULT_SETTINGS,
    AREA,
  };
})(typeof self !== "undefined" ? self : this);
