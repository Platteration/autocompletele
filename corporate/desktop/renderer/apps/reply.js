// actle Reply: dashboard tab. The organisation's replies with their counts,
// the extractors, library warnings, and a "Try it" box that ranks a pasted
// message the way the tray entry and the palette do (without counting it).
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  // Kept across renders: the section is rebuilt on every change event.
  let draft = "";
  let tried = null;

  function keywordsOf(reply) {
    return reply.keywords.join(", ") + (reply.match === "all" ? " (all)" : "") + (reply.caseSensitive ? " (case-sensitive)" : "");
  }

  function sourceOf(reply, helpers) {
    if (reply.shorthand) return "shortcut " + reply.shorthand + (reply.available ? "" : " (not in the library)");
    return helpers.preview(reply.text);
  }

  function describeExtractor(extractor) {
    return extractor.kind === "after" ? "the rest of the line after \"" + extractor.after + "\"" : "pattern /" + extractor.pattern + "/" + (extractor.group ? ", group " + extractor.group : "");
  }

  function renderCandidates(helpers, candidates) {
    const { el } = helpers;
    if (!candidates.length) return [el("p", { class: "hint", text: draft.trim() ? "No reply fits this message." : "" })];
    return candidates.map((candidate) => {
      const found = Object.entries(candidate.values || {}).map(([name, value]) => name + " = " + value).join("; ");
      const card = el("div", { class: "candidate" }, [
        el("div", { class: "meta", text: candidate.label + " (" + candidate.id + "): found " + candidate.matched.join(", ") + (found ? "; from the message: " + found : "") + (candidate.missing.length ? "; still needed: " + candidate.missing.join(", ") : "") }),
        el("div", { class: "overlay", text: candidate.text }),
      ]);
      return card;
    });
  }

  window.actleApps.reply = {
    async render(section, helpers) {
      const { api, el, announce } = helpers;
      const info = await api.invoke("reply:info");
      section.textContent = "";
      if (!info || info.ok === false) {
        section.append(el("p", { class: "hint", text: "Reply is not available: " + ((info && info.error) || "no answer from the app.") }));
        return;
      }
      section.append(el("p", { class: "hint", text: "Copy the message you are answering, then choose \"" + info.trayLabel + "\" in the tray menu or \"" + info.paletteLabel + "\" in the search palette. The replies whose keywords appear in the message are listed, best fit first, with their blanks filled from it (" + info.builtin.join(", ") + " and the extractors below). Blanks the message does not answer are asked before the text is pasted; a reply is never inserted with a blank still open. Quoted history below \"wrote:\", \"Original Message\" or a From:/Sent:/To:/Subject: header is ignored." }));
      if (info.paused) section.append(el("div", { class: "banner" }, [el("div", { text: "Paused by your organisation: no replies are offered." })]));
      if (info.warnings.length) section.append(el("div", { class: "banner" }, info.warnings.map((warning) => el("div", { text: warning }))));

      section.append(el("h2", { text: "Replies" }));
      if (!info.configured) section.append(el("p", { class: "hint", text: "The organisation policy has no replies (section \"reply\")." }));
      const rows = info.replies.map((reply) => el("tr", {}, [
        el("td", {}, [el("div", { text: reply.label }), el("div", { class: "hint mono", text: reply.id })]),
        el("td", { text: keywordsOf(reply) }),
        el("td", { class: "mono", text: reply.blanks.join(", ") }),
        el("td", { text: sourceOf(reply, helpers) }),
        el("td", { class: "num", text: String(reply.offered) }),
        el("td", { class: "num", text: String(reply.inserted) }),
      ]));
      section.append(el("table", {}, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Reply" }), el("th", { text: "Keywords" }), el("th", { text: "Blanks" }), el("th", { text: "Text" }), el("th", { class: "num", text: "Offered" }), el("th", { class: "num", text: "Inserted" })])]),
        el("tbody", {}, rows),
      ]));
      const reset = el("button", { class: "plain", text: "Reset counts" });
      reset.addEventListener("click", async () => {
        const result = await api.invoke("reply:resetStats");
        announce(result && result.ok ? "Counts reset (" + result.reset + " replies)" : (result && result.error) || "Could not reset the counts");
      });
      section.append(el("div", { class: "toolbar mt" }, [el("span", { class: "hint", text: "Offered: listed in the popover. Inserted: chosen and pasted. At most " + info.max + " replies are listed; dates are read " + info.dateOrder + "." }), reset]));

      section.append(el("h2", { class: "mt", text: "Extractors" }));
      const perReply = info.replies.flatMap((reply) => reply.extractors.map((extractor) => Object.assign({ reply: reply.label }, extractor)));
      const extractors = info.extractors.map((extractor) => Object.assign({ reply: "all replies" }, extractor)).concat(perReply);
      if (!extractors.length) section.append(el("p", { class: "hint", text: "No extractors beyond the built-in blanks." }));
      else {
        section.append(el("table", {}, [
          el("thead", {}, [el("tr", {}, [el("th", { text: "Blank" }), el("th", { text: "Found as" }), el("th", { text: "Applies to" })])]),
          el("tbody", {}, extractors.map((extractor) => el("tr", {}, [el("td", { class: "mono", text: extractor.name }), el("td", { text: describeExtractor(extractor) }), el("td", { text: extractor.reply })]))),
        ]));
      }

      section.append(el("h2", { class: "mt", text: "Try it" }));
      section.append(el("p", { class: "hint", text: "Paste a message here to see which replies would be offered and how their blanks are filled. Nothing is counted or inserted." }));
      const box = el("textarea", { rows: "6", "aria-label": "Message to answer" });
      box.value = draft;
      box.addEventListener("input", () => { draft = box.value; });
      const results = el("div", {}, tried ? renderCandidates(helpers, tried) : []);
      const run = el("button", { class: "primary", text: "Rank replies" });
      run.addEventListener("click", async () => {
        const result = await api.invoke("reply:rank", { text: box.value });
        tried = result && Array.isArray(result.candidates) ? result.candidates : [];
        results.textContent = "";
        for (const node of renderCandidates(helpers, tried)) results.append(node);
        announce(tried.length ? tried.length + " repl" + (tried.length === 1 ? "y fits" : "ies fit") : "No reply fits");
      });
      section.append(el("label", {}, [box]), el("div", { class: "toolbar" }, [run]), results);
    },
  };
})();
