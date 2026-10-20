// The Writing pad: drafts that save on this device as you type (pad-store.js).
// The engine scripts loaded before this one make shortcuts, suggestions, the
// ;; search and fill-in templates work in the editor, as in the playground.
//
// Never losing text comes first: a failed save keeps the text and says so, a
// draft is not switched away from or deleted while its text is unsaved, and a
// save over a version another tab wrote is kept as a new draft instead.
//
// Suggestions hook, for the suggestion engines (load their scripts after this
// one):
//
//   self.ActlePad.panel
//     The element to render suggestion cards into. pad.js empties and hides
//     it while suggestions are off, and shows it (without emptying it) when
//     they are turned on.
//   self.ActlePad.onSuggest(fn)
//     Registers fn(currentDraft, allDraftTexts); a later call replaces it and
//     onSuggest(null) removes it. fn is called only while suggestions are on:
//     1.5 s after the last edit (so at most once per 1.5 s of idle typing),
//     right after it is registered, when suggestions are turned on, and when
//     another draft is opened. currentDraft is { id, title, body }, with the
//     editor's current text; id is null for a new draft not saved yet.
//     allDraftTexts is a string[] of the bodies of every draft in the pad,
//     with the editor's text in place of the open draft's saved copy. Its
//     return value is ignored; an error it throws or rejects with is logged
//     as a warning and does not affect the pad.
//   self.ActlePad.requestSuggestions()
//     Calls fn again now (when suggestions are on), e.g. after a card's action.
//   self.ActlePad.suggestionsOn()
//     Whether suggestions are on.
//   self.ActlePad.store
//     self.ActlePadStore, for getDismissed() and dismissPhrase(text).
(function () {
  "use strict";

  const store = self.ActlePadStore;
  const $ = (id) => document.getElementById(id);
  const titleEl = $("padTitle");
  const bodyEl = $("padBody");
  const introEl = $("padIntro");
  const saveEl = $("padSave");
  const msgEl = $("padMsg");
  const undoBtn = $("padUndo");
  const wordsEl = $("padWords");
  const lockNotice = $("padLockNotice");
  const lockText = $("padLockText");
  const takeOverBtn = $("padTakeOver");
  const newBtn = $("newDraftBtn");
  const selectEl = $("draftSelect");
  const listEl = $("draftList");
  const countEl = $("draftCount");
  const emptyEl = $("draftsEmpty");
  const copyBtn = $("copyBtn");
  const downloadBtn = $("downloadBtn");
  const deleteBtn = $("deleteBtn");
  const trashEl = $("padTrash");
  const trashSummary = $("padTrashSummary");
  const trashCountEl = $("padTrashCount");
  const trashEmptyEl = $("padTrashEmpty");
  const trashListEl = $("padTrashList");
  const emptyTrashBtn = $("padEmptyTrashBtn");
  const toggleEl = $("suggestToggle");
  const toggleHint = $("suggestToggleHint");
  const panelEl = $("padSuggestions");

  const SAVE_DELAY = 400;
  const CHECK_INTERVAL = 2000;
  const SUGGEST_DELAY = 1500;
  const DRAFT_LOCK = "actle-pad-draft:";
  const COPY_SUFFIX = " (copy from another tab)";
  const LOCKED_TEXT = "This draft is open in another tab. Editing here is paused.";
  const NOT_SAVED_TAIL = " Your text is still here — copy it or download it.";

  let drafts = []; // saved drafts, newest edit first, with their text
  let trash = [];
  let prefs = { ...store.DEFAULT_PREFS };
  // The open draft as last saved or loaded; null while a new draft has no text yet.
  let current = null;
  // The editor text that matches storage. Anything else in the editor is unsaved.
  let base = { title: "", body: "" };
  let ready = false;
  let readOnly = false;
  let lock = null; // { id, release } for the draft lock this tab holds
  let saveTimer = 0;
  let saving = null;
  let saveAgain = false;
  let saveError = "";
  let failedText = null; // the editor text when the last save failed
  let undoId = null;
  let provider = null;
  let suggestTimer = 0;
  let refreshTimer = 0;
  let lastSeenBody = "";
  let navigation = Promise.resolve();
  const trashButtons = new Map();
  const busy = new Set();

  // ---- small helpers --------------------------------------------------------

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function editorText() {
    return { title: titleEl.value, body: bodyEl.value };
  }

  function sameText(a, b) {
    return a.title === b.title && a.body === b.body;
  }

  function hasText(text) {
    return text.title.trim() !== "" || text.body.trim() !== "";
  }

  // Text in the editor that is not in storage yet.
  function hasUnsaved() {
    const text = editorText();
    return !sameText(text, base) && (current !== null || hasText(text));
  }

  // Reads only the start of the text: drafts can be long and this runs per keystroke.
  function firstLine(body) {
    const text = String(body || "").trimStart();
    const end = text.indexOf("\n");
    const line = (end < 0 ? text.slice(0, 200) : text.slice(0, Math.min(end, 200))).trim();
    return line.length > 60 ? line.slice(0, 59).trimEnd() + "…" : line;
  }

  function displayTitle(text) {
    return String(text.title || "").trim() || firstLine(text.body) || "Untitled draft";
  }

  function clockTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function editedLabel(ms) {
    if (ms === null || ms === undefined) return "Edit time unknown";
    const date = new Date(ms);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) return "Edited " + clockTime(ms);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Edited yesterday";
    const sameYear = date.getFullYear() === now.getFullYear();
    return "Edited " + date.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  }

  function wordsLabel(count) {
    return count === 1 ? "1 word" : count.toLocaleString() + " words";
  }

  // ---- status line ----------------------------------------------------------

  function renderSaveState() {
    let text = "";
    let error = false;
    if (saveError) {
      text = "Not saved: " + saveError + "." + NOT_SAVED_TAIL;
      error = true;
    } else if (saving || saveTimer || (ready && !readOnly && hasUnsaved())) {
      text = "Saving…";
    } else if (current && current.updatedAt !== null) {
      text = "Saved " + clockTime(current.updatedAt);
    } else if (current) {
      text = "Saved";
    }
    if (saveEl.textContent !== text) saveEl.textContent = text;
    saveEl.classList.toggle("error", error);
  }

  // The outcome of the latest action. It stays until the next one, so Undo
  // has no deadline.
  function tell(text, isError = false, undo = null) {
    undoId = undo;
    undoBtn.hidden = !undo;
    msgEl.textContent = text;
    msgEl.classList.toggle("error", !!isError);
  }

  let currentWords = 0;

  function renderWords() {
    lastSeenBody = bodyEl.value;
    currentWords = store.countWords(bodyEl.value);
    wordsEl.textContent = wordsLabel(currentWords);
  }

  // While typing, the word count and the list catch up once the typing pauses.
  let typingTimer = 0;
  function renderSoon() {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      typingTimer = 0;
      renderWords();
      renderList();
    }, 150);
  }

  // ---- drafts list ----------------------------------------------------------

  // The open draft as the list shows it: the editor's text, not the saved copy.
  function summaries() {
    return drafts.map((draft) => current && draft.id === current.id
      ? { ...draft, title: titleEl.value, body: bodyEl.value } : draft);
  }

  function renderList() {
    const focusedId = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.draftId : undefined;
    const list = summaries();
    listEl.replaceChildren();
    selectEl.replaceChildren();
    if (!current) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = hasText(editorText()) ? displayTitle(editorText()) : "New draft";
      selectEl.appendChild(option);
    }
    for (const draft of list) {
      const isCurrent = !!current && draft.id === current.id;
      const words = isCurrent ? currentWords : draft.words;
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "draft-item";
      button.dataset.draftId = draft.id;
      if (isCurrent) button.setAttribute("aria-current", "true");
      const title = document.createElement("span");
      title.className = "draft-title";
      title.textContent = displayTitle(draft);
      const meta = document.createElement("span");
      meta.className = "draft-meta";
      meta.textContent = editedLabel(draft.updatedAt) + " · " + wordsLabel(words);
      button.append(title, meta);
      button.addEventListener("click", () => openDraft(draft.id));
      li.appendChild(button);
      listEl.appendChild(li);

      const option = document.createElement("option");
      option.value = draft.id;
      option.textContent = displayTitle(draft) + " — " + editedLabel(draft.updatedAt);
      selectEl.appendChild(option);
    }
    selectEl.value = current ? current.id : "";
    countEl.textContent = String(list.length);
    emptyEl.hidden = list.length > 0;
    if (focusedId) {
      const again = listEl.querySelector(`[data-draft-id="${CSS.escape(focusedId)}"]`);
      if (again) again.focus();
    }
  }

  // Puts a saved draft into the in-memory list, newest edit first.
  function upsertDraft(draft) {
    const entry = { ...draft, words: store.countWords(draft.body) };
    drafts = [entry, ...drafts.filter((item) => item.id !== draft.id)];
    drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function refreshDrafts() {
    try {
      drafts = await store.listDrafts();
    } catch (_) {
      return; // the list keeps what it had; saving is unaffected
    }
    renderList();
  }

  function refreshDraftsSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshDrafts, 150);
  }

  // ---- editor state ---------------------------------------------------------

  function setEditorText(text) {
    const keep = document.activeElement === bodyEl ? [bodyEl.selectionStart, bodyEl.selectionEnd] : null;
    if (titleEl.value !== text.title) titleEl.value = text.title;
    if (bodyEl.value !== text.body) {
      bodyEl.value = text.body;
      if (keep) bodyEl.setSelectionRange(Math.min(keep[0], text.body.length), Math.min(keep[1], text.body.length));
    }
    renderWords();
  }

  function setReadOnly(flag) {
    readOnly = flag;
    titleEl.readOnly = flag;
    bodyEl.readOnly = flag;
    lockNotice.hidden = !flag;
    lockText.textContent = flag ? LOCKED_TEXT : "";
    takeOverBtn.disabled = false;
    renderButtons();
    renderSaveState();
  }

  function renderButtons() {
    deleteBtn.disabled = !current || readOnly;
  }

  function adopt(draft, savedText) {
    current = { id: draft.id, rev: draft.rev, updatedAt: draft.updatedAt };
    base = { title: savedText.title, body: savedText.body };
  }

  function rememberLast(id) {
    if (prefs.lastDraftId === id) return;
    prefs.lastDraftId = id;
    store.savePrefs({ lastDraftId: id }).catch(() => {});
  }

  // ---- one editor per draft -------------------------------------------------

  // Resolves true when this tab may edit the draft: it holds the draft's lock,
  // or the browser has no lock manager (the rev check still protects).
  function claimLock(id, steal = false) {
    const locks = navigator.locks;
    if (!locks || typeof locks.request !== "function") return Promise.resolve(true);
    return new Promise((resolve) => {
      let release;
      const held = new Promise((done) => { release = done; });
      const handle = { id, release: () => release() };
      let granted = false;
      let request;
      try {
        request = locks.request(DRAFT_LOCK + id, steal ? { steal: true } : { ifAvailable: true }, (got) => {
          if (!got) {
            resolve(false);
            return undefined;
          }
          granted = true;
          lock = handle;
          resolve(true);
          return held;
        });
      } catch (_) {
        resolve(true);
        return;
      }
      request.catch(() => {
        // Before it was granted, the lock manager refused: edit normally.
        if (!granted) return resolve(true);
        // After, another tab took the draft with "Edit here instead".
        if (lock === handle) {
          lock = null;
          lockTaken(id);
        }
      });
    });
  }

  function releaseLock() {
    if (!lock) return;
    const held = lock;
    lock = null;
    held.release();
  }

  // Another tab took this draft: save what this tab has first, then pause.
  async function lockTaken(id) {
    if (!current || current.id !== id) return;
    titleEl.readOnly = true;
    bodyEl.readOnly = true;
    await saveNow();
    // A conflict may have moved this tab's text to a new draft it now edits.
    if (current && current.id === id) setReadOnly(true);
    else setReadOnly(false);
  }

  async function takeOver() {
    if (!current) return;
    const id = current.id;
    takeOverBtn.disabled = true;
    await claimLock(id, true);
    if (!current || current.id !== id) return;
    // The other tab saves before it pauses; that save arrives through
    // storage.onChanged as well. Unsaved text here stays and is kept on save.
    if (!hasUnsaved()) {
      try {
        const latest = await store.getDraft(id);
        if (latest && current && current.id === id && latest.rev > current.rev && !hasUnsaved()) showSaved(latest);
      } catch (_) { /* keep what is shown */ }
    }
    setReadOnly(false);
    bodyEl.focus();
  }

  // ---- saving -----------------------------------------------------------------

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      saveNow();
    }, SAVE_DELAY);
    renderSaveState();
  }

  // Saves until the editor matches storage or a save fails. Resolves true
  // when nothing is left unsaved.
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (saving) {
      saveAgain = true;
      return saving;
    }
    if (!ready) return Promise.resolve(!hasUnsaved());
    saving = (async () => {
      try {
        do {
          saveAgain = false;
          await saveOnce();
        } while ((saveAgain || hasUnsaved()) && !saveError);
      } finally {
        saving = null;
        renderSaveState();
        renderList();
      }
      return !hasUnsaved();
    })();
    renderSaveState();
    return saving;
  }

  function failed(error, text) {
    saveError = errorText(error).replace(/[.\s]+$/, "");
    failedText = text;
  }

  function cleared() {
    saveError = "";
    failedText = null;
  }

  async function saveOnce() {
    if (!hasUnsaved()) return;
    const text = editorText();
    if (!current) {
      try {
        const draft = await store.createDraft(text);
        adopt(draft, text);
        upsertDraft(draft);
        cleared();
        await claimLock(draft.id);
        rememberLast(draft.id);
        renderButtons();
      } catch (error) {
        failed(error, text);
      }
      return;
    }
    try {
      const result = await store.saveDraft(current.id, text, current.rev);
      if (result.ok) {
        adopt(result.draft, text);
        upsertDraft(result.draft);
        cleared();
      } else {
        await keepBoth(result.current, text);
      }
    } catch (error) {
      failed(error, text);
    }
  }

  // Another tab saved this draft (or deleted it) since this tab loaded it.
  // Both versions stay: this tab's text becomes a new draft and opens here.
  async function keepBoth(stored, text) {
    const title = !stored || text.title.endsWith(COPY_SUFFIX) ? text.title
      : (text.title.trim() || displayTitle(text)) + COPY_SUFFIX;
    const draft = await store.createDraft({ title, body: text.body });
    releaseLock();
    adopt(draft, { title, body: text.body });
    // A title the person changed meanwhile stays; it saves next.
    if (titleEl.value === text.title) titleEl.value = title;
    upsertDraft(draft);
    cleared();
    await claimLock(draft.id);
    rememberLast(draft.id);
    refreshDraftsSoon();
    renderButtons();
    tell(stored
      ? `Another tab changed this draft, so your text was saved as a new draft: “${displayTitle(draft)}”. The other version is also kept.`
      : `This draft was deleted in another tab, so your text was saved as a new draft: “${displayTitle(draft)}”.`);
  }

  // Before switching away from the editor's text: save it, and say no when
  // it could not be saved.
  async function settle() {
    if (!hasUnsaved() && !saving) return true;
    await saveNow();
    if (!hasUnsaved()) return true;
    tell("This draft stays open because its text is not saved yet. Copy it or download it, then try again.", true);
    return false;
  }

  // ---- opening drafts ---------------------------------------------------------

  function showSaved(draft) {
    current = { id: draft.id, rev: draft.rev, updatedAt: draft.updatedAt };
    base = { title: draft.title, body: draft.body };
    setEditorText(base);
  }

  function showBlank() {
    current = null;
    base = { title: "", body: "" };
    setEditorText(base);
  }

  // Opening, creating and deleting run one at a time.
  function navigate(task) {
    const run = navigation.then(task, task);
    navigation = run.catch(() => {});
    return run;
  }

  async function show(draft) {
    releaseLock();
    // The intro shows on an empty pad and stays until the next draft is opened,
    // so the editor does not move while the first words are saved.
    introEl.hidden = !(draft === null && drafts.length === 0);
    if (!draft) {
      showBlank();
      setReadOnly(false);
    } else {
      showSaved(draft);
      // No typing until this tab knows whether it may edit the draft.
      titleEl.readOnly = true;
      bodyEl.readOnly = true;
      setReadOnly(!(await claimLock(draft.id)));
      rememberLast(draft.id);
    }
    renderList();
    renderButtons();
    renderSaveState();
    scheduleSuggest(0);
  }

  function openDraft(id) {
    return navigate(async () => {
      if (current && current.id === id) return true;
      if (!(await settle())) {
        renderList();
        return false;
      }
      let draft;
      try {
        draft = await store.getDraft(id);
      } catch (error) {
        tell("Could not open that draft: " + errorText(error), true);
        renderList();
        return false;
      }
      if (!draft) {
        tell("That draft is no longer here.", true);
        await refreshDrafts();
        return false;
      }
      tell("");
      await show(draft);
      return true;
    });
  }

  function newDraft() {
    return navigate(async () => {
      if (!(await settle())) return;
      tell("New draft. It is saved as soon as you type.");
      await show(null);
      bodyEl.focus();
    });
  }

  // ---- delete, undo and Recently deleted drafts -------------------------------

  function deleteCurrent() {
    return navigate(async () => {
      if (!current || readOnly) return;
      const id = current.id;
      const name = displayTitle(editorText());
      if (!window.confirm(`Delete “${name}”? It goes to Recently deleted drafts.`)) return;
      if (!(await settle())) return;
      if (!current || current.id !== id) {
        tell("Nothing was deleted: the draft's text moved to a new draft. Check it before deleting.", true);
        return;
      }
      let result;
      try {
        result = await store.deleteDraft(id);
      } catch (error) {
        tell(`Could not delete “${name}”. ${errorText(error)}`, true);
        return;
      }
      drafts = drafts.filter((draft) => draft.id !== id);
      current = null;
      await show(drafts[0] || null);
      if (!result.deleted) {
        tell(`“${name}” was already deleted.`);
        return;
      }
      tell(`Deleted “${name}”.`, false, result.entry.id);
      await loadTrash();
      undoBtn.focus();
    });
  }

  function restore(id, fromUndo) {
    if (busy.has(id)) return Promise.resolve();
    busy.add(id);
    return navigate(async () => {
      let result;
      try {
        result = await store.restoreDraft(id);
      } catch (error) {
        result = { restored: false, message: "Could not restore it: " + errorText(error) };
      }
      await loadTrash();
      if (!result.restored) {
        tell(result.message, true);
        trashEl.open = true;
        return;
      }
      if (!result.alreadyThere) upsertDraft(result.draft);
      const name = displayTitle(result.draft);
      // Open it, unless the editor's own text cannot be saved first.
      if (await settle()) {
        await show(result.draft);
        tell(result.alreadyThere ? `“${name}” is already back.` : `Restored “${name}”.`);
        if (fromUndo) bodyEl.focus();
      } else {
        renderList();
        tell(`Restored “${name}”. It is in your drafts; this one stays open because its text is not saved yet.`, true);
      }
    }).finally(() => busy.delete(id));
  }

  async function forget(entry) {
    const name = displayTitle(entry);
    try {
      await store.forgetDraft(entry.id);
    } catch (error) {
      tell(`Could not delete “${name}” for good: ${errorText(error)}`, true);
      return;
    }
    await loadTrash();
    tell(`Deleted “${name}” for good.`);
    if (!focusTrash()) trashSummary.focus();
  }

  function focusTrash() {
    const first = trashListEl.querySelector("button");
    if (!first) return false;
    first.focus();
    return true;
  }

  function trashButton(text, className, key, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.addEventListener("click", onClick);
    trashButtons.set(key, button);
    return button;
  }

  function renderTrash(readError = "") {
    const focused = [...trashButtons].find(([, el]) => el === document.activeElement);
    trashButtons.clear();
    trashListEl.replaceChildren();
    trashCountEl.textContent = String(trash.length);
    trashEmptyEl.textContent = readError ? "Recently deleted drafts could not be read: " + readError : "No recently deleted drafts.";
    trashEmptyEl.classList.toggle("error", !!readError);
    trashEmptyEl.hidden = trash.length > 0;
    emptyTrashBtn.hidden = trash.length === 0;
    for (const entry of trash) {
      const name = displayTitle(entry);
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.className = "trash-title";
      title.textContent = name;
      const preview = document.createElement("span");
      preview.className = "trash-preview";
      preview.textContent = entry.body.replace(/\s+/g, " ").trim() || "No text";
      const when = document.createElement("time");
      when.className = "trash-time";
      if (entry.deletedAt === null) when.textContent = "Deletion time unknown";
      else {
        when.setAttribute("datetime", new Date(entry.deletedAt).toISOString());
        when.textContent = "Deleted " + new Date(entry.deletedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      }
      const actions = document.createElement("span");
      actions.className = "trash-actions";
      actions.append(
        trashButton("Restore", "secondary small", "restore:" + entry.id, `Restore ${name}`, () => restore(entry.id, false)),
        // The accessible name starts with the visible label, for speech input.
        trashButton("Delete for good", "danger small", "forget:" + entry.id, `Delete for good: ${name}`, () => forget(entry)));
      li.append(title, preview, when, actions);
      trashListEl.appendChild(li);
    }
    if (focused && trashButtons.has(focused[0])) trashButtons.get(focused[0]).focus();
  }

  async function loadTrash() {
    try {
      trash = await store.getTrash();
    } catch (error) {
      trash = [];
      return renderTrash(errorText(error));
    }
    renderTrash();
  }

  async function emptyTrash() {
    const count = trash.length;
    if (!count || !window.confirm(`Empty Recently deleted drafts? The ${count === 1 ? "draft" : count + " drafts"} in it will be deleted for good.`)) return;
    try {
      await store.emptyTrash();
    } catch (error) {
      tell("Could not empty Recently deleted drafts: " + errorText(error), true);
      return;
    }
    await loadTrash();
    tell("Recently deleted drafts is empty.");
    trashSummary.focus();
  }

  // ---- copy and download --------------------------------------------------------

  async function copyText() {
    const text = bodyEl.value;
    if (!text.trim()) return tell("There is no text to copy yet.");
    try {
      await navigator.clipboard.writeText(text);
      tell("Copied. Paste it wherever you need it.");
    } catch (_) {
      bodyEl.focus();
      bodyEl.select();
      tell("Could not copy automatically. The text is selected: press Ctrl+C (⌘C on a Mac) to copy it.", true);
    }
  }

  function download() {
    const text = editorText();
    if (!hasText(text)) return tell("There is no text to download yet.");
    const title = text.title.trim();
    const name = store.fileNameFor(displayTitle(text));
    const blob = new Blob([title ? title + "\n\n" + text.body : text.body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    tell("Downloaded " + name + ".");
  }

  // ---- suggestions --------------------------------------------------------------

  function allDraftTexts() {
    const texts = drafts.map((draft) => current && draft.id === current.id ? bodyEl.value : draft.body);
    if (!current && bodyEl.value.trim()) texts.push(bodyEl.value);
    return texts;
  }

  // Only scheduleSuggest starts this, and turning suggestions off or removing
  // the provider cancels it.
  function runSuggest() {
    suggestTimer = 0;
    const fn = provider;
    const draft = { id: current ? current.id : null, title: titleEl.value, body: bodyEl.value };
    const texts = allDraftTexts();
    Promise.resolve().then(() => fn(draft, texts)).catch((error) => {
      console.warn("actle writing pad: suggestions failed", error);
    });
  }

  function scheduleSuggest(delay = SUGGEST_DELAY) {
    clearTimeout(suggestTimer);
    suggestTimer = 0;
    if (!ready || !prefs.suggestions || !provider) return;
    suggestTimer = setTimeout(runSuggest, delay);
  }

  function showSuggestions(on) {
    prefs.suggestions = on;
    toggleEl.checked = on;
    toggleHint.textContent = on
      ? "Ideas come only from your drafts in this pad, never from text you type on websites."
      : "Off. Nothing you write is analyzed.";
    panelEl.hidden = !on;
    if (!on) {
      clearTimeout(suggestTimer);
      suggestTimer = 0;
      panelEl.replaceChildren();
    } else scheduleSuggest(0);
  }

  async function toggleSuggestions() {
    const on = toggleEl.checked;
    showSuggestions(on);
    toggleEl.disabled = true;
    try {
      prefs = { ...prefs, ...(await store.savePrefs({ suggestions: on })) };
    } catch (error) {
      showSuggestions(!on);
      tell("Could not save the suggestions setting: " + errorText(error), true);
    } finally {
      toggleEl.disabled = false;
    }
  }

  // ---- events --------------------------------------------------------------------

  function edited() {
    if (!ready || readOnly) return;
    scheduleSave();
    renderSoon();
    scheduleSuggest();
  }

  function changedElsewhere(key, change) {
    if (!current || key !== store.DRAFT_PREFIX + current.id) return;
    // Our own saves arrive here too; while one runs, its result decides.
    if (saving || hasUnsaved()) return;
    const next = change.newValue;
    if (next === undefined) {
      releaseLock();
      current = null;
      base = editorText();
      setReadOnly(false);
      renderList();
      tell("This draft was deleted in another tab. It is in Recently deleted drafts; if you keep writing here, your text is saved as a new draft.");
      return;
    }
    if (next && Number.isInteger(next.rev) && next.rev > current.rev && typeof next.body === "string") {
      showSaved({ id: current.id, title: typeof next.title === "string" ? next.title : "", body: next.body,
        rev: next.rev, updatedAt: Number.isFinite(next.updatedAt) ? next.updatedAt : null });
      renderList();
      renderSaveState();
      scheduleSuggest();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let draftsChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key.startsWith(store.DRAFT_PREFIX)) {
        draftsChanged = true;
        if (ready) changedElsewhere(key, change);
      } else if (key === store.TRASH_KEY) loadTrash();
      else if (key === store.PREFS_KEY && ready) {
        const next = change.newValue;
        if (next && typeof next.suggestions === "boolean" && next.suggestions !== prefs.suggestions) showSuggestions(next.suggestions);
      }
    }
    if (draftsChanged) refreshDraftsSoon();
  });

  titleEl.addEventListener("input", edited);
  bodyEl.addEventListener("input", edited);
  for (const el of [titleEl, bodyEl]) el.addEventListener("blur", () => { if (ready && hasUnsaved()) saveNow(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && ready && hasUnsaved()) saveNow();
  });
  // The browser releases this page's draft lock when it goes away.
  window.addEventListener("pagehide", () => {
    if (ready && hasUnsaved()) saveNow();
  });
  window.addEventListener("beforeunload", (event) => {
    if (!ready || (!saving && !saveTimer && !hasUnsaved())) return;
    saveNow();
    event.preventDefault();
    event.returnValue = "";
  });
  document.addEventListener("keydown", (event) => {
    // Ctrl+S / ⌘S saves now instead of opening the browser's Save page dialog.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "s") {
      event.preventDefault();
      if (ready) saveNow();
    }
  });
  // actle's own insertions and other scripts can change the editor without an
  // event this page sees, so compare it regularly. After a failed save this
  // retries only once the text changes again; typing always retries.
  setInterval(() => {
    if (!ready || readOnly) return;
    if (bodyEl.value !== lastSeenBody) {
      renderWords();
      renderList();
      scheduleSuggest();
    }
    if (saving || saveTimer || !hasUnsaved()) return;
    if (saveError && failedText && sameText(failedText, editorText())) return;
    saveNow();
  }, CHECK_INTERVAL);

  newBtn.addEventListener("click", newDraft);
  selectEl.addEventListener("change", async () => {
    if (!selectEl.value) return;
    if (!(await openDraft(selectEl.value))) selectEl.value = current ? current.id : "";
  });
  copyBtn.addEventListener("click", copyText);
  downloadBtn.addEventListener("click", download);
  deleteBtn.addEventListener("click", deleteCurrent);
  undoBtn.addEventListener("click", () => {
    if (undoId) restore(undoId, true);
  });
  takeOverBtn.addEventListener("click", takeOver);
  emptyTrashBtn.addEventListener("click", emptyTrash);
  toggleEl.addEventListener("change", toggleSuggestions);

  self.ActlePad = Object.freeze({
    panel: panelEl,
    onSuggest(fn) {
      provider = typeof fn === "function" ? fn : null;
      scheduleSuggest(0);
    },
    requestSuggestions() {
      scheduleSuggest(0);
    },
    suggestionsOn: () => prefs.suggestions,
    store,
  });

  // ---- start ---------------------------------------------------------------------

  (async function start() {
    let readFailure = "";
    try {
      [drafts, prefs] = await Promise.all([store.listDrafts(), store.getPrefs()]);
    } catch (error) {
      readFailure = errorText(error);
    }
    await loadTrash();
    ready = true;
    showSuggestions(prefs.suggestions);
    toggleEl.disabled = false;
    const first = drafts.find((draft) => draft.id === prefs.lastDraftId) || drafts[0] || null;
    await show(first);
    if (readFailure) tell("Your drafts could not be read: " + readFailure + ". What you write now is still saved.", true);
    if (!readOnly && !first) bodyEl.focus();
  })();
})();
