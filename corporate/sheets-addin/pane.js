// actle Sheets add-in: the pane shared by the Excel task pane and the Google
// Sheets sidebar. It builds its own elements, reads cells and writes
// completions only through the host bridge it is given, and completes with
// the ActleSheets bundle. No framework, no inline handlers.
//
// bridge: { readContext() -> Promise<{sheet, address, text, header, values, clipped}|null>,
//           writeValue(target, text), writeRows(target, rows), writeFormula(target, formula),
//           loadConfig() -> Promise<string>, saveConfig(text), onSelectionChanged(handler) }
(function (root) {
  "use strict";

  const STORAGE_KEY = "actleSheetsConfig";

  function el(document, tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children || []) node.append(child);
    return node;
  }

  function describeBlock(block) {
    return block.formula ? "formula " + block.formula : block.rows.length + " rows x " + block.rows[0].length + " columns";
  }

  function reason(error) {
    return String((error && error.message) || error || "unknown error");
  }

  function summarize(parsed) {
    const config = parsed.config;
    const names = Object.keys(config.vocabularies);
    if (!names.length && !config.columns.length && !config.blocks.length && !parsed.warnings.length) {
      return "No configuration yet: export it from the actle desktop app (Sheets tab) and paste the file's contents above.";
    }
    const head = names.length + " vocabularies (" + names.join(", ") + "), " + config.columns.length + " column rules, " + config.blocks.length + " blocks.";
    return parsed.warnings.length ? head + " Skipped: " + parsed.warnings.join("; ") : head;
  }

  function createPane(options) {
    const settings = options || {};
    const document = settings.document;
    const bridge = settings.bridge;
    const core = settings.core;
    const storage = settings.storage || null;
    const make = (tag, attrs, children) => el(document, tag, attrs, children);
    const state = { config: core.parseConfig("").config, warnings: [], context: null, text: "", lastKey: "", message: "", reads: 0 };
    const ui = {
      context: make("p", { class: "context", text: "Select a cell." }),
      refresh: make("button", { class: "plain", type: "button", text: "Refresh" }),
      input: make("input", { type: "text", class: "text", placeholder: "Cell text, or a / trigger", "aria-label": "Cell text" }),
      completions: make("ul", { class: "completions" }),
      block: make("div", { class: "block" }),
      message: make("p", { class: "message", role: "status" }),
      configText: make("textarea", { class: "config", placeholder: "Paste the exported configuration (JSON) here", "aria-label": "Configuration" }),
      save: make("button", { class: "primary", type: "button", text: "Save configuration" }),
      summary: make("p", { class: "summary" }),
    };
    settings.root.append(
      make("div", { class: "toolbar" }, [ui.context, ui.refresh]),
      make("label", {}, ["Cell text", ui.input]),
      ui.completions,
      ui.block,
      ui.message,
      make("details", {}, [
        make("summary", { text: "Settings" }),
        make("p", { class: "hint", text: "The configuration is the sheets section of your organisation policy, exported by the actle desktop app. It is kept with this document and, as a fallback, in this browser." }),
        ui.configText,
        make("div", { class: "actions" }, [ui.save]),
        ui.summary,
      ]),
    );

    function say(message) {
      state.message = message;
      ui.message.textContent = message;
    }

    function target() {
      return state.context ? { sheet: state.context.sheet, address: state.context.address } : null;
    }

    function keyOf(context, text) {
      return context ? context.sheet + "!" + context.address + "\u0000" + text : "";
    }

    function render() {
      const c = state.context;
      ui.completions.textContent = "";
      ui.block.textContent = "";
      if (!c) {
        ui.context.textContent = "Select a cell.";
        return null;
      }
      const suggestion = core.suggest({ header: c.header, sheet: c.sheet, text: state.text, values: c.values }, state.config);
      const rule = suggestion.column
        ? (suggestion.column.vocabulary ? "vocabulary " + suggestion.column.vocabulary : suggestion.column.kind + " column")
        : suggestion.profile.kind + " column, " + suggestion.profile.total + " values";
      ui.context.textContent = c.address + " on " + c.sheet + (c.header ? ", column " + JSON.stringify(c.header) : ", no header in row 1") + ": " + rule + (c.clipped ? " (first rows only)" : "");
      for (const completion of suggestion.completions) {
        const button = make("button", { type: "button", class: "completion", text: completion.value });
        button.addEventListener("click", () => choose(completion));
        const from = (completion.alias ? "alias " + completion.alias + ", " : "") + (completion.source === "vocabulary" ? "vocabulary" : "seen " + completion.count + "x");
        ui.completions.append(make("li", {}, [button, make("span", { class: "source", text: from })]));
      }
      if (!suggestion.completions.length && !suggestion.block && state.text.trim()) ui.completions.append(make("li", { class: "none", text: "No completion." }));
      if (suggestion.block) {
        const button = make("button", { type: "button", class: "primary", text: "Insert " + suggestion.block.label + " (" + describeBlock(suggestion.block) + ")" });
        button.addEventListener("click", () => insertBlock(suggestion.block));
        ui.block.append(button);
      }
      return suggestion;
    }

    /** Read the selection; the input follows the cell only when the selection or its text changed. */
    async function refresh() {
      const read = ++state.reads;
      let context = null;
      try {
        context = await bridge.readContext();
      } catch (error) {
        if (read === state.reads) say("Cannot read the selection: " + reason(error));
        return;
      }
      // A later read already answered: this one describes a selection that is gone.
      if (read !== state.reads) return;
      const key = keyOf(context, context ? context.text : "");
      state.context = context;
      if (key !== state.lastKey) {
        state.lastKey = key;
        state.text = context ? String(context.text == null ? "" : context.text) : "";
        ui.input.value = state.text;
      }
      render();
    }

    /**
     * Write the completion as text: what was typed before the completed
     * sentence stays. A completion is never formula-like, but the typed start
     * of a notes cell can be (= + - @); whether the text format stops a host
     * from evaluating it is unconfirmed, so such a cell is left alone.
     */
    async function choose(completion) {
      const where = target();
      if (!where) return;
      const value = state.text.slice(0, completion.start) + completion.value;
      if (core.formulaLike(value)) {
        say("Not written to " + where.address + ": starting with " + JSON.stringify(value[0]) + ", the cell could read it as a formula. Change the first character, then choose again.");
        return;
      }
      try {
        await bridge.writeValue(where, value);
      } catch (error) {
        say("Could not write to " + where.address + ": " + reason(error));
        return;
      }
      state.text = value;
      ui.input.value = value;
      state.lastKey = keyOf(state.context, value);
      say("Wrote " + JSON.stringify(value) + " to " + where.address + ".");
      render();
    }

    async function insertBlock(block) {
      const where = target();
      if (!where) return;
      try {
        if (block.formula) await bridge.writeFormula(where, block.formula);
        else await bridge.writeRows(where, block.rows);
      } catch (error) {
        say("Could not insert " + block.label + " at " + where.address + ": " + reason(error));
        return;
      }
      state.text = "";
      ui.input.value = "";
      say("Inserted " + block.label + " at " + where.address + ".");
      render();
    }

    function applyConfig(text) {
      const parsed = core.parseConfig(text);
      state.config = parsed.config;
      state.warnings = parsed.warnings;
      ui.summary.textContent = summarize(parsed);
      render();
      return parsed;
    }

    /** Keep the pasted text with the document; the browser copy is the fallback when the document cannot keep it. */
    async function saveConfig() {
      const text = ui.configText.value;
      const parsed = applyConfig(text);
      let where = "with this document";
      try {
        await bridge.saveConfig(text);
      } catch (error) {
        where = "in this browser only (" + reason(error) + ")";
      }
      if (storage) {
        try {
          storage.setItem(STORAGE_KEY, text);
        } catch (error) {
          if (where !== "with this document") where = "nowhere: " + reason(error);
        }
      }
      say("Configuration saved " + where + (parsed.warnings.length ? "; " + parsed.warnings.length + " item(s) skipped, see below." : "."));
      return parsed;
    }

    async function start() {
      let text = "";
      try {
        text = String((await bridge.loadConfig()) || "");
      } catch (error) {
        say("Could not read the saved configuration: " + reason(error));
      }
      if (!text && storage) {
        try {
          text = storage.getItem(STORAGE_KEY) || "";
        } catch (error) {
          text = "";
        }
      }
      ui.configText.value = text;
      applyConfig(text);
      ui.input.addEventListener("input", () => {
        state.text = ui.input.value;
        render();
      });
      ui.save.addEventListener("click", () => saveConfig());
      ui.refresh.addEventListener("click", () => refresh());
      if (typeof bridge.onSelectionChanged === "function") bridge.onSelectionChanged(() => refresh());
      await refresh();
    }

    return { state, ui, start, refresh, render, choose, insertBlock, applyConfig, saveConfig };
  }

  root.ActleSheetsPane = { createPane, summarize, describeBlock, STORAGE_KEY };
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
