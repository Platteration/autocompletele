// Storage helper shared by the options page, popup, content script and worker.
// Each shorthand is kept under its own key ("sh:<id>") in chrome.storage.sync so
// the list syncs between Chrome profiles without hitting the 8 KB per-item limit.
(function (root) {
  "use strict";

  const PREFIX = "sh:";
  const SETTINGS_KEY = "settings";
  // pickerTrigger opens the search overlay; an empty string turns it off.
  const DEFAULT_SETTINGS = { enabled: true, excludedHosts: [], pickerTrigger: ";;" };

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function getAll() {
    const items = await chrome.storage.sync.get(null);
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
    await chrome.storage.sync.set({
      [PREFIX + id]: { trigger: sh.trigger, expansion: sh.expansion, order },
    });
    return id;
  }

  async function deleteShorthand(id) {
    await chrome.storage.sync.remove(PREFIX + id);
  }

  /** Replace every stored shorthand with the given list (used by import). */
  async function replaceAll(list) {
    const existing = await chrome.storage.sync.get(null);
    const toRemove = Object.keys(existing).filter((k) => k.startsWith(PREFIX));
    if (toRemove.length) await chrome.storage.sync.remove(toRemove);
    const payload = {};
    list.forEach((sh, i) => {
      payload[PREFIX + newId()] = { trigger: sh.trigger, expansion: sh.expansion, order: i };
    });
    if (Object.keys(payload).length) await chrome.storage.sync.set(payload);
  }

  async function saveSettings(patch) {
    const { settings } = await getAll();
    const next = Object.assign({}, settings, patch);
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
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
  };
})(typeof self !== "undefined" ? self : this);
