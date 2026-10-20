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
  function find(before, shorthands) {
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
        matching.push({ sh, order, remaining: parts.length - typed });
      });
      if (matching.length) {
        matching.sort((a, b) => a.remaining - b.remaining || a.order - b.order);
        return { start, query, items: matching.slice(0, MAX_RESULTS).map((item) => item.sh) };
      }
    }
    return null;
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
        --panel: #fff; --text: #172033; --muted: #526078;
        --line: #d7deea; --control: #7d8ba1; --accent: #2357d7;
        --soft: #eaf0ff; --pressed: #dce6ff;
      }
      .panel {
        width: 320px; max-width: calc(100vw - 16px); overflow: hidden;
        background: var(--panel); color: var(--text); border: 1px solid var(--control);
        border-radius: var(--radius-panel, 12px); box-shadow: var(--shadow, 0 10px 30px rgba(13,19,32,.18));
        font: 13px/1.45 var(--font, system-ui, -apple-system, "Segoe UI", sans-serif);
      }
      .heading {
        display: flex; align-items: center; gap: 7px; padding: 9px 12px;
        border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px;
      }
      .brand { color: var(--accent); font-weight: 750; font-size: 13px; }
      .count { margin-left: auto; }
      .list { max-height: min(240px, max(40px, calc(100vh - 100px))); overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--control) var(--panel); }
      .item { padding: 8px 12px; cursor: pointer; border-left: 3px solid transparent; }
      .item:hover { background: var(--soft); }
      .item[data-selected="true"] { background: var(--soft); border-left-color: var(--accent); }
      .item:active { background: var(--pressed); }
      .trigger { display: block; color: var(--accent); font: 600 13px/1.45 var(--mono, ui-monospace, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .typed { color: var(--text); font-weight: 400; }
      .expansion { display: block; margin-top: 2px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .hint { padding: 8px 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
      .hint kbd { font: inherit; }
      .status { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      @media (prefers-color-scheme: dark) {
        :host { --panel: #151d2c; --text: #eef2f7; --muted: #a7b4c8; --line: #344159; --control: #7f8da5; --accent: #a4bdff; --soft: #233354; --pressed: #30446c; }
      }
      @media (forced-colors: active) {
        .panel { border-color: ButtonText; }
        .item[data-selected="true"] { border-left-color: Highlight; outline: 1px solid Highlight; outline-offset: -1px; }
      }
    `);
    self.ActleThemes.adopt(shadow, sheet);
    shadow.innerHTML = `
      <div class="panel">
        <div class="heading"><span class="brand">actle</span><span>Suggestions</span><span class="count"></span></div>
        <div class="list" role="listbox" aria-label="Shorthand suggestions"></div>
        <div class="hint"><kbd>↓</kbd> choose · <kbd>Enter</kbd> insert · <kbd>Esc</kbd> dismiss</div>
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
      const typed = document.createElement("span");
      typed.className = "typed";
      typed.textContent = query;
      trigger.append(typed, document.createTextNode(sh.trigger.slice(query.length)));
      const expansion = document.createElement("span");
      expansion.className = "expansion";
      expansion.textContent = preview(sh);
      row.append(trigger, expansion);
      listEl.append(row);
    });
    const chosen = listEl.querySelector('[data-selected="true"]');
    if (chosen) chosen.scrollIntoView({ block: "nearest" });
    statusEl.textContent = selected < 0
      ? `${items.length} shorthand suggestion${items.length === 1 ? "" : "s"}. Press Down arrow to choose, then Enter to insert.`
      : `${items[selected].trigger}: ${preview(items[selected])}. Press Enter to insert.`;
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
    if (anchor !== opts.anchorEl || query !== opts.query || items.length !== next.length
        || next.some((sh, index) => sh !== items[index])) selected = -1;
    anchor = opts.anchorEl;
    query = opts.query;
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

  return { find, show, update: show, close, isOpen: () => open, isHost: (el) => !!host && el === host, handleKeyDown };
});
