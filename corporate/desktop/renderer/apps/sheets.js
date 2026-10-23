// extle: dashboard tab. Shows the policy's vocabularies, column rules
// and blocks, tries completions against pasted column values through the
// sheets:complete channel, and exports the section for the add-in. Rebuilt on
// every change; what was typed into "Try it" is kept across rebuilds.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  const tryState = { header: "", sheet: "", text: "", values: "", result: null };

  function table(el, headers, rows, empty) {
    const body = el("tbody", {}, rows);
    if (!rows.length) body.append(el("tr", {}, [el("td", { colspan: String(headers.length), text: empty })]));
    const head = headers.map((h) => el("th", typeof h === "string" ? { text: h } : { class: "num", text: h.text }));
    return el("table", {}, [el("thead", {}, [el("tr", {}, head)]), body]);
  }

  function describeBlock(block) {
    return block.kind === "formula" ? "formula " + block.formula : block.rows + " rows × " + block.columns + " columns";
  }

  /** A rejected channel call (the main process threw) as one line. */
  function failure(error) {
    return String((error && error.message) || error || "unknown error");
  }

  function renderResult(el, results, result) {
    results.textContent = "";
    if (!result || !result.ok) {
      results.append(el("p", { class: "hint", text: (result && result.error) || "No result." }));
      return;
    }
    const rule = result.column
      ? (result.column.vocabulary ? "vocabulary " + result.column.vocabulary + (result.column.strict ? ", strict, so only its values are offered" : "") : "a " + result.column.kind + " column")
      : "no column rule matches, so only the column's own values are offered";
    const profile = result.profile;
    results.append(el("p", { class: "hint", text: "Column rule: " + rule + ". Learned from the values: " + profile.kind + " column, " + profile.total + " values, " + profile.distinct + " distinct" + (profile.sentences ? ", " + profile.sentences + " recurring sentences" : "") + "." }));
    if (result.block) results.append(el("p", { class: "hint", text: "Block " + result.block.trigger + " (" + result.block.label + "): " + describeBlock(result.block) + " would be inserted at the cell." }));
    results.append(table(el, ["Completion", "From", "Match", { text: "Seen" }], result.completions.map((c) => el("tr", {}, [
      el("td", { text: c.value + (c.alias ? " (alias " + c.alias + ")" : "") }),
      el("td", { text: c.source === "vocabulary" ? "vocabulary" : "column" }),
      el("td", { text: c.match }),
      el("td", { class: "num", text: String(c.count) }),
    ])), result.block ? "No text completion; the block above is offered." : "No completion for this text."));
  }

  function renderTryIt(section, helpers) {
    const { api, el } = helpers;
    section.append(el("h2", { class: "mt", text: "Try it" }));
    section.append(el("p", { class: "hint", text: "What the add-in would offer for one cell. Give the column header (and the sheet name) so a column rule can match, paste the column's existing values one per line, then type what the cell would hold, or a / trigger." }));
    const header = el("input", { type: "text", placeholder: "Column header, e.g. Customer", "aria-label": "Column header" });
    header.value = tryState.header;
    const sheet = el("input", { type: "text", placeholder: "Sheet name (optional)", "aria-label": "Sheet name" });
    sheet.value = tryState.sheet;
    const values = el("textarea", { placeholder: "Existing column values, one per line (optional)", "aria-label": "Column values" });
    values.value = tryState.values;
    const typed = el("input", { type: "text", placeholder: "What is typed in the cell, e.g. acm or /exp", "aria-label": "Typed text" });
    typed.value = tryState.text;
    const run = el("button", { class: "primary", text: "Complete" });
    const results = el("div", {});
    section.append(el("div", { class: "row mb" }, [header, sheet]), values, el("div", { class: "row mb mt" }, [typed, run]), results);
    run.addEventListener("click", async () => {
      Object.assign(tryState, { header: header.value, sheet: sheet.value, text: typed.value, values: values.value });
      try {
        tryState.result = await api.invoke("sheets:complete", { header: header.value, sheet: sheet.value, text: typed.value, values: values.value });
      } catch (error) {
        tryState.result = { ok: false, error: "Could not complete: " + failure(error) };
      }
      renderResult(el, results, tryState.result);
    });
    typed.addEventListener("keydown", (event) => { if (event.key === "Enter") run.click(); });
    if (tryState.result) renderResult(el, results, tryState.result);
  }

  function renderAddin(section, helpers, info) {
    const { api, el, announce } = helpers;
    section.append(el("h2", { class: "mt", text: "Excel and Google Sheets add-in" }));
    section.append(el("p", { class: "hint", text: "The add-in lives in " + info.addin.folder + (info.addin.present ? "" : " (not found on this computer)") + "; its README says how to build, sideload and deploy it. Export the configuration, then paste the file's contents into the add-in's settings." }));
    const exportButton = el("button", { class: "primary", text: "Export add-in configuration" });
    exportButton.addEventListener("click", async () => {
      let r;
      try {
        r = await api.invoke("sheets:exportConfig");
      } catch (error) {
        r = { ok: false, error: "Export failed: " + failure(error) };
      }
      announce(r && r.ok ? "Configuration exported to " + r.path + (r.note ? ". " + r.note : "") : (r && r.error) || "Export failed");
    });
    const toolbar = el("div", { class: "toolbar" }, [exportButton]);
    const last = info.lastExport;
    if (last && last.present) {
      const reveal = el("button", { class: "plain", text: "Show file" });
      reveal.addEventListener("click", () => api.revealFiled(last.path));
      toolbar.append(reveal);
    }
    toolbar.append(el("span", { class: "hint", text: last
      ? "Last exported " + new Date(last.at).toLocaleString() + " to " + last.path + (last.present ? " (" + last.vocabularies + " vocabularies, " + last.columns + " column rules, " + last.blocks + " blocks)" : " (file no longer there)")
      : "Not exported yet." }));
    section.append(toolbar);
  }

  window.actleApps.sheets = {
    async render(section, helpers) {
      const { api, el } = helpers;
      const info = await api.invoke("sheets:info");
      section.textContent = "";
      if (!info || !info.ok) {
        section.append(el("p", { class: "hint", text: "extle could not read the policy: " + ((info && info.error) || "unknown error") }));
        return;
      }
      section.append(el("h2", { text: "extle: Excel and Google Sheets" }));
      section.append(el("p", { class: "hint", text: "Vocabularies, column rules and blocks come from the organisation policy (section sheets)" + (info.organization ? " of " + info.organization : "") + ". The desktop assistant cannot see spreadsheet cells, so completing happens in the Excel task pane or the Google Sheets sidebar of the add-in below; a vocabulary column completes to the organisation's one spelling, a strict one to nothing else, other columns to their own values, and a / trigger inserts rows or a formula." }));
      section.append(el("h2", { text: "Vocabularies" }));
      section.append(table(el, ["Name", { text: "Values" }, { text: "Aliases" }, "Examples"], info.vocabularies.map((v) => el("tr", {}, [
        el("td", { class: "mono", text: v.name }), el("td", { class: "num", text: String(v.values) }), el("td", { class: "num", text: String(v.aliases) }), el("td", { text: v.examples.join(", ") }),
      ])), "The policy has no vocabularies."));
      section.append(el("h2", { class: "mt", text: "Column rules" }));
      section.append(table(el, ["Header pattern", "Sheet pattern", "Completes from"], info.columns.map((c) => el("tr", {}, [
        el("td", { class: "mono", text: c.header || "(any)" }), el("td", { class: "mono", text: c.sheet || "(any)" }), el("td", { text: c.vocabulary ? "vocabulary " + c.vocabulary + (c.strict ? " (strict: only its values)" : "") : c.kind + " column" }),
      ])), "No column rules: every column completes from its own values."));
      section.append(el("h2", { class: "mt", text: "Blocks and formulas" }));
      section.append(table(el, ["Trigger", "Label", "Inserts"], info.blocks.map((b) => el("tr", {}, [
        el("td", { class: "mono", text: b.trigger }), el("td", { text: b.label }), el("td", { class: "mono", text: describeBlock(b) }),
      ])), "No blocks in the policy."));
      if (info.warnings.length) {
        section.append(el("h2", { class: "mt", text: "Policy warnings" }));
        for (const warning of info.warnings) section.append(el("p", { class: "hint", text: warning }));
      }
      renderTryIt(section, helpers);
      renderAddin(section, helpers, info);
    },
  };
})();
