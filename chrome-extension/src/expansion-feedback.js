// A brief, decorative cue after insertion. Never alter the editor or its text.
(function (root) {
  "use strict";

  const DURATION = 680;
  let current = null;
  const styles = `
    :host {
      all: initial !important; position: fixed !important; inset: 0 !important;
      display: block !important; margin: 0 !important; padding: 0 !important;
      border: 0 !important; pointer-events: none !important;
      z-index: 2147483646 !important; overflow: hidden !important;
      contain: strict !important;
    }
    .frame {
      position: absolute; box-sizing: border-box; pointer-events: none;
      overflow: hidden; border: 1px solid #2357d7; border-radius: 8px;
      background: transparent; box-shadow: 0 0 0 3px rgb(35 87 215 / 16%);
      opacity: 0; animation: actle-expansion-fade ${DURATION}ms ease-out both;
    }
    .frame::after {
      content: ""; position: absolute; left: 0; bottom: 0;
      width: 42%; height: 2px; pointer-events: none;
      background: linear-gradient(90deg, transparent, #2357d7, transparent);
      animation: actle-expansion-sweep ${DURATION}ms cubic-bezier(.2, .65, .3, 1) both;
    }
    @keyframes actle-expansion-fade {
      0% { opacity: 0; }
      16% { opacity: .9; }
      58% { opacity: .7; }
      100% { opacity: 0; }
    }
    @keyframes actle-expansion-sweep {
      0% { transform: translateX(-110%); }
      85%, 100% { transform: translateX(350%); }
    }
    @media (prefers-color-scheme: dark) {
      .frame { border-color: #a4bdff; box-shadow: 0 0 0 3px rgb(164 189 255 / 16%); }
      .frame::after { background: linear-gradient(90deg, transparent, #a4bdff, transparent); }
    }
    @media (prefers-reduced-motion: reduce) {
      .frame, .frame::after { animation: none; }
    }
    @media (forced-colors: active) {
      .frame { border-color: Highlight; box-shadow: none; }
      .frame::after { background: Highlight; }
    }
  `;

  function clear() {
    const session = current;
    current = null;
    if (!session) return;
    // Cleanup is independent of insertion, even if the document is going away.
    try { session.controller.abort(); } catch (_) { /* Decorative only. */ }
    try { root.cancelAnimationFrame(session.raf); } catch (_) { /* Decorative only. */ }
    try { root.clearTimeout(session.timer); } catch (_) { /* Decorative only. */ }
    try { session.host.remove(); } catch (_) { /* Decorative only. */ }
  }

  function focused(editor) {
    return document.activeElement === editor || editor.contains(document.activeElement);
  }

  function show(editor) {
    clear();
    try {
      if (!editor || !editor.isConnected || editor.ownerDocument !== document || !focused(editor)) return false;
      const motion = root.matchMedia("(prefers-reduced-motion: reduce)");
      if (motion.matches) return false;
      const box = editor.getBoundingClientRect();
      if (![box.left, box.top, box.width, box.height].every(Number.isFinite)
          || box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0
          || box.left >= root.innerWidth || box.top >= root.innerHeight) return false;
      const appearance = root.getComputedStyle(editor);
      if (appearance.visibility !== "visible" || appearance.opacity === "0") return false;

      const host = document.createElement("div");
      host.id = "actle-expansion-feedback";
      host.setAttribute("aria-hidden", "true");
      host.setAttribute("role", "presentation");
      host.inert = true;
      const shadow = host.attachShadow({ mode: "closed" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styles);
      const frameRule = [...sheet.cssRules].find((rule) => rule.selectorText === ".frame");
      // CSSOM rules, not inline style attributes, also work under strict CSP.
      frameRule.style.left = box.left + "px";
      frameRule.style.top = box.top + "px";
      frameRule.style.width = box.width + "px";
      frameRule.style.height = box.height + "px";
      frameRule.style.borderRadius = appearance.borderRadius;
      shadow.adoptedStyleSheets = [sheet];
      const frame = document.createElement("div");
      frame.className = "frame";
      shadow.appendChild(frame);

      const session = { host, controller: new AbortController(), raf: 0, timer: 0 };
      current = session;
      const stop = () => { if (current === session) clear(); };
      const listen = (target, type, callback = stop) => target.addEventListener(type, callback, {
        capture: true, passive: true, signal: session.controller.signal,
      });
      // Capture listeners added during insertion do not see that input again
      // when it later bubbles. The next edit, click, or focus move ends the cue.
      for (const type of ["keydown", "beforeinput", "input", "compositionstart", "pointerdown", "focusout", "scroll", "visibilitychange"]) {
        listen(document, type);
      }
      for (const type of ["blur", "resize", "pagehide"]) listen(root, type);
      if (root.visualViewport) {
        listen(root.visualViewport, "scroll");
        listen(root.visualViewport, "resize");
      }
      listen(motion, "change", () => { if (motion.matches) stop(); });
      listen(frame, "animationend", (event) => {
        if (event.animationName === "actle-expansion-fade") stop();
      });
      // Appending outside the body avoids transformed body layouts changing
      // the fixed overlay's coordinate system.
      document.documentElement.appendChild(host);
      const drawn = frame.getBoundingClientRect();
      // A transformed/zoomed document root can still change fixed coordinates.
      // Skip the decoration if its actual box misses the editor by over half a pixel.
      if (["left", "top", "width", "height"].some((key) => Math.abs(drawn[key] - box[key]) > .5)) {
        stop();
        return false;
      }
      session.timer = root.setTimeout(stop, DURATION + 170);

      function watchLayout() {
        if (current !== session) return;
        try {
          const next = editor.getBoundingClientRect();
          if (!editor.isConnected || !host.isConnected || !focused(editor)
              || next.left !== box.left || next.top !== box.top
              || next.width !== box.width || next.height !== box.height) {
            stop();
            return;
          }
          session.raf = root.requestAnimationFrame(watchLayout);
        } catch (_) { stop(); }
      }
      session.raf = root.requestAnimationFrame(watchLayout);
      return true;
    } catch (_) {
      clear();
      return false;
    }
  }

  root.ShorthandExpansionFeedback = { show, clear };
})(typeof self !== "undefined" ? self : this);
