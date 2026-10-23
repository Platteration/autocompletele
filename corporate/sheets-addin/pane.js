// extle add-in: the pane shared by the Excel task pane and the Google
// Sheets sidebar. It builds its own elements, reads cells and writes
// completions only through the host bridge it is given, and completes with
// the ActleSheets bundle. No framework, no inline handlers.
//
// The configuration that applies is the organisation's: the text the person
// pasted into Settings, kept in this browser. A configuration the document
// carries in its own settings travels with the file, so whoever saved the file
// chose it; it is only offered, with where it comes from and what it would
// change, and never copied into the browser.
//
// In a strict column (a vocabulary column rule with strict: true) the pane
// also checks the column against the list, replaces aliases with the list's
// spelling and turns the host's list validation on or off; each write waits
// for a confirmation.
//
// bridge: { readContext() -> Promise<{sheet, address, text, header, values, rows, clipped}|null>,
//           writeValue(target, text), writeRows(target, rows), writeFormula(target, formula),
//           replaceValues({sheet, column}, [{row, from, to}]) -> Promise<{written: [row], skipped: [{row, text}], computed: [row], failed?: {row, message}}>,
//           listValidation: null | { refusal?(values) -> reason|null, apply({sheet, column}, values, message) -> Promise<{range}>,
//                                    remove({sheet, column}) -> Promise<{range}> },
//           listValidationMissing: why there is no listValidation (shown as a hint),
//           loadConfig() -> Promise<string>, saveConfig(text), onSelectionChanged(handler) }
(function (root) {
  "use strict";

  const STORAGE_KEY = "actleSheetsConfig";
  const PREVIEW_ROWS = 5;    // rows of a block listed under its Insert button; the rest are counted
  const PREVIEW_CHARS = 200; // characters of one listed row
  const NAME_CHARS = 40;     // characters of a vocabulary name or trigger quoted in the offer
  const OFFER_ITEMS = 10;    // changes listed in the offer, formula blocks first; the rest are counted
  const CHECK_ITEMS = 10;    // cells listed under each heading of a column check; the rest are counted

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

  /** What a block of rows writes, one line per row: text quoted (a tab or a leading space shows), numbers and booleans as they are. */
  function previewRows(rows) {
    const lines = rows.slice(0, PREVIEW_ROWS).map((row) => {
      const line = row.map((cell) => (typeof cell === "string" ? JSON.stringify(cell) : String(cell))).join(" | ");
      return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS - 1) + "…" : line;
    });
    if (rows.length > PREVIEW_ROWS) lines.push("… and " + (rows.length - PREVIEW_ROWS) + " more rows");
    return lines;
  }

  /**
   * The first text cell of a block a host could read as a formula, 1-based.
   * The core drops such a block when it reads the configuration; this is
   * checked again before writing, so a core that let one through (an older
   * bundle served next to this pane) still writes nothing.
   */
  function formulaCell(core, rows) {
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        const cell = rows[r][c];
        if (typeof cell === "string" && core.formulaLike(cell)) return { row: r + 1, column: c + 1, first: cell[0] };
      }
    }
    return null;
  }

  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const usable = (config) => Object.keys(config.vocabularies).length > 0 || config.columns.length > 0 || config.blocks.length > 0;

  /**
   * A name or trigger from a configuration, quoted and cut short: in the
   * offer it is the document author's text, so it must not read as the
   * pane's own wording or push the rest out of view.
   */
  function quoted(text) {
    const value = String(text);
    return JSON.stringify(value.length > NAME_CHARS ? value.slice(0, NAME_CHARS - 1) + "…" : value);
  }

  function blockText(block) {
    return quoted(block.trigger) + " (" + describeBlock(block) + ")";
  }

  /**
   * Completions do not depend on the order of a vocabulary's values or
   * aliases (they are ranked, then sorted by spelling; alias order only picks
   * which alias is named beside a completion), so it does not count as a change.
   */
  function sameVocabulary(a, b) {
    const canonical = (vocabulary) => [vocabulary.values.slice().sort(), Object.entries(vocabulary.aliases || {}).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))];
    return same(canonical(a), canonical(b));
  }

  function sameBlock(a, b) {
    return a.trigger === b.trigger && a.formula === b.formula && same(a.rows, b.rows);
  }

  /**
   * What applying configuration `to` in place of `from` would change, one
   * phrase each, formula blocks first; empty when nothing would. Column rules
   * compare in order, since the first rule that matches applies.
   */
  function changes(from, to) {
    const formulas = [];
    const out = [];
    for (const name of Object.keys(to.vocabularies)) {
      const count = to.vocabularies[name].values.length + " values";
      if (!own(from.vocabularies, name)) out.push("add vocabulary " + quoted(name) + " (" + count + ")");
      else if (!sameVocabulary(from.vocabularies[name], to.vocabularies[name])) out.push("replace vocabulary " + quoted(name) + " (" + count + " instead of " + from.vocabularies[name].values.length + ")");
    }
    for (const name of Object.keys(from.vocabularies)) if (!own(to.vocabularies, name)) out.push("remove vocabulary " + quoted(name));
    if (!same(from.columns, to.columns)) out.push("replace the column rules (" + to.columns.length + " instead of " + from.columns.length + ")");
    const before = new Map(from.blocks.map((block) => [block.trigger, block]));
    const after = new Set(to.blocks.map((block) => block.trigger));
    for (const block of to.blocks) {
      const phrase = !before.has(block.trigger) ? "add block " : !sameBlock(before.get(block.trigger), block) ? "change block " : "";
      if (phrase) (block.formula ? formulas : out).push(phrase + blockText(block));
    }
    for (const block of from.blocks) if (!after.has(block.trigger)) out.push("remove block " + quoted(block.trigger));
    return formulas.concat(out);
  }

  /** "A4:CV103" for a block of `height` x `width` cells written from "A4"; null for an address this cannot read. */
  function rangeFrom(address, height, width) {
    const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/.exec(String(address));
    if (!match) return null;
    let column = 0;
    for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
    let name = "";
    for (let n = column + width - 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    const first = match[1].toUpperCase() + match[2];
    return height === 1 && width === 1 ? first : first + ":" + name + (Number(match[2]) + height - 1);
  }

  /** "B4" -> { letters: "B", row: 4 }; null for an address this cannot read. */
  function cellAt(address) {
    const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/.exec(String(address));
    return match ? { letters: match[1].toUpperCase(), row: Number(match[2]) } : null;
  }

  /** At most `max` lines, then "… and N more". */
  function capped(lines, max) {
    return lines.length > max ? lines.slice(0, max).concat("… and " + (lines.length - max) + " more") : lines;
  }

  function cells(n) {
    return n === 1 ? "1 cell" : n + " cells";
  }

  function reason(error) {
    return String((error && error.message) || error || "unknown error");
  }

  function summarize(parsed) {
    const config = parsed.config;
    const names = Object.keys(config.vocabularies);
    if (!names.length && !config.columns.length && !config.blocks.length && !parsed.warnings.length) {
      return "No configuration yet: export it from the actle desktop app (extle tab) and paste the file's contents above.";
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
    // organization: the parsed browser copy (or what was saved this session); documentText: what the document carries;
    // fromDocument: the document's configuration is in use; offer: the document's, not yet used; pending: a block from it awaiting confirmation.
    // strict: the strict column the cell is in; check: the last column check there; strictPending: a strict-column write awaiting confirmation.
    const state = { config: core.parseConfig("").config, warnings: [], context: null, text: "", lastKey: "", message: "", reads: 0, organization: core.parseConfig(""), organizationText: "", documentText: "", fromDocument: false, offer: null, pending: null, strict: null, check: null, strictPending: null };
    // The block buttons now shown, so focus can follow a button that a re-render (a selection event or the sidebar's poll) replaces.
    // strict: the strict column's buttons by name ("check", "replace", "validate", "unvalidate", "confirm", "cancel").
    const live = { insert: null, confirm: null, strict: new Map() };
    const ui = {
      context: make("p", { class: "context", text: "Select a cell." }),
      refresh: make("button", { class: "plain", type: "button", text: "Refresh" }),
      origin: make("div", { class: "origin" }),
      input: make("input", { type: "text", class: "text", placeholder: "Cell text, or a / trigger", "aria-label": "Cell text" }),
      completions: make("ul", { class: "completions" }),
      block: make("div", { class: "block" }),
      strict: make("div", { class: "strict" }),
      message: make("p", { class: "message", role: "status" }),
      configText: make("textarea", { class: "config", placeholder: "Paste the exported configuration (JSON) here", "aria-label": "Configuration" }),
      save: make("button", { class: "primary", type: "button", text: "Save configuration" }),
      summary: make("p", { class: "summary" }),
    };
    settings.root.append(
      make("div", { class: "toolbar" }, [ui.context, ui.refresh]),
      ui.origin,
      make("label", {}, ["Cell text", ui.input]),
      ui.completions,
      ui.block,
      ui.strict,
      ui.message,
      make("details", {}, [
        make("summary", { text: "Settings" }),
        make("p", { class: "hint", text: "The configuration is the sheets section of your organisation policy, exported by the actle desktop app. Saved, it is kept in this browser, where it applies to every document, and with this document. A configuration a document brings with it is offered, never used without asking." }),
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

    function focus(node) {
      if (node && typeof node.focus === "function") node.focus();
    }

    /** A confirmation that is dropped takes its "Nothing written yet" notice with it. */
    function drop(pending) {
      if (pending && state.message === pending.notice) say("");
    }

    /**
     * The question for a block from the document's configuration: where it
     * comes from, the cell or range it writes, and what it writes (the
     * formula on its own line, or the rows listed). Both buttons are
     * described by the question and what follows it.
     */
    function renderConfirmation(pending, refocus) {
      const block = pending.block;
      const address = pending.where.address;
      let question;
      let what;
      if (block.formula) {
        question = "This formula comes from this document's configuration, not your organisation's. Write it into " + address + "?";
        what = make("p", { class: "formula", id: "actle-confirm-what", text: block.formula });
      } else {
        const cells = block.rows.length * block.rows[0].length;
        const range = rangeFrom(address, block.rows.length, block.rows[0].length) || "the " + describeBlock(block) + " starting at " + address;
        question = "These rows come from this document's configuration, not your organisation's. Write them into " + range + ", replacing what " + (cells === 1 ? "that cell holds" : "those " + cells + " cells hold") + " now?";
        what = make("ul", { class: "preview", id: "actle-confirm-what", "aria-label": "Cells written from " + address }, previewRows(block.rows).map((line) => make("li", { text: line })));
      }
      const described = { type: "button", "aria-describedby": "actle-confirm-question actle-confirm-what" };
      const write = make("button", Object.assign({ class: "primary", text: block.formula ? "Write the formula" : "Write the rows" }, described));
      // A button from a confirmation that is gone (Stop using it, another cell) writes nothing.
      write.addEventListener("click", () => (state.pending === pending ? writeBlock(pending.block, pending.where) : null));
      const cancel = make("button", Object.assign({ class: "plain", text: "Cancel" }, described));
      cancel.addEventListener("click", () => {
        if (state.pending !== pending) return;
        state.pending = null;
        say("Nothing written to " + address + ".");
        render();
        focus(live.insert);
      });
      ui.block.append(make("p", { class: "confirm", id: "actle-confirm-question", text: question }), what, make("div", { class: "actions" }, [write, cancel]));
      live.confirm = { write, cancel };
      if (refocus) focus(live.confirm[refocus]);
    }

    function render() {
      const c = state.context;
      // A block awaiting confirmation stays only while the document's configuration is in use and the same cell shows the same block.
      const pending = state.pending;
      state.pending = null;
      // Read before the buttons are removed: a removed element takes the focus with it.
      const active = document.activeElement;
      const refocus = !active ? null : live.confirm && active === live.confirm.write ? "write" : live.confirm && active === live.confirm.cancel ? "cancel" : active === live.insert ? "insert" : null;
      const strictFocus = active ? [...live.strict].filter(([, button]) => button === active).map(([name]) => name)[0] || null : null;
      live.insert = null;
      live.confirm = null;
      ui.completions.textContent = "";
      ui.block.textContent = "";
      if (!c) {
        ui.context.textContent = "Select a cell.";
        drop(pending);
        renderStrict(null, null);
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
      const block = suggestion.block;
      if (block && pending && state.fromDocument && pending.where.sheet === c.sheet && pending.where.address === c.address && sameBlock(pending.block, block)) {
        state.pending = pending;
        renderConfirmation(pending, refocus === "write" || refocus === "cancel" ? refocus : null);
      } else {
        drop(pending);
        if (block) {
          const button = make("button", { type: "button", class: "primary", text: "Insert " + block.label + " (" + describeBlock(block) + ")" });
          button.addEventListener("click", () => insertBlock(block));
          ui.block.append(button);
          if (block.rows) ui.block.append(make("ul", { class: "preview", "aria-label": "Cells written from " + c.address }, previewRows(block.rows).map((line) => make("li", { text: line }))));
          live.insert = button;
          if (refocus === "insert") focus(button);
        }
      }
      renderStrict(strictColumn(suggestion), strictFocus);
      return suggestion;
    }

    /** The strict column rule that applies to the selected cell, with what the column tools need; null outside one. */
    function strictColumn(suggestion) {
      const c = state.context;
      const column = suggestion.column;
      if (!column || !column.strict) return null;
      const at = cellAt(c.address);
      return { name: column.vocabulary, vocabulary: state.config.vocabularies[column.vocabulary], sheet: c.sheet, at, key: at ? c.sheet + "\u0000" + at.letters + "\u0000" + column.vocabulary : "" };
    }

    function dropStrictPending() {
      const pending = state.strictPending;
      state.strictPending = null;
      if (pending && state.message === pending.notice) say("");
    }

    /** "This list comes from this document's configuration ..." while the document's configuration is in use. */
    function listOrigin() {
      return state.fromDocument ? "This list comes from this document's configuration, not your organisation's. " : "";
    }

    /**
     * The strict column's line and tools: "Check this column" with what the
     * last check found, the replacement of aliases, and list validation on
     * and off. A check or a question belongs to one column of one sheet; it is
     * dropped when the cell moves to another column or the column stops
     * being strict.
     */
    function renderStrict(strict, refocus) {
      live.strict = new Map();
      ui.strict.textContent = "";
      state.strict = strict;
      if (state.check && (!strict || state.check.key !== strict.key)) state.check = null;
      if (state.strictPending && (!strict || state.strictPending.key !== strict.key)) dropStrictPending();
      if (!strict) return;
      ui.strict.append(make("p", { class: "strict-rule", text: "Only values from the " + quoted(strict.name) + " list." }));
      // An address the pane cannot read names no column, so there is nothing to check or validate.
      if (!strict.at) return;
      const button = (name, cls, text, handler) => {
        const node = make("button", { type: "button", class: cls, text });
        node.addEventListener("click", handler);
        live.strict.set(name, node);
        return node;
      };
      const pending = state.strictPending;
      if (!pending) ui.strict.append(make("div", { class: "actions" }, [button("check", "plain", "Check this column", () => checkThisColumn(strict.key))]));
      const check = state.check;
      if (check) {
        const result = check.result;
        ui.strict.append(make("p", { class: "check-summary", text: checkSummary(check) }));
        if (result.fixes.length) {
          ui.strict.append(
            make("p", { text: "Aliases and other spellings, with the list's spelling:" }),
            make("ul", { class: "preview", id: "actle-strict-fixes", "aria-label": "Cells that can take the list's spelling" }, capped(result.fixes.map((fix) => check.letters + fix.row + ": " + quoted(fix.text) + " → " + quoted(fix.value)), CHECK_ITEMS).map((line) => make("li", { text: line }))),
          );
        }
        if (result.unknown.length) {
          ui.strict.append(
            make("p", { text: "Not in the list, left as they are:" }),
            make("ul", { class: "preview", "aria-label": "Cells not in the list" }, capped(result.unknown.map((cell) => check.letters + cell.row + ": " + quoted(cell.text)), CHECK_ITEMS).map((line) => make("li", { text: line }))),
          );
        }
        if (result.fixes.length && !pending) ui.strict.append(make("div", { class: "actions" }, [button("replace", "primary", replaceLabel(result.fixes), () => askReplace(check))]));
      }
      if (pending) {
        const described = { type: "button", "aria-describedby": "actle-strict-question" + (pending.kind === "replace" ? " actle-strict-fixes" : "") };
        const yes = make("button", Object.assign({ class: "primary", text: pending.confirmText }, described));
        yes.addEventListener("click", () => confirmStrict(pending));
        const no = make("button", Object.assign({ class: "plain", text: "Cancel" }, described));
        no.addEventListener("click", () => cancelStrict(pending));
        live.strict.set("confirm", yes);
        live.strict.set("cancel", no);
        ui.strict.append(make("p", { class: "confirm", id: "actle-strict-question", text: pending.question }), make("div", { class: "actions" }, [yes, no]));
      } else if (bridge.listValidation) {
        const validation = bridge.listValidation;
        const refused = typeof validation.refusal === "function" ? validation.refusal(strict.vocabulary.values) : null;
        if (refused) ui.strict.append(make("p", { class: "hint", text: "List validation is not available for this list: " + refused + "." }));
        const tools = refused ? [] : [button("validate", "plain", "Turn on list validation for this column", () => askValidation(strict.key))];
        tools.push(button("unvalidate", "plain", "Remove list validation", () => askRemoval(strict.key)));
        ui.strict.append(make("div", { class: "actions" }, tools));
      } else if (bridge.listValidationMissing) {
        ui.strict.append(make("p", { class: "hint", text: String(bridge.listValidationMissing) }));
      }
      if (refocus && live.strict.has(refocus)) focus(live.strict.get(refocus));
    }

    /** "Replace 2 aliases with the list's spelling" when every fix is an alias; a value in other capitals or spacing is no alias, so then "Replace 2 cells ...". */
    function replaceLabel(fixes) {
      const n = fixes.length;
      const what = fixes.every((fix) => fix.alias) ? (n === 1 ? "1 alias" : n + " aliases") : cells(n);
      return "Replace " + what + " with the list's spelling";
    }

    function checkSummary(check) {
      const result = check.result;
      return "Column " + check.letters + ": " + cells(result.checked) + " with text checked" + (check.clipped ? " (first rows only)" : "")
        + "; " + result.canonical + " match the list, " + result.fixes.length + " can take the list's spelling, " + result.unknown.length + " are not in the list.";
    }

    /**
     * Compare the column's values the pane read (header excluded; the
     * selected cell included) with the strict column's list. Nothing is
     * written; the result is listed until the cell moves to another column.
     */
    function checkThisColumn(key) {
      const strict = state.strict;
      // A button left from another column checks nothing.
      if (!strict || strict.key !== key) return;
      const c = state.context;
      // Row numbers come with the values from this add-in's own bridges; a Code.gs older than this pane sends none.
      if (!Array.isArray(c.rows) || c.rows.length !== c.values.length) {
        say("Cannot check column " + strict.at.letters + ": the spreadsheet side of the add-in sent no row numbers. Update its files.");
        return;
      }
      const list = c.values.map((text, i) => ({ row: c.rows[i], text }));
      if (strict.at.row >= 2) list.push({ row: strict.at.row, text: c.text });
      list.sort((a, b) => a.row - b.row);
      state.check = { key, letters: strict.at.letters, sheet: strict.sheet, clipped: !!c.clipped, result: core.checkColumn(list, strict.vocabulary) };
      say(checkSummary(state.check));
      render();
    }

    /** Open a strict-column question: the status line says nothing was written yet, and the focus goes to Cancel. */
    function ask(pending) {
      state.strictPending = pending;
      say(pending.notice);
      render();
      focus(live.strict.get("cancel"));
    }

    function askReplace(check) {
      // A button from a check that is gone (another column, another configuration) asks nothing.
      if (state.check !== check) return;
      const n = check.result.fixes.length;
      ask({
        kind: "replace", key: check.key, from: "replace", sheet: check.sheet, letters: check.letters, fixes: check.result.fixes,
        notice: "Nothing written yet: confirm the list's spelling for " + cells(n) + " in column " + check.letters + ", or cancel.",
        question: listOrigin() + "Write the list's spelling into " + cells(n) + " of column " + check.letters + " on " + quoted(check.sheet) + ", as listed above? Each cell is read again first; one that changed since the check, or whose value comes from a formula, is left as it is.",
        confirmText: "Replace " + cells(n),
      });
    }

    function askValidation(key) {
      const strict = state.strict;
      if (!strict || strict.key !== key) return;
      const values = strict.vocabulary.values.slice();
      ask({
        kind: "validate", key, from: "validate", sheet: strict.sheet, letters: strict.at.letters, name: strict.name, values,
        notice: "Nothing written yet: confirm list validation for column " + strict.at.letters + ", or cancel.",
        question: listOrigin() + "Turn on list validation for column " + strict.at.letters + " on " + quoted(strict.sheet) + ", from row 2 down? A value typed into those cells that is not one of the " + values.length + " values of the " + quoted(strict.name) + " list is then refused. Values already in the column stay as they are, and a pasted value may not be checked. Data validation those cells have now is replaced.",
        confirmText: "Turn it on",
      });
    }

    function askRemoval(key) {
      const strict = state.strict;
      if (!strict || strict.key !== key) return;
      ask({
        kind: "unvalidate", key, from: "unvalidate", sheet: strict.sheet, letters: strict.at.letters,
        notice: "Nothing changed yet: confirm removing the data validation from column " + strict.at.letters + ", or cancel.",
        question: "Remove the data validation from column " + strict.at.letters + " on " + quoted(strict.sheet) + ", from row 2 down? This clears any data validation those cells have, not only a list turned on here.",
        confirmText: "Remove it",
      });
    }

    function cancelStrict(pending) {
      if (state.strictPending !== pending) return;
      state.strictPending = null;
      say("Nothing changed in column " + pending.letters + ".");
      render();
      focus(live.strict.get(pending.from));
    }

    /** What a replacement did: the cells written, where a write stopped, the cells left because a formula gives their value, and those that changed since the check. */
    function replaced(pending, result) {
      const at = (row) => pending.letters + row;
      const skipped = result.skipped || [];
      const computed = result.computed || [];
      const failed = result.failed || null;
      let text = "Wrote the list's spelling into " + cells(result.written.length) + " of column " + pending.letters;
      text += failed ? ", then stopped" + (failed.row == null ? "" : " at " + at(failed.row)) + " (" + String(failed.message) + "); nothing after it was written." : ".";
      if (computed.length) text += " Left " + cells(computed.length) + " whose value comes from a formula: " + capped(computed.map(at), CHECK_ITEMS).join(", ") + ".";
      if (skipped.length) text += " Skipped " + cells(skipped.length) + " that changed since the check: " + capped(skipped.map((cell) => at(cell.row) + " (now " + quoted(cell.text) + ")"), CHECK_ITEMS).join(", ") + ".";
      return text;
    }

    /** The confirmed write. A button from a question that is gone writes nothing. */
    async function confirmStrict(pending) {
      if (state.strictPending !== pending) return;
      state.strictPending = null;
      const target = { sheet: pending.sheet, column: pending.letters };
      try {
        if (pending.kind === "replace") {
          const result = await bridge.replaceValues(target, pending.fixes.map((fix) => ({ row: fix.row, from: fix.text, to: fix.value })));
          state.check = null;
          say(replaced(pending, result));
        } else if (pending.kind === "validate") {
          const result = await bridge.listValidation.apply(target, pending.values, "Only values from the " + quoted(pending.name) + " list.");
          say("List validation is on for " + result.range + " on " + quoted(pending.sheet) + ": a value typed there that is not in the " + quoted(pending.name) + " list is refused. Values already there are not checked; Check this column lists them.");
        } else {
          const result = await bridge.listValidation.remove(target);
          say("Removed the data validation from " + result.range + " on " + quoted(pending.sheet) + ".");
        }
      } catch (error) {
        const what = pending.kind === "replace" ? "write the list's spelling into" : pending.kind === "validate" ? "turn on list validation for" : "remove the data validation from";
        // A bridge that throws cannot say how far it got (an Excel error without trace messages, a script stopped by Google).
        say("Could not " + what + " column " + pending.letters + ": " + reason(error) + (pending.kind === "replace" ? ". Cells written before the error, if any, keep the list's spelling." : ""));
      }
      // The cells changed under the pane: read the selection again so the column's values are current.
      if (pending.kind === "replace") await refresh();
      else render();
      focus(live.strict.get(pending.from) || live.strict.get("check"));
    }

    /** Where the configuration in use came from, or the document's own configuration on offer. */
    function renderOrigin() {
      ui.origin.textContent = "";
      if (state.fromDocument) {
        const stop = make("button", { type: "button", class: "plain", text: "Stop using it" });
        stop.addEventListener("click", () => useOrganization());
        ui.origin.append(
          make("p", { text: "In use: this document's own configuration, not your organisation's. A formula or rows from it are shown for confirmation before they are written." }),
          make("div", { class: "actions" }, [stop]),
        );
      } else if (state.offer) {
        // A browser copy with nothing usable in it ("{}", or only skipped items) is no organisation configuration to keep.
        const hasOrganization = usable(state.organization.config);
        const list = state.offer.changes;
        const listed = list.slice(0, OFFER_ITEMS);
        if (list.length > OFFER_ITEMS) listed.push("… and " + (list.length - OFFER_ITEMS) + " more changes");
        const use = make("button", { type: "button", class: "plain", text: "Use the document's configuration" });
        use.addEventListener("click", () => useDocument());
        const keep = make("button", { type: "button", class: "primary", text: hasOrganization ? "Keep the organisation's" : "Not now" });
        keep.addEventListener("click", () => {
          state.offer = null;
          renderOrigin();
        });
        ui.origin.append(
          make("p", { text: "This document carries its own extle configuration in its settings. It travels with the file, so whoever saved the file chose it; it is not your organisation's configuration" + (hasOrganization ? ", which stays in use." : ". This browser has none yet: paste the file the actle desktop app exports under Settings.") }),
          make("p", { text: "Using the document's would " + listed.join("; ") + "." }),
          make("div", { class: "actions" }, [use, keep]),
        );
      }
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

    /**
     * Rows are checked for a formula-like text cell first. A formula or rows
     * from the document's own configuration wait for "Write the formula" or
     * "Write the rows": the question names the cell or range and what is
     * written, the status line says nothing was written yet, and the focus
     * goes to Cancel, so a second Enter cannot confirm.
     */
    async function insertBlock(block) {
      const where = target();
      if (!where) return;
      const cell = Array.isArray(block.rows) ? formulaCell(core, block.rows) : null;
      if (cell) {
        say("Not inserted at " + where.address + ": row " + cell.row + ", column " + cell.column + " of " + block.label + " starts with " + JSON.stringify(cell.first) + ", the cell could read it as a formula.");
        return;
      }
      if (state.fromDocument) {
        const notice = "Nothing written yet: confirm the " + (block.formula ? "formula" : "rows") + " from this document's configuration for " + where.address + ", or cancel.";
        state.pending = { block, where, notice };
        say(notice);
        render();
        focus(live.confirm && live.confirm.cancel);
        return;
      }
      await writeBlock(block, where);
    }

    async function writeBlock(block, where) {
      state.pending = null;
      try {
        if (block.formula) await bridge.writeFormula(where, block.formula);
        else await bridge.writeRows(where, block.rows);
      } catch (error) {
        say("Could not insert " + block.label + " at " + where.address + ": " + reason(error));
        render();
        return;
      }
      state.text = "";
      ui.input.value = "";
      say("Inserted " + block.label + " at " + where.address + ".");
      render();
    }

    function show(parsed, fromDocument) {
      state.config = parsed.config;
      state.warnings = parsed.warnings;
      state.fromDocument = fromDocument;
      // A check or a question was made against the configuration that was in use; another one starts afresh.
      state.check = null;
      dropStrictPending();
      ui.summary.textContent = (fromDocument ? "This document's configuration, in use instead of the text above: " : "") + summarize(parsed);
      renderOrigin();
      render();
      return parsed;
    }

    function applyConfig(text) {
      return show(core.parseConfig(text), false);
    }

    /** Offer the document's configuration when it has something and differs from the organisation's; never apply it here. */
    function offerDocument() {
      const parsed = core.parseConfig(state.documentText);
      const changed = usable(parsed.config) ? changes(state.organization.config, parsed.config) : [];
      state.offer = changed.length ? { parsed, changes: changed } : null;
      renderOrigin();
    }

    /** For this session only: the browser's copy is left as it is. */
    function useDocument() {
      const offer = state.offer;
      if (!offer) return;
      state.offer = null;
      show(offer.parsed, true);
      say("Using this document's configuration for now; your organisation's copy in this browser is unchanged.");
    }

    function useOrganization() {
      show(state.organization, false);
      offerDocument();
      say("Back to your organisation's configuration.");
    }

    /**
     * Keep the text in the box (what the person pasted, or the organisation's
     * copy the pane put there; never the document's) in this browser, where it
     * applies to every document, and with this document. The box never shows
     * the document's own configuration, so an empty box leaves it as it is
     * rather than erase it unseen, and a save that replaces a different one
     * says so.
     */
    async function saveConfig() {
      const text = ui.configText.value;
      const parsed = core.parseConfig(text);
      const carried = state.documentText;
      const keepDocument = !text.trim() && !!carried.trim();
      const replacing = !keepDocument && !!carried.trim() && changes(parsed.config, core.parseConfig(carried).config).length > 0;
      state.organization = parsed;
      state.organizationText = text;
      state.offer = null;
      show(parsed, false);
      let documentFailure = null;
      if (!keepDocument) {
        try {
          await bridge.saveConfig(text);
          state.documentText = text;
        } catch (error) {
          documentFailure = reason(error);
        }
      }
      let browserFailure = null; // null: kept in this browser
      if (storage) {
        try {
          storage.setItem(STORAGE_KEY, text);
        } catch (error) {
          browserFailure = reason(error);
        }
      }
      const inBrowser = !!storage && !browserFailure;
      let where;
      if (keepDocument) {
        where = inBrowser ? "in this browser only" : storage ? "nowhere: " + browserFailure : "nowhere (this browser cannot keep a copy)";
        where += "; the box is empty, so this document's own configuration was left as it is";
      } else if (documentFailure) {
        where = inBrowser ? "in this browser only (" + documentFailure + ")" : storage ? "nowhere: " + browserFailure : "nowhere: " + documentFailure + " (this browser cannot keep a copy)";
      } else {
        where = inBrowser ? "with this document" : storage ? "with this document only (this browser could not keep it: " + browserFailure + ")" : "with this document only (this browser cannot keep a copy)";
        if (replacing) where += ", in place of the different configuration it carried";
      }
      say("Configuration saved " + where + (parsed.warnings.length ? "; " + parsed.warnings.length + " item(s) skipped, see below." : "."));
      // A document whose own, different configuration is still there (an empty box, a save it refused) offers it again.
      offerDocument();
      return parsed;
    }

    async function start() {
      try {
        state.documentText = String((await bridge.loadConfig()) || "");
      } catch (error) {
        say("Could not read the saved configuration: " + reason(error));
      }
      let text = "";
      if (storage) {
        try {
          text = storage.getItem(STORAGE_KEY) || "";
        } catch (error) {
          text = "";
        }
      }
      // The box holds the organisation's copy only, so Save can never copy the document's text into the browser.
      ui.configText.value = text;
      state.organizationText = text;
      state.organization = applyConfig(text);
      offerDocument();
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

  root.ActleSheetsPane = { createPane, summarize, describeBlock, previewRows, changes, rangeFrom, STORAGE_KEY };
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
