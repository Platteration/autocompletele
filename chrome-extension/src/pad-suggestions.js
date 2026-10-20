// The Writing pad's Suggestions panel: phrases the person keeps writing,
// offered as shortcuts (phrase-miner.js), and a fill-in-the-blank version of
// the open draft (template-maker.js). It renders into self.ActlePad.panel and
// is called through self.ActlePad.onSuggest, so it runs only while
// suggestions are on, at most once per 1.5 s of idle typing (see pad.js).
// Load it after pad.js.
//
// Only the pad's own drafts are read. A shortcut made here is saved with
// ShorthandStorage.saveShorthand and checked like one added in the library.
(function () {
  "use strict";

  const pad = self.ActlePad;
  const store = pad.store;
  const panel = pad.panel;
  const storage = self.ShorthandStorage;
  const miner = self.ShorthandPhraseMiner;
  const maker = self.ShorthandTemplateMaker;

  const PHRASE_CARDS = 3;
  // Phrases are looked for in the open draft and then the newest drafts, up
  // to this many characters in all, so a large pad does not hold up typing.
  const TEXT_BUDGET = 100000;
  const TEMPLATE_MIN_WORDS = 20;
  const WORD = /[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;

  let uid = 0;
  let runs = 0;
  let root = null;
  let ui = null;
  let paused = false; // the library could not be read on the last run
  const phraseCards = new Map(); // phrase -> card
  const notNow = new Set(); // phrases hidden until the pad is opened again
  const templateNotNow = new Set(); // drafts whose template card is hidden until then
  let template = null; // the open draft's fill-in template card

  // ---- small helpers ----------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function nextId(name) {
    return "suggest-" + name + "-" + ++uid;
  }

  function errorText(error) {
    return error && error.message ? error.message : String(error);
  }

  function say(msg, text, isError = false) {
    msg.textContent = text;
    msg.classList.toggle("error", !!isError);
  }

  function triggerInput(id) {
    const input = el("input", "suggest-trigger");
    input.type = "text";
    input.id = id;
    input.autocomplete = "off";
    input.spellcheck = false;
    // Typing a trigger here must not expand it.
    input.setAttribute("data-shorthand-ignore", "");
    return input;
  }

  // The library's rules for a new trigger.
  function triggerProblem(trigger) {
    if (!trigger) return "Trigger cannot be empty.";
    if (/\s/.test(trigger)) return "Trigger cannot contain spaces.";
    return "";
  }

  async function triggerUsed(trigger) {
    const { shorthands } = await storage.getAll();
    return shorthands.some((item) => item.trigger === trigger);
  }

  // The open draft first, then the others newest first, up to TEXT_BUDGET
  // characters. The open draft's copy among the others counts once: the miner
  // counts identical texts once.
  function within(body, texts) {
    const out = [];
    let left = TEXT_BUDGET;
    for (const text of [body, ...texts]) {
      if (left <= 0) break;
      const piece = text.length > left ? text.slice(0, left) : text;
      out.push(piece);
      left -= piece.length;
    }
    return out;
  }

  // ---- the panel ----------------------------------------------------------------

  // pad.js empties the panel when suggestions are turned off; start again then.
  function ensureRoot() {
    if (root && panel.contains(root)) return;
    phraseCards.clear();
    template = null;
    paused = false;
    root = el("div", "suggest-root");
    const notice = el("p", "suggest-notice");
    notice.setAttribute("role", "status");
    notice.tabIndex = -1;
    const announce = el("p", "sr-only");
    announce.setAttribute("role", "status");
    const phrases = el("ul", "suggest-list");
    phrases.setAttribute("aria-label", "Shortcut ideas");
    const templateSlot = el("div", "suggest-template");
    const empty = el("div", "suggest-empty");
    empty.append(el("p", "suggest-empty-title", "Nothing to suggest yet."),
      el("p", "", "Write the same phrase in three places and it shows up here as a shortcut idea. "
        + "A draft of 20 words or more with a name, date or amount can become a fill-in template."));
    empty.hidden = true;
    root.append(notice, announce, phrases, templateSlot, empty);
    panel.replaceChildren(root);
    ui = { notice, announce, phrases, templateSlot, empty };
  }

  // The outcome of the latest action in the panel. It stays until the next one.
  function tell(text, { error = false, library = false } = {}) {
    ensureRoot();
    ui.notice.replaceChildren();
    ui.notice.classList.toggle("error", error);
    if (!text) return;
    ui.notice.append(text);
    if (library) {
      const link = el("a", "", "Open library");
      link.href = "options.html";
      link.target = "_blank";
      link.rel = "noopener";
      ui.notice.append(" ", link);
    }
  }

  // Where keyboard focus goes when the card it was in goes away.
  function focusAfter(card) {
    const input = card && card.querySelector("input");
    if (input) return input.focus();
    if (ui.notice.textContent) return ui.notice.focus();
    document.getElementById("suggestToggle").focus();
  }

  function renderEmpty() {
    ui.empty.hidden = paused || phraseCards.size > 0 || !!(template && template.card);
  }

  // ---- 5a: repeated phrases -> shortcut -----------------------------------------

  function phraseCard(item) {
    const id = nextId("phrase");
    const li = el("li", "suggest-card");
    const form = el("form", "suggest-form");
    form.noValidate = true;
    const text = el("p", "suggest-text");
    text.id = id + "-text";
    const label = el("label", "suggest-label", "Trigger");
    label.htmlFor = id + "-trigger";
    const input = triggerInput(id + "-trigger");
    const msg = el("p", "suggest-msg");
    msg.id = id + "-msg";
    msg.setAttribute("role", "status");
    input.setAttribute("aria-describedby", text.id + " " + msg.id);
    const make = el("button", "small", "Make shortcut");
    make.type = "submit";
    const row = el("div", "suggest-row");
    row.append(input, make);
    const later = el("button", "secondary small", "Not now");
    later.type = "button";
    const never = el("button", "secondary small", "Don't suggest this");
    never.type = "button";
    const more = el("div", "suggest-more");
    more.append(later, never);
    form.append(el("p", "suggest-eyebrow", "Shortcut idea"), text, label, row, more, msg);
    li.append(form);
    li.dataset.phrase = item.phrase;

    const card = { li, text, input, msg, make, later, never, item: null, dirty: false, busy: false };
    input.addEventListener("input", () => {
      card.dirty = true;
      say(msg, "");
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      makeShortcut(card);
    });
    later.addEventListener("click", () => hidePhrase(card));
    never.addEventListener("click", () => dismissPhrase(card));
    return card;
  }

  function updatePhraseCard(card, item) {
    const changed = !card.item || card.item.display !== item.display || card.item.count !== item.count;
    card.item = item;
    if (changed) {
      const phrase = el("strong", "suggest-phrase", `“${item.display}”`);
      card.text.replaceChildren("You've written ", phrase, ` ${item.count} times.`);
      // The visible label comes first, for speech input.
      card.make.setAttribute("aria-label", `Make shortcut for “${item.display}”`);
      card.later.setAttribute("aria-label", `Not now: “${item.display}”`);
      card.never.setAttribute("aria-label", `Don't suggest this: “${item.display}”`);
    }
    // A trigger the person typed stays; the proposal follows the library.
    if (!card.dirty && card.input.value !== item.trigger) card.input.value = item.trigger;
  }

  function removePhraseCard(card) {
    const hadFocus = card.li.contains(document.activeElement);
    const next = card.li.nextElementSibling || card.li.previousElementSibling;
    card.li.remove();
    if (phraseCards.get(card.item.phrase) === card) phraseCards.delete(card.item.phrase);
    if (hadFocus) focusAfter(next);
    renderEmpty();
  }

  // Returns the phrases that were not shown before.
  function renderPhrases(items) {
    const keep = new Set(items.map((item) => item.phrase));
    for (const card of [...phraseCards.values()]) {
      if (!keep.has(card.item.phrase)) removePhraseCard(card);
    }
    const added = [];
    items.forEach((item, index) => {
      let card = phraseCards.get(item.phrase);
      if (!card) {
        card = phraseCard(item);
        phraseCards.set(item.phrase, card);
        added.push(item);
      }
      updatePhraseCard(card, item);
      const at = ui.phrases.children[index];
      if (at !== card.li) ui.phrases.insertBefore(card.li, at || null);
    });
    return added;
  }

  async function makeShortcut(card) {
    if (card.busy) return;
    const trigger = card.input.value.trim();
    const problem = triggerProblem(trigger);
    if (problem) {
      say(card.msg, problem, true);
      return card.input.focus();
    }
    const { display } = card.item;
    card.busy = true;
    say(card.msg, "Saving…");
    try {
      if (await triggerUsed(trigger)) {
        say(card.msg, "That trigger is already used.", true);
        return card.input.focus();
      }
      await storage.saveShorthand({ trigger, expansion: display });
    } catch (error) {
      return say(card.msg, "Could not save: " + errorText(error), true);
    } finally {
      card.busy = false;
    }
    tell(`Saved ${trigger}. Type it anywhere to insert “${display}”.`, { library: true });
    removePhraseCard(card);
    pad.requestSuggestions();
  }

  function hidePhrase(card) {
    if (card.busy) return;
    notNow.add(card.item.phrase);
    tell(`“${card.item.display}” is hidden until you open the pad again.`);
    removePhraseCard(card);
    pad.requestSuggestions();
  }

  async function dismissPhrase(card) {
    if (card.busy) return;
    card.busy = true;
    try {
      await store.dismissPhrase(card.item.phrase);
    } catch (error) {
      return say(card.msg, "Could not save that choice: " + errorText(error), true);
    } finally {
      card.busy = false;
    }
    tell(`“${card.item.display}” will not be suggested again.`);
    removePhraseCard(card);
    pad.requestSuggestions();
  }

  // ---- 5b: the open draft as a fill-in template ---------------------------------

  function groupOf(blank) {
    return blank.kind + "\u0000" + blank.value;
  }

  // The name a group of identical values gets: the person's, or the proposed one.
  function nameOf(entry) {
    return template.names.has(entry.group) ? template.names.get(entry.group) : entry.blank.name;
  }

  function chosen(entry) {
    return !template.off.has(entry.key);
  }

  // Initials of the first two or three words of the title, else "draft".
  function templateStem(title) {
    const words = String(title).match(WORD) || [];
    if (words.length < 2) return "draft";
    return words.slice(0, 3).map((word) => String.fromCodePoint(word.codePointAt(0)).toLowerCase()).join("");
  }

  function templateCard() {
    const id = nextId("template");
    const section = el("section", "suggest-card template-card");
    const title = el("h3", "suggest-title", "Turn this draft into a fill-in template");
    title.id = id + "-title";
    section.setAttribute("aria-labelledby", title.id);
    const hint = el("p", "suggest-hint", "Each highlighted value becomes a blank you fill in when you use the template. "
      + "Click a value, or press Space on it, to keep it as written.");
    hint.id = id + "-hint";
    const preview = el("div", "template-preview");
    preview.setAttribute("role", "group");
    preview.setAttribute("aria-label", "Draft with its blanks");
    preview.setAttribute("aria-describedby", hint.id);
    const names = el("div", "blank-names");
    const namesLabel = el("p", "suggest-label", "Blank names");
    namesLabel.id = id + "-names";
    const namesList = el("ul", "blank-list");
    namesList.setAttribute("aria-labelledby", namesLabel.id);
    names.append(namesLabel, namesList);

    const form = el("form", "suggest-form");
    form.noValidate = true;
    const label = el("label", "suggest-label", "Trigger");
    label.htmlFor = id + "-trigger";
    const input = triggerInput(id + "-trigger");
    const msg = el("p", "suggest-msg");
    msg.id = id + "-msg";
    msg.setAttribute("role", "status");
    input.setAttribute("aria-describedby", msg.id);
    const save = el("button", "small", "Save as template");
    save.type = "submit";
    const row = el("div", "suggest-row");
    row.append(input, save);
    const later = el("button", "secondary small", "Not now");
    later.type = "button";
    later.setAttribute("aria-label", "Not now: fill-in template");
    const more = el("div", "suggest-more");
    more.append(later);
    form.append(label, row, more, msg);
    section.append(el("p", "suggest-eyebrow", "Fill-in template"), title, hint, preview, names, form);

    input.addEventListener("input", () => {
      template.dirtyTrigger = true;
      say(msg, "");
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveTemplate();
    });
    later.addEventListener("click", hideTemplate);
    return { section, preview, names, namesList, input, msg };
  }

  function paintChip(entry) {
    const { chip, blank } = entry;
    const on = chosen(entry);
    const name = nameOf(entry).trim() || "?";
    chip.setAttribute("aria-pressed", String(on));
    chip.textContent = on ? name : blank.value;
    if (on) {
      chip.setAttribute("aria-label", `${name}: ${blank.value}`);
      chip.title = `“${blank.value}” becomes the blank “${name}”. Click to keep it as written.`;
    } else {
      chip.removeAttribute("aria-label");
      chip.title = `“${blank.value}” stays as written. Click to make it a blank.`;
    }
  }

  function renderPreview() {
    const { card, body, blanks } = template;
    const focused = template.chips.find((entry) => entry.chip === document.activeElement);
    const fragment = document.createDocumentFragment();
    const seen = new Map();
    template.chips = [];
    let at = 0;
    for (const blank of blanks) {
      if (blank.start > at) fragment.append(body.slice(at, blank.start));
      const group = groupOf(blank);
      const n = (seen.get(group) || 0) + 1;
      seen.set(group, n);
      const chip = el("button", "blank-chip");
      chip.type = "button";
      const entry = { blank, group, key: group + "\u0000" + n, chip };
      chip.addEventListener("click", () => toggleChip(entry));
      paintChip(entry);
      template.chips.push(entry);
      fragment.append(chip);
      at = blank.end;
    }
    if (at < body.length) fragment.append(body.slice(at));
    card.preview.replaceChildren(fragment);
    if (focused) {
      const again = template.chips.find((entry) => entry.key === focused.key);
      if (again) again.chip.focus();
    }
  }

  // One row per group of identical chosen values, in reading order.
  function renderNames() {
    const { card, rows } = template;
    const groups = [];
    const seen = new Set();
    for (const entry of template.chips) {
      if (!chosen(entry) || seen.has(entry.group)) continue;
      seen.add(entry.group);
      groups.push(entry);
    }
    for (const [group, row] of rows) {
      if (!seen.has(group)) {
        row.li.remove();
        rows.delete(group);
      }
    }
    groups.forEach((entry, index) => {
      let row = rows.get(entry.group);
      if (!row) {
        const id = nextId("blank");
        const li = el("li", "blank-row");
        const label = el("label", "blank-value");
        label.htmlFor = id;
        label.append(el("span", "sr-only", "Blank name for "), `“${entry.blank.value}”`);
        label.title = entry.blank.value;
        const input = el("input", "blank-name");
        input.type = "text";
        input.id = id;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("data-shorthand-ignore", "");
        input.setAttribute("aria-describedby", card.msg.id);
        input.addEventListener("input", () => {
          template.names.set(entry.group, input.value);
          for (const other of template.chips) if (other.group === entry.group) paintChip(other);
          say(card.msg, "");
        });
        li.append(label, input);
        row = { li, input };
        rows.set(entry.group, row);
      }
      if (document.activeElement !== row.input && row.input.value !== nameOf(entry)) row.input.value = nameOf(entry);
      const at = card.namesList.children[index];
      if (at !== row.li) card.namesList.insertBefore(row.li, at || null);
    });
    card.names.hidden = groups.length === 0;
  }

  function toggleChip(entry) {
    if (template.off.has(entry.key)) template.off.delete(entry.key);
    else template.off.add(entry.key);
    paintChip(entry);
    renderNames();
    say(template.card.msg, "");
  }

  function removeTemplateCard() {
    if (!template || !template.card) return;
    const hadFocus = template.card.section.contains(document.activeElement);
    template.card.section.remove();
    template.card = null;
    template.rows.clear();
    template.chips = [];
    template.body = null;
    if (hadFocus) focusAfter(null);
    renderEmpty();
  }

  function draftKey(id) {
    return id === null ? "" : id;
  }

  // Returns true when the card appeared with this run.
  function renderTemplate(draft, blanks, triggers) {
    if (!template || template.draftId !== draft.id) {
      removeTemplateCard();
      template = { draftId: draft.id, body: null, blanks: [], chips: [], rows: new Map(), off: new Set(), names: new Map(),
        dirtyTrigger: false, busy: false, savedBody: null, card: null };
    }
    const show = blanks.length > 0 && !templateNotNow.has(draftKey(draft.id)) && template.savedBody !== draft.body;
    if (!show) {
      removeTemplateCard();
      return false;
    }
    const appeared = !template.card;
    if (appeared) {
      template.card = templateCard();
      ui.templateSlot.append(template.card.section);
    }
    if (template.body !== draft.body) {
      template.body = draft.body;
      template.blanks = blanks;
      renderPreview();
      renderNames();
    }
    if (!template.dirtyTrigger) {
      const trigger = miner.uniqueTrigger(templateStem(draft.title), triggers);
      if (template.card.input.value !== trigger) template.card.input.value = trigger;
    }
    return appeared;
  }

  function hideTemplate() {
    if (!template || template.busy) return;
    templateNotNow.add(draftKey(template.draftId));
    tell("The fill-in template for this draft is hidden until you open the pad again.");
    removeTemplateCard();
  }

  async function saveTemplate() {
    if (!template || !template.card || template.busy) return;
    // Another draft may open while this one saves; this state is the one saved.
    const state = template;
    const { card, body } = state;
    const trigger = card.input.value.trim();
    const problem = triggerProblem(trigger);
    if (problem) {
      say(card.msg, problem, true);
      return card.input.focus();
    }
    const spans = [];
    for (const entry of state.chips) {
      if (!chosen(entry)) continue;
      const name = nameOf(entry).trim();
      const problemName = !name ? "Give every blank a name."
        : /[\[\]]/.test(name) ? "A blank name cannot contain [ or ]." : "";
      if (problemName) {
        say(card.msg, problemName, true);
        return state.rows.get(entry.group).input.focus();
      }
      spans.push({ start: entry.blank.start, end: entry.blank.end, name });
    }
    let expansion;
    try {
      expansion = maker.buildTemplate(body, spans);
    } catch (error) {
      return say(card.msg, "Could not make the template: " + errorText(error), true);
    }
    state.busy = true;
    say(card.msg, "Saving…");
    try {
      if (await triggerUsed(trigger)) {
        say(card.msg, "That trigger is already used.", true);
        return card.input.focus();
      }
      await storage.saveShorthand({ trigger, expansion });
    } catch (error) {
      return say(card.msg, "Could not save: " + errorText(error), true);
    } finally {
      state.busy = false;
    }
    state.savedBody = body;
    state.dirtyTrigger = false;
    tell(spans.length ? `Saved ${trigger}. Typing it opens the fill-in form.`
      : `Saved ${trigger}. Type it anywhere to insert this draft.`, { library: true });
    // Hidden until the draft changes: the template is in the library now.
    if (template === state) removeTemplateCard();
    pad.requestSuggestions();
  }

  // ---- each run -------------------------------------------------------------------

  async function suggest(draft, texts) {
    const run = ++runs;
    let library;
    let dismissed;
    try {
      [library, dismissed] = await Promise.all([storage.getAll(), store.getDismissed()]);
    } catch (error) {
      if (run !== runs || !pad.suggestionsOn()) return;
      ensureRoot();
      for (const card of [...phraseCards.values()]) removePhraseCard(card);
      removeTemplateCard();
      paused = true;
      tell("Suggestions are paused: your library could not be read. " + errorText(error), { error: true });
      renderEmpty();
      return;
    }
    if (run !== runs || !pad.suggestionsOn()) return;
    const shorthands = library.shorthands;
    const phrases = miner.findRepeatedPhrases(within(draft.body, texts),
      { limit: PHRASE_CARDS + notNow.size, dismissed, shorthands })
      .filter((item) => !notNow.has(item.phrase)).slice(0, PHRASE_CARDS);
    const blanks = store.countWords(draft.body) >= TEMPLATE_MIN_WORDS ? maker.findBlanks(draft.body) : [];

    ensureRoot();
    if (paused) {
      paused = false;
      tell("");
    }
    const added = renderPhrases(phrases);
    // The template's trigger also stays clear of the ones proposed above.
    const triggers = [...shorthands, ...phrases.map((item) => item.trigger)];
    const appeared = renderTemplate(draft, blanks, triggers);
    renderEmpty();

    const news = [];
    if (added.length) news.push((added.length === 1 ? "New shortcut idea: " : "New shortcut ideas: ")
      + added.map((item) => `“${item.display}”`).join(", ") + ".");
    if (appeared) news.push("This draft can become a fill-in template.");
    if (news.length) ui.announce.textContent = news.join(" ");
  }

  // A shortcut added or removed elsewhere, or a phrase dismissed in another
  // tab, changes what is worth suggesting.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (storage.isLibraryChange(changes, area) || (area === "local" && Object.hasOwn(changes, store.DISMISSED_KEY))) {
      pad.requestSuggestions();
    }
  });

  pad.onSuggest(suggest);
})();
