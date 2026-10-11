// Visual frames after a single real insertion. Never alter the editor or its text.
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
    .mask {
      position: absolute; box-sizing: border-box; overflow: hidden;
      pointer-events: none; opacity: 1; isolation: isolate;
    }
    .mirror {
      position: absolute; display: block; box-sizing: border-box; margin: 0;
      border: 0; opacity: 1; pointer-events: none;
    }
    .glyphs { opacity: 1; }
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

  function editorText(editor) {
    return typeof editor.value === "string" ? editor.value : editor.textContent;
  }

  function inputNeedsOutline(editor) {
    return editor.tagName === "INPUT" && (editor.scrollLeft !== 0 || editor.scrollWidth > editor.clientWidth);
  }

  function textStyle(appearance) {
    return [appearance.font, appearance.lineHeight, appearance.color, appearance.backgroundColor,
      appearance.padding, appearance.textAlign, appearance.letterSpacing, appearance.wordSpacing,
      appearance.getPropertyValue("-webkit-text-fill-color"), appearance.getPropertyValue("-webkit-text-stroke"),
      appearance.getPropertyValue("-webkit-text-security")].join("|");
  }

  function meetsRoundedCorner(css, clip, bounds, left, top, width, height) {
    const radii = [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius];
    for (let index = 0; index < radii.length; index++) {
      const parts = radii[index].trim().split(/\s+/);
      const radius = (part, size) => part.endsWith("%") ? parseFloat(part) * size / 100 : parseFloat(part);
      const rx = radius(parts[0], clip.width);
      const ry = radius(parts[1] || parts[0], clip.height);
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) return true;
      if (rx <= 0 || ry <= 0) continue;
      const cornerLeft = index === 0 || index === 3 ? left : left + width - rx;
      const cornerTop = index < 2 ? top : top + height - ry;
      // The corner's bounding rectangle is deliberately conservative. Controls
      // safely inset from rounded corners still receive the glyph animation.
      if (bounds.left < cornerLeft + rx && bounds.right > cornerLeft
          && bounds.top < cornerTop + ry && bounds.bottom > cornerTop) return true;
    }
    return false;
  }

  function maskBackground(editor, bounds) {
    let background = null;
    for (let node = editor; node; node = node.parentElement) {
      const css = root.getComputedStyle(node);
      // Complex compositing cannot be faithfully covered by one opaque layer.
      if (css.opacity !== "1" || css.transform !== "none" || css.filter !== "none"
          || (css.backdropFilter && css.backdropFilter !== "none") || css.perspective !== "none"
          || css.mixBlendMode !== "normal" || css.clipPath !== "none"
          || (css.maskImage && css.maskImage !== "none")
          || (css.zoom && css.zoom !== "1" && css.zoom !== "normal")) return null;
      if (!background) {
        if (css.backgroundImage !== "none") return null;
        const color = css.backgroundColor;
        const values = /^rgba?\(/.test(color) ? color.match(/[\d.]+/g).map(Number) : null;
        if (!values) return null;
        const alpha = values.length === 4 ? values[3] : 1;
        if (alpha !== 0 && alpha !== 1) return null;
        if (alpha === 1) background = color;
      }
      if (node !== editor) {
        const clip = node.getBoundingClientRect();
        const left = clip.left + node.clientLeft;
        const top = clip.top + node.clientTop;
        const paint = /(?:paint|strict|content)/.test(css.contain);
        const clips = paint || css.overflowX !== "visible" || css.overflowY !== "visible";
        if (clips && meetsRoundedCorner(css, clip, bounds, left, top, node.clientWidth, node.clientHeight)) return null;
        if ((paint || css.overflowX !== "visible")
            && (bounds.left < left - .5 || bounds.right > left + node.clientWidth + .5)) return null;
        if ((paint || css.overflowY !== "visible")
            && (bounds.top < top - .5 || bounds.bottom > top + node.clientHeight + .5)) return null;
      }
    }
    // With no propagated body/root background, Canvas is the browser's actual
    // opaque document backdrop, including a root dark color-scheme.
    return { color: background || "Canvas", colorScheme: root.getComputedStyle(document.documentElement).colorScheme };
  }

  function glyphMask(editor, details, box, appearance, shadow, sheet) {
    const helper = root.ShorthandAnimationFrames;
    const textSecurity = appearance.getPropertyValue("-webkit-text-security");
    if (!helper || !details || !Number.isSafeInteger(details.start) || details.start < 0
        || typeof details.text !== "string" || appearance.direction !== "ltr"
        || appearance.writingMode !== "horizontal-tb" || (textSecurity && textSecurity !== "none")
        || inputNeedsOutline(editor)
        || root.matchMedia("(forced-colors: active)").matches) return null;
    const field = editor.tagName === "INPUT" || editor.tagName === "TEXTAREA";
    if (!field && (!editor.isContentEditable || editor.childNodes.length !== 1
        || editor.firstChild.nodeType !== Node.TEXT_NODE)) return null;
    const value = editorText(editor);
    if (value.length > 20000 || value.slice(details.start, details.start + details.text.length) !== details.text) return null;
    const sequence = helper.plan(details.trigger, details.text);
    if (!sequence) return null;
    const bounds = {
      left: box.left + editor.clientLeft, top: box.top + editor.clientTop,
      width: editor.clientWidth, height: editor.clientHeight,
    };
    bounds.right = bounds.left + bounds.width;
    bounds.bottom = bounds.top + bounds.height;
    if (!bounds.width || !bounds.height || bounds.left < 0 || bounds.top < 0
        || bounds.right > root.innerWidth || bounds.bottom > root.innerHeight) return null;
    const background = maskBackground(editor, bounds);
    if (!background) return null;
    if (!field && ["::before", "::after"].some((pseudo) => !["none", "normal"].includes(root.getComputedStyle(editor, pseudo).content))) return null;

    const mask = document.createElement("div");
    mask.className = "mask";
    const mirror = document.createElement("div");
    mirror.className = "mirror";
    const glyphs = document.createElement("span");
    glyphs.className = "glyphs";
    glyphs.textContent = details.text;
    mirror.append(document.createTextNode(value.slice(0, details.start)), glyphs,
      document.createTextNode(value.slice(details.start + details.text.length)));
    mask.appendChild(mirror);
    const maskRule = [...sheet.cssRules].find((rule) => rule.selectorText === ".mask").style;
    const mirrorRule = [...sheet.cssRules].find((rule) => rule.selectorText === ".mirror").style;
    for (const name of ["left", "top", "width", "height"]) maskRule[name] = bounds[name] + "px";
    maskRule.backgroundColor = background.color;
    maskRule.colorScheme = background.colorScheme;
    maskRule.borderRadius = appearance.borderRadius;
    for (const property of ["font-family", "font-size", "font-weight", "font-style", "font-stretch",
      "font-variant", "font-kerning", "font-feature-settings", "font-variation-settings",
      "line-height", "letter-spacing", "word-spacing", "text-align", "text-indent", "text-transform",
      "text-decoration", "text-shadow", "color", "-webkit-text-fill-color", "-webkit-text-stroke-width", "-webkit-text-stroke-color",
      "tab-size", "white-space", "word-break", "overflow-wrap",
      "padding-top", "padding-right", "padding-bottom", "padding-left"]) {
      mirrorRule.setProperty(property, appearance.getPropertyValue(property));
    }
    mirrorRule.left = -editor.scrollLeft + "px";
    mirrorRule.top = -editor.scrollTop + "px";
    mirrorRule.width = bounds.width + "px";
    if (editor.tagName === "INPUT") {
      mirrorRule.whiteSpace = "pre";
      mirrorRule.overflowWrap = "normal";
      mirrorRule.height = bounds.height + "px";
      mirrorRule.lineHeight = Math.max(0, bounds.height - parseFloat(appearance.paddingTop) - parseFloat(appearance.paddingBottom)) + "px";
    } else if (editor.tagName === "TEXTAREA") {
      mirrorRule.whiteSpace = editor.wrap === "off" ? "pre" : "pre-wrap";
      mirrorRule.overflowWrap = "break-word";
    }
    shadow.appendChild(mask);
    const reject = () => { mask.remove(); return null; };
    if (!field) {
      const real = document.createRange();
      real.selectNodeContents(editor);
      const copy = document.createRange();
      copy.selectNodeContents(mirror);
      const actual = real.getBoundingClientRect();
      const drawn = copy.getBoundingClientRect();
      if (["left", "top", "width", "height"].some((key) => Math.abs(actual[key] - drawn[key]) > 1)) return reject();
    }
    glyphs.textContent = helper.frame(sequence, details.mode, 0).text;
    const initial = glyphs.getBoundingClientRect();
    // A long expansion can scroll its old trigger out of view. Keep the simple
    // field cue when there is no visible place to show the beginning honestly.
    if (initial.width && (initial.right <= bounds.left || initial.left >= bounds.right
        || initial.bottom <= bounds.top || initial.top >= bounds.bottom)) return reject();
    return { glyphs, sequence, helper, remove() { mask.remove(); }, alignScroll() {
      mirrorRule.left = -editor.scrollLeft + "px";
      mirrorRule.top = -editor.scrollTop + "px";
    } };
  }

  function show(editor, details) {
    clear();
    try {
      if (!editor || !editor.isConnected || editor.ownerDocument !== document || !focused(editor)) return false;
      if (details && details.mode === "off") return false;
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
      let scrollLeft = editor.scrollLeft;
      let scrollTop = editor.scrollTop;
      let settlingScroll = true;
      let glyphAnimation = null;
      let cueFinished = false;
      let finalPainted = false;
      current = session;
      const stop = () => { if (current === session) clear(); };
      const alignScroll = () => {
        // Overflowing native inputs have browser-specific padding and clipping
        // origins. Preserve the outline without covering their actual text.
        if (glyphAnimation && inputNeedsOutline(editor)) {
          glyphAnimation.remove();
          glyphAnimation = null;
        }
        if (editor.scrollLeft === scrollLeft && editor.scrollTop === scrollTop) return true;
        if (!settlingScroll) return false;
        // Native caret scrolling may settle after insertion, before the first
        // frame. Follow it once; subsequent scrolling dismisses the mirror.
        scrollLeft = editor.scrollLeft;
        scrollTop = editor.scrollTop;
        if (glyphAnimation) glyphAnimation.alignScroll();
        return true;
      };
      const listen = (target, type, callback = stop) => target.addEventListener(type, callback, {
        capture: true, passive: true, signal: session.controller.signal,
      });
      // Capture listeners added during insertion do not see that input again
      // when it later bubbles. The next edit, click, or focus move ends the cue.
      for (const type of ["keydown", "beforeinput", "input", "compositionstart", "pointerdown", "wheel", "touchmove", "focusout", "visibilitychange"]) {
        listen(document, type);
      }
      listen(document, "scroll", (event) => {
        if (event.target === editor && alignScroll()) return;
        stop();
      });
      for (const type of ["blur", "resize", "pagehide"]) listen(root, type);
      if (root.visualViewport) {
        listen(root.visualViewport, "scroll");
        listen(root.visualViewport, "resize");
      }
      listen(motion, "change", () => { if (motion.matches) stop(); });
      listen(root.matchMedia("(prefers-color-scheme: dark)"), "change");
      listen(frame, "animationend", (event) => {
        if (event.animationName !== "actle-expansion-fade") return;
        cueFinished = true;
        if (!glyphAnimation) stop();
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
      const snapshot = editorText(editor);
      const initialStyle = textStyle(appearance);
      scrollLeft = editor.scrollLeft;
      scrollTop = editor.scrollTop;
      try { glyphAnimation = glyphMask(editor, details, box, appearance, shadow, sheet); } catch (_) {
        // A failed mirror is removed without affecting the ordinary field cue.
        const failed = shadow.querySelector(".mask");
        if (failed) failed.remove();
      }
      const started = root.performance.now();
      session.timer = root.setTimeout(stop, DURATION + 170);

      function watchLayout() {
        if (current !== session) return;
        try {
          const next = editor.getBoundingClientRect();
          if (!editor.isConnected || !host.isConnected || !focused(editor)
              || editorText(editor) !== snapshot || !alignScroll()
              || (glyphAnimation && textStyle(root.getComputedStyle(editor)) !== initialStyle)
              || next.left !== box.left || next.top !== box.top
              || next.width !== box.width || next.height !== box.height) {
            stop();
            return;
          }
          settlingScroll = false;
          if (glyphAnimation) {
            const nextFrame = glyphAnimation.helper.frame(glyphAnimation.sequence, details.mode, root.performance.now() - started);
            if (glyphAnimation.glyphs.textContent !== nextFrame.text) glyphAnimation.glyphs.textContent = nextFrame.text;
            // The CSS cue can end before this clock after expensive layout or
            // delayed frames. Let the glyphs finish and paint once before removal.
            if (nextFrame.done) {
              if (cueFinished && finalPainted) { stop(); return; }
              finalPainted = true;
            }
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
