// Storage helper shared by the options page, popup, content script and worker.
// Each shorthand is kept under its own key ("sh:<id>"). Chrome uses sync storage;
// Firefox uses local storage. Separate keys avoid Chrome's 8 KB per-item limit.
(function (root) {
  "use strict";

  const PREFIX = "sh:";
  const SETTINGS_KEY = "settings";
  const AREA = chrome.runtime.getManifest().browser_specific_settings?.gecko ? "local" : "sync";
  const dataStore = chrome.storage[AREA];
  // pickerTrigger opens the search overlay; an empty string turns it off.
  const DEFAULT_SETTINGS = { enabled: true, excludedHosts: [], pickerTrigger: ";;" };

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
    return { shorthands, settings };
  }

  async function saveShorthand(sh) {
    const id = sh.id || newId();
    const order = typeof sh.order === "number" ? sh.order : Date.now();
    await dataStore.set({
      [PREFIX + id]: { trigger: sh.trigger, expansion: sh.expansion, order },
    });
    return id;
  }

  async function deleteShorthand(id) {
    await dataStore.remove(PREFIX + id);
  }

  /** Replace the library; partial imports retain old entries and report failures. */
  async function replaceAll(list) {
    const existing = await dataStore.get(null);
    const keysByTrigger = new Map(Object.entries(existing)
      .filter(([key, value]) => key.startsWith(PREFIX) && value && typeof value === "object")
      .map(([key, value]) => [value.trigger, key]));
    const payload = {};
    list.forEach((sh, i) => {
      // Updates must not need a second storage slot or a second copy of the text.
      const key = keysByTrigger.get(sh.trigger) || PREFIX + newId();
      payload[key] = { trigger: sh.trigger, expansion: sh.expansion, order: i };
    });
    const entries = Object.entries(payload);
    const result = { savedCount: 0, failures: [], cleanupError: null };
    if (entries.length) {
      try {
        await dataStore.set(payload);
        result.savedCount = entries.length;
      } catch (_) {
        // A too-large item must not block the usable remainder of a backup.
        // Keep previous values for rejected updates and report every skipped item.
        for (const [key, value] of entries) {
          try {
            await dataStore.set({ [key]: value });
            result.savedCount++;
          } catch (error) {
            result.failures.push({ trigger: value.trigger, message: String(error.message || error) });
          }
        }
      }
    }
    // Never delete the previous library to make room for an import. New entries
    // need enough free space alongside retained entries until writes succeed.
    if (result.failures.length === 0) {
      const toRemove = Object.keys(existing)
        .filter((key) => key.startsWith(PREFIX) && !Object.hasOwn(payload, key));
      if (toRemove.length) {
        try {
          await dataStore.remove(toRemove);
        } catch (error) {
          result.cleanupError = String(error.message || error);
        }
      }
    }
    return result;
  }

  async function saveSettings(patch) {
    const { settings } = await getAll();
    const next = Object.assign({}, settings, patch);
    await dataStore.set({ [SETTINGS_KEY]: next });
    return next;
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
    saveSettings,
    toExportJson,
    DEFAULT_SETTINGS,
    AREA,
  };
})(typeof self !== "undefined" ? self : this);
