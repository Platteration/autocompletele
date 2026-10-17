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
  const animationModeEl = $("animationMode");
  const suggestionsEnabledEl = $("suggestionsEnabled");
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
  let writable = true;
  let skippedImportItems = 0;
  let importing = false;
  let expansionSelection = { start: 0, end: 0 };
  let savedAnimationMode = storage.DEFAULT_SETTINGS.animationMode;
  let savingAnimationMode = false;
  let savedSuggestionsEnabled = storage.DEFAULT_SETTINGS.suggestionsEnabled;
  let savingSuggestionsEnabled = false;

  function renderPreview() {
    const preview = $("templatePreview");
    preview.replaceChildren();
    const text = expansionEl.value;
    const fields = template.fields(text);
    const pronouns = template.variables(text).some((name) => name !== "weekday");
    const blankCount = fields.length
      ? `${fields.length} fill-in blank${fields.length === 1 ? "" : "s"}` : "No fill-in blanks";
    $("templateFieldCount").textContent = pronouns
      ? (fields.length ? `${blankCount} · pronouns` : "Choose pronouns") : blankCount;
    renderRepeatFields(fields);
    preview.classList.toggle("is-empty", !text);
    if (!text) {
      preview.textContent = "Your script will appear here, with each fill-in blank highlighted.";
      return;
    }
    for (const part of template.parts(text)) {
      if (part.type === "text") preview.appendChild(document.createTextNode(part.value));
      else if (part.type === "field") {
        const field = document.createElement("span");
        field.className = "field-chip";
        field.textContent = part.label;
        field.setAttribute("aria-label", `Fill-in blank: ${part.label}`);
        preview.appendChild(field);
      } else {
        const variable = document.createElement("span");
        variable.className = "field-chip variable-chip";
        variable.textContent = part.name === "weekday"
          ? template.render(part.raw, {}, new Date()).text : part.raw;
        variable.title = `${part.label}: ${part.raw}`;
        variable.setAttribute("aria-label", `${part.label}: ${variable.textContent}`);
        preview.appendChild(variable);
      }
    }
  }

  function renderRepeatFields(fields) {
    const buttons = $("repeatFieldButtons");
    buttons.replaceChildren();
    $("repeatFields").hidden = fields.length === 0;
    for (const field of fields) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary small";
      button.textContent = `[[${field.name}]]`;
      button.setAttribute("aria-label", `Reuse blank: ${field.name}`);
      button.title = "Insert again with the same answer";
      button.addEventListener("click", () => {
        insertAtSelection(`[[${field.name}]]`);
        say($("fieldBuilderMsg"), `Reused “${field.name}”. Every occurrence shares one answer.`);
      });
      buttons.appendChild(button);
    }
  }

  function insertAtSelection(text) {
    const start = Math.min(expansionSelection.start, expansionEl.value.length);
    const end = Math.min(expansionSelection.end, expansionEl.value.length);
    expansionEl.setRangeText(text, start, end, "end");
    rememberExpansionSelection();
    expansionEl.focus();
    renderPreview();
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
    $("variableToken").value = "{weekday}";
    say($("fieldBuilderMsg"), "");
    expansionSelection = { start: 0, end: 0 };
    renderPreview();
    for (const row of tbody.querySelectorAll(".is-editing")) row.classList.remove("is-editing");
    applyPendingDraft();
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
      const pronouns = template.variables(sh.expansion).some((name) => name !== "weekday");
      if (fields.length || pronouns) {
        const badge = document.createElement("span");
        badge.className = "template-badge";
        badge.textContent = fields.length
          ? `${fields.length} fill-in blank${fields.length === 1 ? "" : "s"}${pronouns ? " · pronouns" : ""}`
          : "Choose pronouns";
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
      edit.disabled = !writable;
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
      del.disabled = !writable;
      del.addEventListener("click", async () => {
        await storage.deleteShorthand(sh.id);
        await load();
      });

      b.append(edit, " ", del);
      tr.append(t, e, b);
      tbody.appendChild(tr);
    }
  }

  // A selection saved from a webpage arrives as a one-time local draft. Only
  // a pristine create form may receive it, so an edit in progress is safe;
  // the draft stays stored until the form is saved, cancelled or emptied.
  const DRAFT_WAITING = "A selection from a webpage is waiting. Save, cancel or clear this shorthand to use it.";

  async function applyPendingDraft() {
    if (!writable || !storage.takePendingDraft) return;
    if (editId.value || expansionEl.value) {
      say(formMsg, DRAFT_WAITING, false, true);
      return;
    }
    let text = "";
    try { text = await storage.takePendingDraft(); } catch (_) { return; }
    if (!text && formMsg.textContent === DRAFT_WAITING) say(formMsg, "");
    if (!text || editId.value || expansionEl.value) return;
    expansionEl.value = text;
    expansionSelection = { start: text.length, end: text.length };
    renderPreview();
    say(formMsg, "Selection added as a draft. Give it a trigger, then save.");
    triggerEl.focus();
  }

  async function load() {
    const data = await storage.getAll();
    $("exportBtn").disabled = false;
    shorthands = data.shorthands;
    enabledEl.checked = data.settings.enabled !== false;
    // The list saves on change; a reload from another tab must not discard
    // hosts still being typed, the same rule as the picker trigger below.
    if (document.activeElement !== excludedEl) excludedEl.value = (data.settings.excludedHosts || []).join("\n");
    if (!savingAnimationMode) {
      savedAnimationMode = data.settings.animationMode;
      animationModeEl.value = savedAnimationMode;
    }
    if (!savingSuggestionsEnabled) {
      savedSuggestionsEnabled = data.settings.suggestionsEnabled;
      suggestionsEnabledEl.checked = savedSuggestionsEnabled;
    }
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
    const skipped = skippedImportItems;
    let outcome;
    const importControls = [$("importBtn"), $("mergeBtn"), $("replaceBtn"), $("cancelImportBtn")];
    importControls.forEach((button) => { button.disabled = true; });
    try {
      // Merge against the current persisted library inside the writer lock,
      // not a stale preview from another options tab.
      outcome = await storage.replaceAll(pendingImport, { merge: mode === "merge" });
    } catch (e) {
      return say(ioMsg, "Import failed: " + (e && e.message ? e.message : e), true, true);
    } finally {
      importing = false;
      importControls.forEach((button) => { button.disabled = false; });
    }
    clearImportPreview();
    if (outcome.skipped.length) {
      say(ioMsg,
        `Skipped ${outcome.skipped.length} shorthand(s) that exceed Chrome sync limits. Entries that fit were merged; existing snippets were retained. ` +
        outcome.skipped.map((s) => s.trigger + ": " + s.reason).join("; ") +
        (skipped ? ` ${skipped} invalid or duplicate item(s) were also skipped.` : ""), true, true);
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
  expansionEl.addEventListener("input", () => {
    if (!expansionEl.value && formMsg.textContent === DRAFT_WAITING) applyPendingDraft();
  });
  function rememberExpansionSelection() {
    expansionSelection = { start: expansionEl.selectionStart, end: expansionEl.selectionEnd };
  }
  for (const event of ["select", "keyup", "click", "blur", "input"]) {
    expansionEl.addEventListener(event, rememberExpansionSelection);
  }
  $("addFieldBtn").addEventListener("click", () => {
    const name = $("fieldName").value.trim();
    if (!name || /[\[\]\r\n]/.test(name)) {
      return say($("fieldBuilderMsg"), "Give this blank a name without brackets or line breaks.", true);
    }
    insertAtSelection(`[[${name}]]`);
    $("fieldName").value = "";
    say($("fieldBuilderMsg"), "Blank added. Fill it in when you use this script.");
  });
  $("fieldName").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      $("addFieldBtn").click();
    }
  });
  $("addVariableBtn").addEventListener("click", () => {
    const token = $("variableToken").value;
    insertAtSelection(token);
    say($("fieldBuilderMsg"), `${token} inserted at the script’s caret.`);
  });
  enabledEl.addEventListener("change", () => storage.saveSettings({ enabled: enabledEl.checked }));

  suggestionsEnabledEl.addEventListener("change", async () => {
    if (savingSuggestionsEnabled) return;
    const previous = savedSuggestionsEnabled;
    const restoreFocus = document.activeElement === suggestionsEnabledEl;
    savingSuggestionsEnabled = true;
    suggestionsEnabledEl.disabled = true;
    say($("suggestionsMsg"), "Saving suggestions…", false, true);
    try {
      const settings = await storage.saveSettings({ suggestionsEnabled: suggestionsEnabledEl.checked });
      savedSuggestionsEnabled = settings.suggestionsEnabled;
      suggestionsEnabledEl.checked = savedSuggestionsEnabled;
      say($("suggestionsMsg"), `Suggestions saved: ${savedSuggestionsEnabled ? "on" : "off"}.`);
    } catch (error) {
      suggestionsEnabledEl.checked = previous;
      say($("suggestionsMsg"), "Could not save suggestions: "
        + (error && error.message ? error.message : error) + ". Previous preference kept.", true, true);
    } finally {
      savingSuggestionsEnabled = false;
      suggestionsEnabledEl.disabled = !writable;
      if (restoreFocus && document.hasFocus()
          && (document.activeElement === document.body || document.activeElement === suggestionsEnabledEl)) {
        suggestionsEnabledEl.focus({ preventScroll: true });
      }
    }
  });

  animationModeEl.addEventListener("change", async () => {
    if (savingAnimationMode) return;
    const previous = savedAnimationMode;
    const restoreFocus = document.activeElement === animationModeEl;
    savingAnimationMode = true;
    animationModeEl.disabled = true;
    say($("animationMsg"), "Saving animation…", false, true);
    try {
      const settings = await storage.saveSettings({ animationMode: animationModeEl.value });
      savedAnimationMode = settings.animationMode;
      animationModeEl.value = savedAnimationMode;
      say($("animationMsg"), `Animation saved: ${animationModeEl.selectedOptions[0].textContent}.`);
    } catch (error) {
      animationModeEl.value = previous;
      say($("animationMsg"), "Could not save animation: "
        + (error && error.message ? error.message : error) + ". Previous style kept.", true, true);
    } finally {
      savingAnimationMode = false;
      animationModeEl.disabled = false;
      if (restoreFocus && document.hasFocus()
          && (document.activeElement === document.body || document.activeElement === animationModeEl)) {
        animationModeEl.focus({ preventScroll: true });
      }
    }
  });

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

  function downloadLibrary(list, name) {
    const blob = new Blob([storage.toExportJson(list)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $("exportBtn").addEventListener("click", () => downloadLibrary(shorthands, "shorthands.json"));
  $("backupBtn").addEventListener("click", async () => {
    try {
      const backup = await storage.getImportBackup();
      if (!backup) return say(ioMsg, "No pre-import backup is saved yet.");
      downloadLibrary(backup, "shorthands-before-import.json");
    } catch (e) { say(ioMsg, "Backup export failed: " + e.message, true); }
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["shorthand-pending-draft"] && changes["shorthand-pending-draft"].newValue) {
      applyPendingDraft();
      return;
    }
    if (storage.isLibraryChange(changes, area)) load();
  });
  renderPreview();
  storage.recoverPendingImport().then(async (recovery) => {
    await load();
    await applyPendingDraft();
    if (recovery.conflicts.length) say(ioMsg, "Import recovery preserved newer edits to " + recovery.conflicts.length + " snippet(s). Export the pre-import backup to review originals.", true);
  }).catch(async (e) => {
    writable = false;
    let readError = "";
    try { await load(); }
    catch (failure) {
      $("exportBtn").disabled = true;
      readError = " Current library could not be read: " + failure.message + ".";
    }
    say(ioMsg, "Library recovery needs attention: " + e.message + ". Export the pre-import backup before editing." + readError, true);
    form.querySelectorAll("input, textarea, select, button").forEach((el) => { el.disabled = true; });
    [enabledEl, excludedEl, pickerTriggerEl, animationModeEl, suggestionsEnabledEl, $("importBtn"), $("importFile")].forEach((el) => { el.disabled = true; });
    $("mergeBtn").disabled = $("replaceBtn").disabled = true;
  });
})();
