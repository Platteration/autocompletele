(function () {
  "use strict";
  const storage = self.ShorthandStorage;
  const { sanitizeList } = self.ShorthandExpander;
  const importPlan = self.ShorthandImportPlan;
  const template = self.ShorthandTemplate;

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
  const shorthandCountEl = $("shorthandCount");
  const importPreviewEl = $("importPreview");
  const importSummaryEl = $("importSummary");
  const updatePreviewEl = $("updatePreview");
  const updateListEl = $("updateList");

  let shorthands = [];
  let pendingImport = null;
  let skippedImportItems = 0;
  let importing = false;
  let expansionSelection = { start: 0, end: 0 };

  function renderPreview() {
    const preview = $("templatePreview");
    preview.replaceChildren();
    const text = expansionEl.value;
    const fields = template.fields(text);
    $("templateFieldCount").textContent = fields.length
      ? `${fields.length} fill-in blank${fields.length === 1 ? "" : "s"}` : "No fill-in blanks";
    preview.classList.toggle("is-empty", !text);
    if (!text) {
      preview.textContent = "Your script will appear here, with each fill-in blank highlighted.";
      return;
    }
    for (const part of template.parts(text)) {
      if (part.type === "text") preview.appendChild(document.createTextNode(part.value));
      else {
        const field = document.createElement("span");
        field.className = "field-chip";
        field.textContent = part.label;
        field.setAttribute("aria-label", `Fill-in blank: ${part.label}`);
        preview.appendChild(field);
      }
    }
  }

  function matchesSearch(sh, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return sh.trigger.toLowerCase().includes(q) || sh.expansion.toLowerCase().includes(q);
  }

  function say(el, text, isError, persistent = false) {
    el.textContent = text;
    el.classList.toggle("error", !!isError);
    if (text && !persistent) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
  }

  function resetForm() {
    editId.value = "";
    triggerEl.value = "";
    expansionEl.value = "";
    saveBtn.textContent = "Add shorthand";
    cancelBtn.hidden = true;
    $("editorTitle").textContent = "Create a shorthand";
    $("fieldName").value = "";
    say($("fieldBuilderMsg"), "");
    expansionSelection = { start: 0, end: 0 };
    renderPreview();
    for (const row of tbody.querySelectorAll(".is-editing")) row.classList.remove("is-editing");
  }

  function clearImportPreview() {
    pendingImport = null;
    skippedImportItems = 0;
    importPreviewEl.hidden = true;
    updateListEl.textContent = "";
    updatePreviewEl.hidden = true;
  }

  function renderList() {
    tbody.textContent = "";
    const query = searchEl.value.trim();
    const visible = shorthands.filter((sh) => matchesSearch(sh, query));
    const warnings = self.ShorthandConflicts.byTrigger(shorthands);

    shorthandCountEl.textContent = String(shorthands.length);
    emptyEl.hidden = shorthands.length > 0;
    noMatchesEl.hidden = shorthands.length === 0 || visible.length > 0;

    for (const sh of visible) {
      const tr = document.createElement("tr");
      tr.classList.toggle("is-editing", sh.id === editId.value);
      const t = document.createElement("td");
      t.className = "trigger";
      t.textContent = sh.trigger;
      const e = document.createElement("td");
      e.className = "expansion";
      const expansionText = document.createElement("span");
      expansionText.className = "expansion-text";
      expansionText.textContent = sh.expansion;
      e.appendChild(expansionText);
      const fields = template.fields(sh.expansion);
      if (fields.length) {
        const badge = document.createElement("span");
        badge.className = "template-badge";
        badge.textContent = `${fields.length} fill-in blank${fields.length === 1 ? "" : "s"}`;
        e.appendChild(badge);
      }

      const found = warnings.get(sh.trigger);
      if (found) {
        tr.classList.add("has-warning");
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
        $("editorTitle").textContent = "Edit shorthand";
        expansionSelection = { start: sh.expansion.length, end: sh.expansion.length };
        renderPreview();
        renderList();
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

  function showImportPreview(list, skipped) {
    pendingImport = list;
    skippedImportItems = skipped;
    const plan = importPlan.planImport(shorthands, list);
    $("addCount").textContent = String(plan.additions.length);
    $("updateCount").textContent = String(plan.updates.length);
    $("sameCount").textContent = String(plan.unchanged.length);
    importSummaryEl.textContent = `${plan.incomingCount} shorthand(s) found. ${plan.changedCount} would change your library.`;
    if (skipped) importSummaryEl.textContent += ` ${skipped} invalid or duplicate item(s) skipped.`;
    updateListEl.textContent = "";

    for (const update of plan.updates.slice(0, 8)) {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = update.trigger;
      const text = document.createElement("span");
      text.textContent = ` will be updated`;
      li.append(code, text);
      updateListEl.appendChild(li);
    }
    if (plan.updates.length > 8) {
      const li = document.createElement("li");
      li.textContent = `…and ${plan.updates.length - 8} more`;
      updateListEl.appendChild(li);
    }

    updatePreviewEl.hidden = plan.updates.length === 0;
    importPreviewEl.hidden = false;
    importPreviewEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function applyImport(mode) {
    if (!pendingImport || importing) return;
    importing = true;
    const importedCount = pendingImport.length;
    const incomingTriggers = new Set(pendingImport.map((item) => item.trigger));
    const skipped = skippedImportItems;
    const list = mode === "merge"
      ? importPlan.mergeImport(shorthands, pendingImport)
      : pendingImport;
    let result;
    const importControls = [$("importBtn"), $("mergeBtn"), $("replaceBtn"), $("cancelImportBtn")];
    importControls.forEach((button) => { button.disabled = true; });
    try {
      result = await storage.replaceAll(list);
    } catch (e) {
      return say(ioMsg, "Import failed: " + (e && e.message ? e.message : e), true, true);
    } finally {
      importing = false;
      importControls.forEach((button) => { button.disabled = false; });
    }
    const failedIncoming = result.failures.filter((failure) => incomingTriggers.has(failure.trigger));
    clearImportPreview();
    if (result.failures.length || result.cleanupError) {
      const failures = result.failures.map((failure) => `${failure.trigger}: ${failure.message}`).join("; ");
      say(ioMsg,
        `Imported ${importedCount - failedIncoming.length} shorthand(s); skipped ${failedIncoming.length + skipped} item(s). ` +
        "Import incomplete; previous entries that were not updated have been kept. " +
        (failures || result.cleanupError), true, true);
    } else if (skipped) {
      say(ioMsg, `Imported ${importedCount} shorthand(s); skipped ${skipped} invalid or duplicate item(s).`, true, true);
    } else {
      say(ioMsg, mode === "merge"
        ? `Merged ${importedCount} shorthand(s) into your library.`
        : `Replaced your library with ${importedCount} shorthand(s).`);
    }
    await load();
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
  expansionEl.addEventListener("input", renderPreview);
  const rememberSelection = () => {
    expansionSelection = { start: expansionEl.selectionStart, end: expansionEl.selectionEnd };
  };
  for (const event of ["select", "keyup", "click", "blur", "input"]) {
    expansionEl.addEventListener(event, rememberSelection);
  }
  $("addFieldBtn").addEventListener("click", () => {
    const name = $("fieldName").value.trim();
    if (!name || /[\[\]\r\n]/.test(name)) {
      return say($("fieldBuilderMsg"), "Give this blank a name without brackets or line breaks.", true);
    }
    const token = `[[${name}]]`;
    const start = Math.min(expansionSelection.start, expansionEl.value.length);
    const end = Math.min(expansionSelection.end, expansionEl.value.length);
    expansionEl.setRangeText(token, start, end, "end");
    expansionEl.focus();
    rememberSelection();
    renderPreview();
    $("fieldName").value = "";
    say($("fieldBuilderMsg"), "Blank added. Fill it in when you use this script.");
  });
  $("fieldName").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      $("addFieldBtn").click();
    }
  });
  enabledEl.addEventListener("change", () => storage.saveSettings({ enabled: enabledEl.checked }));

  pickerTriggerEl.addEventListener("change", () => {
    const value = pickerTriggerEl.value.trim();
    if (/\s/.test(value)) {
      pickerTriggerEl.value = storage.DEFAULT_SETTINGS.pickerTrigger;
      return say($("pickerMsg"), "The search trigger cannot contain spaces.", true);
    }
    say($("pickerMsg"), "");
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
  $("cancelImportBtn").addEventListener("click", clearImportPreview);
  $("mergeBtn").addEventListener("click", () => applyImport("merge"));
  $("replaceBtn").addEventListener("click", () => applyImport("replace"));

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
    const rawList = Array.isArray(parsed) ? parsed : parsed && parsed.shorthands;
    const list = sanitizeList(rawList);
    if (list.length === 0) return say(ioMsg, "No shorthands found in that file.", true);
    showImportPreview(list, rawList.length - list.length);
  });

  chrome.storage.onChanged.addListener((_c, area) => { if (area === storage.AREA) load(); });
  renderPreview();
  load();
})();
