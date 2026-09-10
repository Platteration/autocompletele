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
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed; z-index: 2147483647; width: 340px; max-width: 90vw;
          background: #fff; color: #1f2937; border: 1px solid #d1d5db;
          border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18);
          font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
          overflow: hidden;
        }
        @media (prefers-color-scheme: dark) {
          .panel { background: #1f2937; color: #f3f4f6; border-color: #4b5563; }
          .query { border-bottom-color: #4b5563 !important; }
          .item[data-selected="true"] { background: #374151 !important; }
          .trigger { color: #93c5fd !important; }
          .hint { color: #9ca3af !important; border-top-color: #4b5563 !important; }
        }
        .query {
          padding: 8px 10px; border-bottom: 1px solid #e5e7eb;
          font-family: ui-monospace, monospace; white-space: pre-wrap; word-break: break-all;
        }
        .caret { opacity: .5; }
        .list { max-height: 260px; overflow-y: auto; }
        .item { padding: 7px 10px; cursor: pointer; display: block; }
        .item[data-selected="true"] { background: #eff6ff; }
        .trigger { font-family: ui-monospace, monospace; font-weight: 600; color: #2563eb; }
        .expansion {
          display: block; opacity: .75; white-space: nowrap;
          overflow: hidden; text-overflow: ellipsis;
        }
        .empty, .hint { padding: 8px 10px; opacity: .7; }
        .hint { border-top: 1px solid #e5e7eb; font-size: 11px; }
      </style>
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
      // mousedown, not click: clicking must not blur the page's field.
      ev.preventDefault();
      const item = ev.target.closest(".item");
      if (!item) return;
      selected = Number(item.dataset.index);
      pick();
    });
  }

  function position(anchorEl) {
    const panel = shadow.querySelector(".panel");
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
    // Measure the panel rather than guessing: a two-item list needs far less
    // room than a full one, and guessing high pushes it off the field.
    const measured = panel.getBoundingClientRect();
    const width = measured.width || 340;
    const height = measured.height || 320;

    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    if (top + height > window.innerHeight - 8) {
      const rect = anchorEl && anchorEl.getBoundingClientRect && anchorEl.getBoundingClientRect();
      const above = rect ? rect.top - height - 6 : 8;
      top = above > 8 ? above : Math.max(8, window.innerHeight - height - 8);
    }
    panel.style.top = top + "px";
    panel.style.left = left + "px";
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
    if (ev.target !== host) close();
  }

  function onKeyDown(ev) {
    if (!open) return;
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
