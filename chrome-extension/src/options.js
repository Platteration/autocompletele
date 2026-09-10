(function () {
  "use strict";
  const storage = self.ShorthandStorage;
  const { sanitizeList } = self.ShorthandExpander;

  const $ = (id) => document.getElementById(id);
  const enabledEl = $("enabled");
  const excludedEl = $("excluded");
  const pickerTriggerEl = $("pickerTrigger");
  const form = $("editor");
  const editId = $("editId");
  const triggerEl = $("trigger");
  const expansionEl = $("expansion");
  const saveBtn = $("saveBtn");
  const cancelBtn = $("cancelBtn");
  const formMsg = $("formMsg");
  const tbody = document.querySelector("#list tbody");
  const emptyEl = $("empty");
  const noMatchesEl = $("noMatches");
  const searchEl = $("search");
  const ioMsg = $("ioMsg");

  let shorthands = [];

  function matchesSearch(sh, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return sh.trigger.toLowerCase().includes(q) || sh.expansion.toLowerCase().includes(q);
  }

  function say(el, text, isError) {
    el.textContent = text;
    el.classList.toggle("error", !!isError);
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
  }

  function resetForm() {
    editId.value = "";
    triggerEl.value = "";
    expansionEl.value = "";
    saveBtn.textContent = "Add shorthand";
    cancelBtn.hidden = true;
  }

  function renderList() {
    tbody.textContent = "";
    const query = searchEl.value.trim();
    const visible = shorthands.filter((sh) => matchesSearch(sh, query));
    // Warnings are computed over the whole list: a trigger is shadowed by
    // another whether or not the search happens to be showing it.
    const warnings = self.ShorthandConflicts.byTrigger(shorthands);

    emptyEl.hidden = shorthands.length > 0;
    noMatchesEl.hidden = shorthands.length === 0 || visible.length > 0;

    for (const sh of visible) {
      const tr = document.createElement("tr");
      const t = document.createElement("td");
      t.className = "trigger";
      t.textContent = sh.trigger;
      const e = document.createElement("td");
      e.className = "expansion";
      e.textContent = sh.expansion;

      const found = warnings.get(sh.trigger);
      if (found) {
        tr.className = "has-warning";
        for (const w of found) {
          const note = document.createElement("small");
          note.className = "warning";
          note.textContent = w.message;
          e.appendChild(note);
        }
      }
      const b = document.createElement("td");
      b.className = "buttons";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary small";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        editId.value = sh.id;
        triggerEl.value = sh.trigger;
        expansionEl.value = sh.expansion;
        saveBtn.textContent = "Save changes";
        cancelBtn.hidden = false;
        triggerEl.focus();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger small";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        await storage.deleteShorthand(sh.id);
        await load();
      });
      b.append(edit, " ", del);
      tr.append(t, e, b);
      tbody.appendChild(tr);
    }
  }

  async function load() {
    const data = await storage.getAll();
    shorthands = data.shorthands;
    enabledEl.checked = data.settings.enabled !== false;
    excludedEl.value = (data.settings.excludedHosts || []).join("\n");
    if (document.activeElement !== pickerTriggerEl) {
      pickerTriggerEl.value = typeof data.settings.pickerTrigger === "string"
        ? data.settings.pickerTrigger
        : storage.DEFAULT_SETTINGS.pickerTrigger;
    }
    renderList();
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const trigger = triggerEl.value.trim();
    const expansion = expansionEl.value;
    if (!trigger) return say(formMsg, "Trigger cannot be empty.", true);
    if (/\s/.test(trigger)) return say(formMsg, "Trigger cannot contain spaces.", true);
    const clash = shorthands.find((s) => s.trigger === trigger && s.id !== editId.value);
    if (clash) return say(formMsg, "That trigger is already used.", true);
    const existing = shorthands.find((s) => s.id === editId.value);
    try {
      await storage.saveShorthand({
        id: editId.value || undefined,
        trigger,
        expansion,
        order: existing ? existing.order : undefined,
      });
    } catch (e) {
      return say(formMsg, "Could not save: " + (e && e.message ? e.message : e), true);
    }
    say(formMsg, existing ? "Saved." : "Added.");
    resetForm();
    await load();
  });

  cancelBtn.addEventListener("click", resetForm);

  searchEl.addEventListener("input", renderList);

  enabledEl.addEventListener("change", () => storage.saveSettings({ enabled: enabledEl.checked }));

  pickerTriggerEl.addEventListener("change", () => {
    const value = pickerTriggerEl.value.trim();
    if (/\s/.test(value)) {
      pickerTriggerEl.value = storage.DEFAULT_SETTINGS.pickerTrigger;
      return say(formMsg, "The search trigger cannot contain spaces.", true);
    }
    storage.saveSettings({ pickerTrigger: value });
  });

  excludedEl.addEventListener("change", () => {
    const hosts = excludedEl.value
      .split(/\r?\n/)
      .map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
    storage.saveSettings({ excludedHosts: Array.from(new Set(hosts)) });
  });

  $("exportBtn").addEventListener("click", () => {
    const blob = new Blob([storage.toExportJson(shorthands)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shorthands.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("importBtn").addEventListener("click", () => $("importFile").click());

  $("importFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (_) {
      return say(ioMsg, "That file is not valid JSON.", true);
    }
    const list = sanitizeList(Array.isArray(parsed) ? parsed : parsed && parsed.shorthands);
    if (list.length === 0) return say(ioMsg, "No shorthands found in that file.", true);
    if (shorthands.length && !confirm(`Replace your ${shorthands.length} shorthand(s) with the ${list.length} from the file?`)) return;
    try {
      await storage.replaceAll(list);
    } catch (e) {
      return say(ioMsg, "Import failed: " + (e && e.message ? e.message : e), true);
    }
    say(ioMsg, `Imported ${list.length} shorthand(s).`);
    await load();
  });

  chrome.storage.onChanged.addListener((_c, area) => { if (area === "sync") load(); });

  load();
})();
