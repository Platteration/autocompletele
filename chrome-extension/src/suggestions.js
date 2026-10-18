// Local suggestions from the saved library. The page keeps focus and ordinary
// typing stays in its own editor; only an explicit choice inserts a snippet.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./expander.js"));
  } else {
    root.ShorthandSuggestions = factory(root.ShorthandExpander);
  }
})(typeof self !== "undefined" ? self : this, function (expander) {
  "use strict";

  const MAX_RESULTS = 5;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  /** Return partial trigger matches sharing one UTF-16 replacement start. */
  function find(before, shorthands, usageCounts) {
    if (typeof before !== "string" || before.length < 2 || !Array.isArray(shorthands)) return null;
    const saved = shorthands.filter((sh) => sh && typeof sh.trigger === "string" && sh.trigger.length > 2);
    let longest = 0;
    for (const sh of saved) longest = Math.max(longest, sh.trigger.length);
    // An earlier start is a longer prefix. Pick one extent so every displayed
    // choice replaces precisely the same text, including multi-word triggers.
    for (let start = Math.max(0, before.length - longest + 1); start <= before.length - 2; start++) {
      if (!expander.isBoundary(before[start - 1])) continue;
      const query = before.slice(start);
      const matching = [];
      saved.forEach((sh, order) => {
        if (sh.trigger.length <= query.length || !sh.trigger.startsWith(query)) return;
        const parts = Array.from(segmenter.segment(sh.trigger));
        const typed = parts.findIndex((part) => part.index === query.length);
        // A query cannot finish halfway through a joined emoji or a combining
        // sequence, nor can one large emoji count as two typed characters.
        if (typed < 2) return;
        const uses = usageCounts && usageCounts[sh.id];
        matching.push({ sh, order, remaining: parts.length - typed, uses: Number.isFinite(uses) && uses > 0 ? uses : 0 });
      });
      if (matching.length) {
        // Most-used first; without counts every use is 0 and the previous
        // shortest-completion, then library-order, ranking is preserved.
        matching.sort((a, b) => b.uses - a.uses || a.remaining - b.remaining || a.order - b.order);
        return { start, query, items: matching.slice(0, MAX_RESULTS).map((item) => item.sh) };
      }
    }
    return null;
  }

  // Finishing a saved paragraph: the words before the caret match the fixed
  // opening of a snippet (the text before its first [[blank]] or {variable}),
  // ignoring case and runs of whitespace. Short snippets are left to triggers.
  const PHRASE_MIN_WORDS = 6;
  const PHRASE_SCAN = 400;
  const squash = (text) => text.replace(/\s+/g, " ").toLowerCase();
  const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

  function findPhrase(before, shorthands, minWords, usageCounts) {
    if (typeof before !== "string" || !Number.isInteger(minWords) || minWords < 1 || !Array.isArray(shorthands)) return null;
    const saved = [];
    shorthands.forEach((sh, order) => {
      if (!sh || typeof sh.trigger !== "string" || typeof sh.expansion !== "string") return;
      if (wordCount(sh.expansion) < PHRASE_MIN_WORDS) return;
      const cut = sh.expansion.search(/\[\[|\{/);
      const opening = squash(cut < 0 ? sh.expansion : sh.expansion.slice(0, cut));
      saved.push({ sh, order, opening, whole: squash(sh.expansion).trimEnd() });
    });
    if (!saved.length) return null;
    // The earliest word start that still matches covers the most typed words.
    for (let start = Math.max(0, before.length - PHRASE_SCAN); start < before.length; start++) {
      if (/\s/.test(before[start]) || !expander.isBoundary(before[start - 1])) continue;
      const query = before.slice(start);
      if (wordCount(query) < minWords) break;
      const typed = squash(query);
      const matching = saved.filter((entry) => entry.opening.startsWith(typed) && typed.trimEnd() !== entry.whole);
      if (!matching.length) continue;
      const uses = (entry) => { const count = usageCounts && usageCounts[entry.sh.id]; return Number.isFinite(count) && count > 0 ? count : 0; };
      matching.sort((a, b) => uses(b) - uses(a) || a.order - b.order);
      return { start, query, items: matching.slice(0, MAX_RESULTS).map((entry) => entry.sh), phrase: true };
    }
    return null;
  }

  /** A finished paragraph keeps the case of the first letter the person typed. */
  function keepTypedCase(typed, expansion) {
    const [first] = String(typed);
    const [saved] = String(expansion);
    if (!first || !saved || first === saved || first.toLowerCase() !== saved.toLowerCase()) return expansion;
    return first + expansion.slice(saved.length);
  }

  const HOST_ID = "actle-suggestions-host";
  let host = null;
  let listEl = null;
  let countEl = null;
  let statusEl = null;
  let open = false;
  let anchor = null;
  let query = "";
  let items = [];
  let selected = -1;
  let onPick = null;
  let onDismiss = null;
  let phrase = false;

  function anchorFocused() {
    const tree = anchor && anchor.getRootNode ? anchor.getRootNode() : document;
    const active = tree.activeElement;
    return !!anchor && (active === anchor || (anchor.isContentEditable && anchor.contains(active)));
  }

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "closed" });
    // Like the manual picker, constructed sheets also work on Firefox pages
    // whose CSP rejects inline style elements created by content scripts.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
      :host { all: initial; }
      :host {
        position: fixed; z-index: 2147483647; color-scheme: light dark;
        --bg: #fff; --surface: #f5f6f8; --sunken: #eceef1; --ink: #1b1f24; --muted: #59636e;
        --line: #d3d8de; --control: #7a838e; --accent: #1a5fd0; --button: #1a5fd0;
        --frame: #1b1f24; --shadow: 0 4px 16px rgb(0 0 0 / 12%);
      }
      .panel {
        width: 320px; max-width: calc(100vw - 16px); overflow: hidden;
        background: var(--bg); color: var(--ink); border: 1px solid var(--frame);
        border-radius: 0; box-shadow: var(--shadow);
        font: 13px/20px system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .heading {
        display: flex; align-items: baseline; gap: 8px; padding: 8px 12px;
        border-bottom: 1px solid var(--line); color: var(--muted);
        font: 650 11px/16px system-ui, -apple-system, "Segoe UI", sans-serif;
        letter-spacing: .08em; text-transform: uppercase;
      }
      .brand { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .count { margin-left: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0; }
      .list { max-height: min(240px, max(40px, calc(100vh - 100px))); overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--control) var(--bg); }
      .item { padding: 8px 12px; cursor: pointer; }
      .item + .item { border-top: 1px solid var(--line); }
      .item:hover { background: var(--surface); }
      .item:active { background: var(--sunken); }
      .item[data-selected="true"] { background: var(--button); color: #fff; }
      .trigger { display: block; color: var(--accent); font: 650 13px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .typed { color: var(--ink); font-weight: 400; }
      .expansion { display: block; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .item[data-selected="true"] .trigger, .item[data-selected="true"] .typed, .item[data-selected="true"] .expansion { color: #fff; }
      .hint { padding: 8px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; line-height: 16px; }
      .status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      @media (prefers-color-scheme: dark) {
        :host { --bg: #0f1115; --surface: #16191e; --sunken: #1c2026; --ink: #e7eaee; --muted: #a2aab4; --line: #2e343c; --control: #7d8691; --accent: #7aa7ff; --button: #2f6be0; --frame: #7d8691; --shadow: none; }
      }
      @media (forced-colors: active) {
        .panel { border-color: ButtonText; }
        /* The bar the selected row has always shown in this mode. */
        .item { border-left: 3px solid transparent; }
        .item[data-selected="true"] { border-left-color: Highlight; outline: 1px solid Highlight; outline-offset: -1px; }
      }
    `);
    shadow.adoptedStyleSheets = [sheet];
    shadow.innerHTML = `
      <div class="panel">
        <div class="heading"><span class="brand">actle</span><span>Suggestions</span><span class="count"></span></div>
        <div class="list" role="listbox" aria-label="Shorthand suggestions"></div>
        <div class="hint">↓ choose · Enter insert · Esc dismiss</div>
        <div class="status" role="status" aria-live="polite" aria-atomic="true"></div>
      </div>`;
    listEl = shadow.querySelector(".list");
    countEl = shadow.querySelector(".count");
    statusEl = shadow.querySelector(".status");
    listEl.addEventListener("mousedown", (ev) => {
      if (!ev.isTrusted || ev.button !== 0 || !anchorFocused()) return;
      // Leave the selection in the page so a later click can insert exactly
      // where the user typed. A trusted assistive-technology click works too.
      ev.preventDefault();
    });
    listEl.addEventListener("click", (ev) => {
      if (!ev.isTrusted || ev.button !== 0 || !anchorFocused()) return;
      const item = ev.target.closest(".item");
      if (!item) return;
      selected = Number(item.dataset.index);
      pick();
    });
  }

  function position() {
    const rect = anchor.getBoundingClientRect();
    const panel = host.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - panel.width - 8));
    let top = rect.bottom + 6;
    if (top + panel.height > window.innerHeight - 8) top = rect.top - panel.height - 6;
    top = Math.max(8, Math.min(top, window.innerHeight - panel.height - 8));
    host.style.left = left + "px";
    host.style.top = top + "px";
  }

  function preview(item) {
    return String(item.expansion || "").replace(/\s+/g, " ").slice(0, 120);
  }

  function render() {
    countEl.textContent = String(items.length);
    listEl.textContent = "";
    items.forEach((sh, index) => {
      const row = document.createElement("div");
      row.className = "item";
      row.setAttribute("role", "option");
      row.dataset.index = String(index);
      row.dataset.selected = String(index === selected);
      row.setAttribute("aria-selected", String(index === selected));
      const trigger = document.createElement("span");
      trigger.className = "trigger";
      if (phrase) {
        trigger.textContent = sh.trigger;
      } else {
        const typed = document.createElement("span");
        typed.className = "typed";
        typed.textContent = query;
        trigger.append(typed, document.createTextNode(sh.trigger.slice(query.length)));
      }
      const expansion = document.createElement("span");
      expansion.className = "expansion";
      expansion.textContent = preview(sh);
      row.append(trigger, expansion);
      listEl.append(row);
    });
    const chosen = listEl.querySelector('[data-selected="true"]');
    if (chosen) chosen.scrollIntoView({ block: "nearest" });
    statusEl.textContent = selected < 0
      ? (phrase ? `${items.length} saved paragraph${items.length === 1 ? "" : "s"} to finish. Press Down arrow to choose, then Enter to finish it.`
        : `${items.length} shorthand suggestion${items.length === 1 ? "" : "s"}. Press Down arrow to choose, then Enter to insert.`)
      : `${items[selected].trigger}: ${preview(items[selected])}. Press Enter to ${phrase ? "finish it" : "insert"}.`;
    position();
  }

  function close() {
    open = false;
    if (host && host.parentNode) host.remove();
    anchor = null;
    query = "";
    items = [];
    selected = -1;
    onPick = null;
    onDismiss = null;
    phrase = false;
  }

  function dismiss() {
    const cb = onDismiss;
    close();
    if (cb) cb();
  }

  function pick() {
    const chosen = items[selected];
    const cb = onPick;
    close();
    if (chosen && cb) cb(chosen);
  }

  /** Update without taking focus or registering page-wide event handlers. */
  function show(opts) {
    if (!opts || !Array.isArray(opts.items) || !opts.items.length || !opts.anchorEl) {
      close();
      return false;
    }
    build();
    const next = opts.items.slice(0, MAX_RESULTS);
    if (anchor !== opts.anchorEl || query !== opts.query || phrase !== !!opts.phrase || items.length !== next.length
        || next.some((sh, index) => sh !== items[index])) selected = -1;
    anchor = opts.anchorEl;
    query = opts.query;
    phrase = !!opts.phrase;
    items = next;
    onPick = opts.onPick;
    onDismiss = opts.onDismiss;
    if (!open) (document.body || document.documentElement).append(host);
    open = true;
    render();
    return true;
  }

  function handleKeyDown(ev) {
    if (!open || !ev.isTrusted) return false;
    if (!anchorFocused() || !host.isConnected) { close(); return false; }
    // A modifier pressed on its own changes no text, so the list stays. A chord
    // closes it without hiding the rest of the word: only Escape does that, and
    // the next typed character offers the longer prefix again.
    if (["Shift", "Control", "Alt", "Meta"].includes(ev.key)) return false;
    if (ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) {
      close();
      return false;
    }
    const stop = () => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    };
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      stop();
      selected = ev.key === "ArrowDown" ? (selected + 1) % items.length
        : (selected < 0 ? items.length - 1 : (selected - 1 + items.length) % items.length);
      render();
      return true;
    }
    if (ev.key === "Enter" && selected >= 0) {
      stop();
      pick();
      return true;
    }
    if (ev.key === "Escape") {
      stop();
      dismiss();
      return true;
    }
    if (["Enter", "Tab", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(ev.key)) dismiss();
    return false;
  }

  return { find, findPhrase, keepTypedCase, show, update: show, close, isOpen: () => open, isHost: (el) => !!host && el === host, handleKeyDown };
});
