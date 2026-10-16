// A search overlay listing every shorthand, opened by typing the picker
// trigger (";;" by default) in any editable field.
//
// Focus deliberately stays in the page's own field: the overlay never calls
// focus(), and instead intercepts keys at the document level. Sites that close
// menus or save drafts on blur (Gmail, Slack) therefore see nothing unusual.
(function (root) {
  "use strict";

  const HOST_ID = "shorthand-picker-host";
  const MAX_RESULTS = 50;

  let host = null; // the <div> holding the shadow root
  let shadow = null;
  let listEl = null;
  let queryEl = null;
  let emptyEl = null;

  let open = false;
  let query = "";
  let results = [];
  let selected = 0;
  let onPick = null;
  let onClose = null;
  let anchor = null; // the field the panel is placed against

  /**
   * Score a shorthand against a query, or return -1 when it does not match.
   * A contiguous match in the trigger beats a contiguous match in the
   * expansion, which in turn beats a scattered subsequence match.
   */
  function score(shorthand, q) {
    if (!q) return 0;
    const needle = q.toLowerCase();
    const trigger = shorthand.trigger.toLowerCase();
    const expansion = shorthand.expansion.toLowerCase();

    if (trigger.startsWith(needle)) return 1000 - trigger.length;
    const inTrigger = trigger.indexOf(needle);
    if (inTrigger >= 0) return 800 - inTrigger;
    const inExpansion = expansion.indexOf(needle);
    if (inExpansion >= 0) return 600 - Math.min(inExpansion, 200);

    // Scattered subsequence, e.g. "brb" matching "be right back".
    let i = 0;
    for (const ch of expansion) {
      if (ch === needle[i]) i++;
      if (i === needle.length) return 200;
    }
    i = 0;
    for (const ch of trigger) {
      if (ch === needle[i]) i++;
      if (i === needle.length) return 400;
    }
    return -1;
  }

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    // The page's own styles must not reach inside, and ours must not leak out.
    shadow = host.attachShadow({ mode: "closed" });
    // Constructed stylesheets keep the overlay styled on Firefox pages whose
    // CSP rejects inline <style> elements inserted by content scripts.
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(`
        /* Reset first so nothing inherits from the page, then position. The
           host itself is the positioned box, which keeps it measurable from
           outside the closed shadow root. */
        :host { all: initial; }
        :host {
          position: fixed; z-index: 2147483647; color-scheme: light dark;
          --panel: #fff; --text: #172033; --muted: #526078;
          --line: #d7deea; --control: #7d8ba1; --accent: #2357d7;
          --soft: #eaf0ff; --pressed: #dce6ff;
        }
        .panel {
          width: 340px; max-width: 90vw;
          background: var(--panel); color: var(--text); border: 1px solid var(--control);
          border-radius: 12px; box-shadow: 0 12px 32px rgba(13,19,32,.2);
          font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
          overflow: hidden;
        }
        @media (prefers-color-scheme: dark) {
          :host {
            --panel: #151d2c; --text: #eef2f7; --muted: #a7b4c8;
            --line: #344159; --control: #7f8da5; --accent: #a4bdff;
            --soft: #233354; --pressed: #30446c;
          }
        }
        .query {
          padding: 10px 12px; border-bottom: 1px solid var(--line);
          font-family: ui-monospace, monospace; white-space: pre-wrap; word-break: break-all;
        }
        .caret { color: var(--muted); }
        .list { max-height: 260px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--control) var(--panel); }
        .item { padding: 9px 12px; cursor: pointer; display: block; border-left: 3px solid transparent; }
        .item:hover { background: var(--soft); }
        .item[data-selected="true"] { background: var(--soft); border-left-color: var(--accent); }
        .item:active { background: var(--pressed); }
        .trigger {
          display: block; font-family: ui-monospace, monospace; font-weight: 600;
          color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .expansion {
          display: block; margin-top: 2px; color: var(--muted); white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
        }
        .empty, .hint { padding: 10px 12px; color: var(--muted); }
        .hint { border-top: 1px solid var(--line); font-size: 11px; }
        @media (forced-colors: active) {
          .panel { border-color: ButtonText; }
          .item[data-selected="true"] { border-left-color: Highlight; outline: 1px solid Highlight; outline-offset: -1px; }
        }
    `);
    shadow.adoptedStyleSheets = [stylesheet];
    shadow.innerHTML = `
      <div class="panel" role="dialog" aria-label="Insert shorthand">
        <div class="query"></div>
        <div class="list" role="listbox"></div>
        <div class="empty" hidden>No matching shorthand</div>
        <div class="hint">↑↓ choose · Enter insert · Esc cancel</div>
      </div>`;
    listEl = shadow.querySelector(".list");
    queryEl = shadow.querySelector(".query");
    emptyEl = shadow.querySelector(".empty");

    listEl.addEventListener("mousedown", (ev) => {
      if (!ev.isTrusted || !anchorFocused()) return;
      // mousedown, not click: clicking must not blur the page's field.
      ev.preventDefault();
      const item = ev.target.closest(".item");
      if (!item) return;
      selected = Number(item.dataset.index);
      pick();
    });
  }

  function position(anchorEl) {
    let top = 60;
    let left = 40;
    try {
      const rect = anchorEl && anchorEl.getBoundingClientRect && anchorEl.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        top = rect.bottom + 6;
        left = rect.left;
      }
    } catch (_) {
      // Keep the fallback position.
    }
    // Measure rather than guess: a two-item list needs far less room than a
    // full one, and guessing high pushes the panel off the field.
    const measured = host.getBoundingClientRect();
    const width = measured.width || 340;
    const height = measured.height || 320;

    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    if (top + height > window.innerHeight - 8) {
      const rect = anchorEl && anchorEl.getBoundingClientRect && anchorEl.getBoundingClientRect();
      const above = rect ? rect.top - height - 6 : 8;
      top = above > 8 ? above : Math.max(8, window.innerHeight - height - 8);
    }
    host.style.top = top + "px";
    host.style.left = left + "px";
  }

  function refresh() {
    const scored = [];
    for (const sh of results) {
      const s = score(sh, query);
      if (s >= 0) scored.push({ sh, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const visible = scored.slice(0, MAX_RESULTS).map((x) => x.sh);
    currentVisible = visible;

    if (selected >= visible.length) selected = Math.max(0, visible.length - 1);

    queryEl.textContent = query;
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = query ? "" : "Type to search…";
    queryEl.appendChild(caret);

    listEl.textContent = "";
    visible.forEach((sh, i) => {
      const item = document.createElement("div");
      item.className = "item";
      item.setAttribute("role", "option");
      item.dataset.index = String(i);
      item.dataset.selected = String(i === selected);
      item.setAttribute("aria-selected", String(i === selected));
      const t = document.createElement("span");
      t.className = "trigger";
      t.textContent = sh.trigger;
      const e = document.createElement("span");
      e.className = "expansion";
      e.textContent = sh.expansion.replace(/\s+/g, " ").slice(0, 120);
      item.append(t, e);
      listEl.appendChild(item);
    });
    emptyEl.hidden = visible.length > 0;

    const sel = listEl.querySelector('[data-selected="true"]');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });

    // Filtering changes the panel's height, so keep it snug against the field.
    if (anchor) position(anchor);
  }

  let currentVisible = [];

  function anchorFocused() {
    const tree = anchor && anchor.getRootNode ? anchor.getRootNode() : document;
    const active = tree.activeElement;
    return !!anchor && (active === anchor || (anchor.isContentEditable && anchor.contains(active)));
  }

  function pick() {
    const chosen = currentVisible[selected];
    // close() clears onPick, so take a reference before closing. The overlay
    // must be gone before the text is inserted, or the insertion sees it.
    const cb = onPick;
    close();
    if (chosen && cb) cb(chosen);
  }

  function close() {
    if (!open) return;
    open = false;
    query = "";
    selected = 0;
    currentVisible = [];
    anchor = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close, true);
    document.removeEventListener("mousedown", onOutsideMouseDown, true);
    const cb = onClose;
    onPick = null;
    onClose = null;
    if (cb) cb();
  }

  function onOutsideMouseDown(ev) {
    if (!ev.isTrusted) return;
    if (ev.target !== host) close();
  }

  function onKeyDown(ev) {
    if (!open || !ev.isTrusted) return;
    if (!anchorFocused()) { close(); return; }
    const stop = () => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    };

    switch (ev.key) {
      case "Escape":
        stop();
        close();
        return;
      case "Enter":
      case "Tab":
        stop();
        pick();
        return;
      case "ArrowDown":
        stop();
        if (currentVisible.length) selected = (selected + 1) % currentVisible.length;
        refresh();
        return;
      case "ArrowUp":
        stop();
        if (currentVisible.length) selected = (selected - 1 + currentVisible.length) % currentVisible.length;
        refresh();
        return;
      case "Backspace":
        stop();
        if (query === "") close();
        else {
          query = Array.from(query).slice(0, -1).join("");
          refresh();
        }
        return;
      default:
        break;
    }

    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      // Let real shortcuts through, but stop showing a stale list.
      close();
      return;
    }
    // A single printable character extends the search.
    if (Array.from(ev.key).length === 1) {
      stop();
      query += ev.key;
      selected = 0;
      refresh();
    }
  }

  /**
   * Show the picker.
   * @param {{shorthands: Array, anchorEl: Element, onPick: Function, onClose: Function}} opts
   */
  function show(opts) {
    if (open) close();
    if (!opts || !opts.shorthands || opts.shorthands.length === 0) return false;
    build();
    results = opts.shorthands;
    onPick = opts.onPick;
    onClose = opts.onClose;
    query = "";
    selected = 0;
    open = true;

    anchor = opts.anchorEl;
    (document.body || document.documentElement).appendChild(host);
    refresh(); // fills the list, then repositions using the measured size

    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close, true);
    document.addEventListener("mousedown", onOutsideMouseDown, true);
    return true;
  }

  root.ShorthandPicker = {
    show,
    close,
    isOpen: () => open,
    // Exported for the tests.
    _score: score,
  };
})(typeof self !== "undefined" ? self : this);
