// actle Notes: dashboard tab. The organisation's documents with their
// triggers, sections, blanks and action-block setting; the author setting
// prefilled into every note; and a "Try it" box that finds the action items
// of a pasted note and shows the updated note, the way the tray entry does on
// the clipboard (without touching the clipboard or counting anything).
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  // Kept across renders: the section is rebuilt on every change event.
  let draft = "";
  let tried = null;

  function describeActions(doc, fallback) {
    if (!doc.actions) return "off";
    const own = !fallback || doc.actions.heading !== fallback.heading || doc.actions.patterns.join() !== fallback.patterns.join();
    return "\"" + doc.actions.heading + "\"" + (own ? " (" + doc.actions.patterns.join(", ") + ")" : "");
  }

  function renderTried(helpers, result) {
    const { el } = helpers;
    if (!result) return [];
    if (!result.enabled) return [el("p", { class: "hint", text: "Action items are switched off in the policy; the note is left as it is." })];
    const out = [];
    if (!result.items.length) out.push(el("p", { class: "hint", text: "No action items found." }));
    else {
      out.push(el("table", {}, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Owner" }), el("th", { text: "Due" }), el("th", { text: "Action" }), el("th", { class: "num", text: "Line" })])]),
        el("tbody", {}, result.items.map((item) => el("tr", {}, [
          el("td", { text: item.owner || "" }),
          el("td", { text: item.due ? item.due + (item.dueText && item.dueText !== item.due ? " (" + item.dueText + ")" : "") : "" }),
          el("td", { text: item.text }),
          el("td", { class: "num", text: String(item.line) }),
        ]))),
      ]));
    }
    out.push(el("p", { class: "hint mt", text: result.changed ? "The note with its action block rebuilt:" : "The note is already up to date:" }));
    out.push(el("div", { class: "overlay", text: result.text }));
    return out;
  }

  window.actleApps.notes = {
    async render(section, helpers) {
      const { api, el, announce } = helpers;
      const info = await api.invoke("notes:info");
      section.textContent = "";
      if (!info || info.ok === false) {
        section.append(el("p", { class: "hint", text: "Notes is not available: " + ((info && info.error) || "no answer from the app.") }));
        return;
      }
      section.append(el("p", { class: "hint", text: "Type a document's trigger in any application, or pick the document in the search palette, and a small form asks for its blanks; Enter pastes the note with the date, the weekday and your name filled in. The caret lands where the document says. Action items written anywhere in a note (a name followed by \"will\" or \"to\", an @mention, a due phrase, or one of the organisation's patterns) are collected into the action block: copy the note, choose \"" + info.trayLabel + "\" in the tray menu or \"" + info.paletteLabel + "\" in the palette, then paste over the note. Lines you typed into the block by hand are kept. Clipboard updates are not counted in the statistics." }));
      if (info.paused) section.append(el("div", { class: "banner" }, [el("div", { text: "Paused by your organisation: no documents are offered." })]));

      section.append(el("h2", { text: "Documents" }));
      if (!info.configured) section.append(el("p", { class: "hint", text: "The organisation policy has no note documents (section \"notes\")." }));
      const rows = info.documents.map((doc) => el("tr", {}, [
        el("td", { class: "mono", text: doc.trigger }),
        // A p: the stylesheet mutes p.hint, not a div with the class.
        el("td", {}, [el("div", { text: doc.label }), el("p", { class: "hint mono", text: doc.id })]),
        el("td", { text: doc.sections.map((s) => (s.heading || "(no heading)") + (s.repeat ? " (repeats)" : "")).join(", ") }),
        el("td", { class: "mono", text: doc.blanks.map((b) => b.name + (b.list ? " (list)" : "")).join(", ") }),
        el("td", { text: describeActions(doc, info.actions) }),
        el("td", { class: "num", text: String(doc.inserted) }),
      ]));
      section.append(el("table", {}, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Trigger" }), el("th", { text: "Document" }), el("th", { text: "Sections" }), el("th", { text: "Blanks" }), el("th", { text: "Action block" }), el("th", { class: "num", text: "Inserted" })])]),
        el("tbody", {}, rows),
      ]));
      section.append(el("p", { class: "hint mt", text: (info.actions ? "Action patterns: " + info.actions.patterns.join(", ") + "; an empty block reads \"" + info.actions.empty + "\". " : "The policy switches action blocks off. ") + "Dates in due phrases are read " + info.dateOrder + ". Clipboard updates so far: " + info.actionUpdates + "." }));

      section.append(el("h2", { class: "mt", text: "Author" }));
      section.append(el("p", { class: "hint", text: "Prefilled into the \"" + info.author.blank + "\" blank of every document; the name you insert with is remembered here." }));
      const author = el("input", { type: "text", "aria-label": "Author", placeholder: "Your name as it should appear in notes" });
      author.value = info.author.value;
      const save = el("button", { class: "plain", text: "Save" });
      save.addEventListener("click", async () => {
        const result = await api.invoke("notes:setAuthor", { author: author.value });
        announce(result && result.ok ? (result.author ? "Author saved: " + result.author : "Author cleared") : (result && result.error) || "Could not save the author");
      });
      section.append(el("div", { class: "row mb" }, [author, save]));

      section.append(el("h2", { class: "mt", text: "Try it" }));
      section.append(el("p", { class: "hint", text: "Paste a note here to see the action items found and the note with its block rebuilt. Nothing is counted, and your clipboard is not touched." }));
      const box = el("textarea", { rows: "8", "aria-label": "Note to check" });
      box.value = draft;
      box.addEventListener("input", () => { draft = box.value; });
      const results = el("div", {}, renderTried(helpers, tried));
      const run = el("button", { class: "primary", text: "Find action items" });
      run.addEventListener("click", async () => {
        const found = await api.invoke("notes:actions", { text: box.value });
        const updated = await api.invoke("notes:update", { text: box.value });
        tried = found && updated && found.ok && updated.ok ? { enabled: found.enabled, items: found.items, text: updated.text, changed: updated.changed } : null;
        results.textContent = "";
        for (const node of renderTried(helpers, tried)) results.append(node);
        announce(!tried ? "Could not check the note" : tried.items.length ? tried.items.length + " action item" + (tried.items.length === 1 ? "" : "s") + " found" : "No action items found");
      });
      section.append(el("label", {}, [box]), el("div", { class: "toolbar" }, [run]), results);
    },
  };
})();
