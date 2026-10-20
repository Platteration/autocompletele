// Selectable looks for the library, toolbar popup and in-page overlays.
// Classic adds no rules, so every surface keeps its built-in colors and
// shapes. The other looks set CSS custom properties that those built-in
// rules already read, in light and dark. Fonts are local stacks only: the
// extension never downloads a font, so a named face appears only when it is
// installed and the next family in the stack is used otherwise.
(function (root) {
  "use strict";

  const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

  const THEMES = [
    { id: "classic", name: "Classic", note: "Navy sidebar, rounded cards, actle blue." },
    {
      id: "quiet-grid", name: "Quiet Grid", note: "Neutral greys, hairline rules, square corners and one blue.",
      shape: { radiusCard: "0", radius: "0", radiusControl: "2px", radiusSmall: "2px",
        font: SANS, heading: SANS, mono: MONO,
        shadow: "none", overlayShadow: "0 8px 24px rgb(27 31 36 / 16%)" },
      light: { bg: "#ffffff", panel: "#ffffff", surface: "#f5f6f8", text: "#1b1f24", muted: "#59636e",
        line: "#d3d8de", control: "#7a838e", accent: "#1a5fd0", soft: "#e8effc", pressed: "#d3e1f8",
        button: "#1a5fd0", buttonHover: "#154ca8", buttonText: "#ffffff",
        danger: "#b3261e", dangerSoft: "#fcedec", warning: "#8a5300", success: "#1a7f4b",
        sidebar: "#f5f6f8", sidebarText: "#1b1f24", sidebarMuted: "#59636e", sidebarActive: "#e8effc",
        sidebarActiveText: "#1a5fd0", sidebarLine: "#d3d8de", completion: "#1a5fd0" },
      dark: { bg: "#0f1115", panel: "#0f1115", surface: "#16191e", text: "#e7eaee", muted: "#a2aab4",
        line: "#2e343c", control: "#7d8691", accent: "#7aa7ff", soft: "#1a2840", pressed: "#22355a",
        button: "#2f6be0", buttonHover: "#255bc6", buttonText: "#ffffff",
        danger: "#ff8a80", dangerSoft: "#3a1f1d", warning: "#e9b949", success: "#5fd39a",
        sidebar: "#16191e", sidebarText: "#e7eaee", sidebarMuted: "#a2aab4", sidebarActive: "#1a2840",
        sidebarActiveText: "#7aa7ff", sidebarLine: "#2e343c", completion: "#7aa7ff" },
    },
    {
      id: "quiet", name: "Quiet Utility", note: "White panels, soft grey borders, one steady blue.",
      shape: { radiusCard: "12px", radius: "8px", radiusControl: "6px", radiusSmall: "4px",
        font: `"IBM Plex Sans", ${SANS}`, heading: `"IBM Plex Sans", ${SANS}`, mono: `"IBM Plex Mono", ${MONO}`,
        shadow: "0 1px 2px rgb(31 35 40 / 8%)",
        overlayShadow: "0 12px 28px rgb(31 35 40 / 16%), 0 2px 6px rgb(31 35 40 / 8%)" },
      light: { bg: "#f6f7f9", panel: "#ffffff", surface: "#f6f8fa", text: "#1f2328", muted: "#57606a",
        line: "#d8dee4", control: "#848d97", accent: "#1a5fd0", soft: "#e3edfc", pressed: "#c4d7f5",
        button: "#1a5fd0", buttonHover: "#0f4aae", buttonText: "#ffffff",
        danger: "#b3261e", dangerSoft: "#fcedec", warning: "#8a5300", success: "#1a7f4b",
        sidebar: "#ffffff", sidebarText: "#1f2328", sidebarMuted: "#57606a", sidebarActive: "#e3edfc",
        sidebarActiveText: "#0f4aae", sidebarLine: "#d8dee4", completion: "#1a5fd0" },
      dark: { bg: "#0d1117", panel: "#161b22", surface: "#11161d", text: "#e6edf3", muted: "#9da7b3",
        line: "#30363d", control: "#768390", accent: "#6ca4f8", soft: "#15243d", pressed: "#1e3558",
        button: "#2f6be0", buttonHover: "#255bc6", buttonText: "#ffffff",
        danger: "#ff8a80", dangerSoft: "#3a1f1d", warning: "#e9b949", success: "#5fd39a",
        sidebar: "#161b22", sidebarText: "#e6edf3", sidebarMuted: "#9da7b3", sidebarActive: "#15243d",
        sidebarActiveText: "#6ca4f8", sidebarLine: "#30363d", completion: "#6ca4f8" },
    },
    {
      id: "paper", name: "Warm Paper", note: "Off-white paper, dark ink, terracotta and a bookish serif.",
      shape: { radiusCard: "4px", radius: "3px", radiusControl: "3px", radiusSmall: "2px",
        font: `"Source Sans 3", "Source Sans Pro", ${SANS}`,
        heading: '"Fraunces", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
        mono: `"IBM Plex Mono", ${MONO}`,
        shadow: "0 1px 0 rgb(42 36 32 / 5%)",
        overlayShadow: "0 1px 0 rgb(42 36 32 / 5%), 0 12px 28px -8px rgb(42 36 32 / 28%)" },
      light: { bg: "#f6f1e7", panel: "#fffcf6", surface: "#efe7d8", text: "#2a2420", muted: "#5e544a",
        line: "#d8ccb7", control: "#8c7e6c", accent: "#a24a24", soft: "#f3e3d6", pressed: "#ebcdb6",
        button: "#a24a24", buttonHover: "#7e3518", buttonText: "#ffffff",
        danger: "#a3201a", dangerSoft: "#f8e1dc", warning: "#7a5200", success: "#3f6b2a",
        sidebar: "#efe7d8", sidebarText: "#2a2420", sidebarMuted: "#5e544a", sidebarActive: "#f3e3d6",
        sidebarActiveText: "#7a3a1e", sidebarLine: "#d8ccb7", completion: "#a24a24" },
      dark: { bg: "#1e1915", panel: "#2a231e", surface: "#241e19", text: "#f1e8da", muted: "#c7b8a3",
        line: "#4a3f35", control: "#8f7f6c", accent: "#e7a07a", soft: "#3b2a20", pressed: "#4c3528",
        button: "#a8502a", buttonHover: "#93441f", buttonText: "#ffffff",
        danger: "#ff9a8a", dangerSoft: "#3d211c", warning: "#e8c170", success: "#9bcb7e",
        sidebar: "#241e19", sidebarText: "#f1e8da", sidebarMuted: "#c7b8a3", sidebarActive: "#3b2a20",
        sidebarActiveText: "#e7a07a", sidebarLine: "#4a3f35", completion: "#e7a07a" },
    },
    {
      id: "playful", name: "Bright Playful", note: "Violet and sunflower, chunky rounded keycap buttons.",
      shape: { radiusCard: "18px", radius: "14px", radiusControl: "12px", radiusSmall: "6px",
        font: `"Nunito", "Avenir Next", ui-rounded, ${SANS}`,
        heading: `"Bricolage Grotesque", "Nunito", "Avenir Next", ui-rounded, ${SANS}`,
        mono: `"Recursive", ${MONO}`,
        shadow: "0 2px 0 rgb(36 21 65 / 8%)", buttonDepth: "inset 0 -3px 0 rgb(0 0 0 / 22%)",
        overlayShadow: "0 14px 32px rgb(36 21 65 / 34%)" },
      light: { bg: "#fff8ec", panel: "#ffffff", surface: "#f6f1ff", text: "#1d1530", muted: "#5d5474",
        line: "#dcd1f7", control: "#9385c2", accent: "#6b2bd9", soft: "#f1ebff", pressed: "#e4d9ff",
        button: "#6b2bd9", buttonHover: "#5b21b6", buttonText: "#ffffff",
        danger: "#b3261e", dangerSoft: "#fdecea", warning: "#8a5a00", success: "#1e7a46",
        sidebar: "#241541", sidebarText: "#ffffff", sidebarMuted: "#c9bcef", sidebarActive: "#4c1d95",
        sidebarActiveText: "#ffffff", sidebarLine: "#5b3f99", sidebarFocus: "#ffc933", completion: "#ffc933" },
      dark: { bg: "#140c24", panel: "#1f1438", surface: "#1a1030", text: "#f6f0ff", muted: "#c3b6e6",
        line: "#3b2766", control: "#7e6bb8", accent: "#c6a6ff", soft: "#2e1c55", pressed: "#3a2370",
        button: "#7c3aed", buttonHover: "#6d28d9", buttonText: "#ffffff",
        danger: "#ff8a80", dangerSoft: "#3a1f2a", warning: "#ffc933", success: "#6ed8a7",
        sidebar: "#0f081c", sidebarText: "#ffffff", sidebarMuted: "#c3b6e6", sidebarActive: "#3a2370",
        sidebarActiveText: "#ffffff", sidebarLine: "#3b2766", sidebarFocus: "#ffc933", completion: "#ffc933" },
      // On other pages it is a dark violet bubble in both appearances.
      overlay: { panel: "#241541", surface: "#2c1a50", text: "#ffffff", muted: "#c9bcef", line: "#3b2766",
        control: "#7e6bb8", accent: "#ffc933", soft: "#3a2370", pressed: "#4c1d95",
        button: "#ffc933", buttonHover: "#f5d872", buttonText: "#241541",
        danger: "#ffaaa3", dangerSoft: "#3a1f2a", warning: "#ffc933", success: "#6ed8a7",
        frame: "#6b2bd9", scheme: "dark" },
    },
    {
      id: "pro", name: "Dark Pro", note: "Near-black with one electric-lime accent, always dark.",
      shape: { radiusCard: "8px", radius: "6px", radiusControl: "6px", radiusSmall: "4px",
        font: `"Space Grotesk", "Inter", ${SANS}`, heading: `"Space Grotesk", "Inter", ${SANS}`,
        mono: `"JetBrains Mono", ${MONO}`, scheme: "dark",
        shadow: "none", overlayShadow: "0 14px 34px rgb(15 18 24 / 28%), 0 2px 6px rgb(15 18 24 / 20%)" },
      light: { bg: "#0b0d10", panel: "#12151a", surface: "#0f1216", text: "#e8ecf1", muted: "#a3acb9",
        line: "#2a303a", control: "#6b7480", accent: "#c8ff3d", soft: "#1a2015", pressed: "#26300f",
        button: "#c8ff3d", buttonHover: "#e4ff9e", buttonText: "#0b0d10",
        danger: "#ff8a80", dangerSoft: "#3a1f1d", warning: "#ffd166", success: "#6ed8a7",
        sidebar: "#0b0d10", sidebarText: "#f2f5f8", sidebarMuted: "#a3acb9", sidebarActive: "#1a2015",
        sidebarActiveText: "#c8ff3d", sidebarLine: "#2a303a", completion: "#c8ff3d", frame: "#7a9a1f" },
    },
    {
      id: "swiss", name: "Swiss Grid", note: "Black on white, square ruled lists, one signal red.",
      shape: { radiusCard: "0", radius: "0", radiusControl: "0", radiusSmall: "0",
        font: `"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif`,
        heading: `"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif`, mono: MONO,
        shadow: "none", overlayShadow: "6px 6px 0 rgb(17 17 17 / 18%)" },
      light: { bg: "#ffffff", panel: "#ffffff", surface: "#f2f2f2", text: "#111111", muted: "#595959",
        line: "#c8c8c8", control: "#111111", accent: "#d7000f", soft: "#fdecee", pressed: "#f9d3d6",
        button: "#111111", buttonHover: "#333333", buttonText: "#ffffff",
        danger: "#b0000c", dangerSoft: "#fbe0e2", warning: "#7a5200", success: "#1a6b3a",
        sidebar: "#ffffff", sidebarText: "#111111", sidebarMuted: "#595959", sidebarActive: "#111111",
        sidebarActiveText: "#ffffff", sidebarLine: "#111111", completion: "#d7000f" },
      dark: { bg: "#0a0a0a", panel: "#0a0a0a", surface: "#161616", text: "#f5f5f5", muted: "#adadad",
        line: "#3a3a3a", control: "#f5f5f5", accent: "#ff4d57", soft: "#3a0a0e", pressed: "#520f15",
        button: "#f5f5f5", buttonHover: "#d6d6d6", buttonText: "#0a0a0a",
        danger: "#ff8a80", dangerSoft: "#3a0a0e", warning: "#e9b949", success: "#5fd39a",
        sidebar: "#0a0a0a", sidebarText: "#f5f5f5", sidebarMuted: "#adadad", sidebarActive: "#f5f5f5",
        sidebarActiveText: "#0a0a0a", sidebarLine: "#f5f5f5", completion: "#ff4d57" },
    },
  ];
  const DEFAULT = "classic";
  const byId = new Map(THEMES.map((theme) => [theme.id, theme]));

  function normalize(value) {
    return byId.has(value) ? value : DEFAULT;
  }

  function declarations(map) {
    return Object.entries(map).filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}: ${value};`).join(" ");
  }

  // One palette feeds every token name the library, popup and overlays use.
  function colorTokens(c) {
    return {
      "--bg": c.bg, "--card": c.panel, "--panel": c.panel, "--editor-bg": c.surface, "--surface": c.surface,
      "--text": c.text, "--muted": c.muted, "--line": c.line, "--control-line": c.control, "--control": c.control,
      "--accent": c.accent, "--accent-soft": c.soft, "--soft": c.soft, "--pressed": c.pressed,
      "--button": c.button, "--button-hover": c.buttonHover, "--button-text": c.buttonText, "--toggle": c.button,
      "--danger": c.danger, "--danger-soft": c.dangerSoft, "--warning": c.warning, "--success": c.success,
      "--sidebar": c.sidebar, "--sidebar-text": c.sidebarText, "--sidebar-muted": c.sidebarMuted,
      "--sidebar-active": c.sidebarActive, "--sidebar-active-text": c.sidebarActiveText,
      "--sidebar-line": c.sidebarLine, "--sidebar-focus": c.sidebarFocus || c.sidebarActiveText,
      "--brand-completion": c.completion, "--frame": c.frame || c.accent,
      "--frame-glow": `color-mix(in srgb, ${c.frame || c.accent} 16%, transparent)`,
    };
  }

  function shapeTokens(s, overlay) {
    return {
      "--radius-card": s.radiusCard, "--radius-panel": s.radius, "--radius-control": s.radiusControl,
      "--radius-small": s.radiusSmall, "--font": s.font, "--font-heading": s.heading, "--mono": s.mono,
      "--shadow": overlay ? s.overlayShadow : s.shadow, "--button-depth": s.buttonDepth || "none",
    };
  }

  function css(selector, theme, overlay) {
    if (!theme.light) return "";
    const fixed = overlay && theme.overlay;
    const light = fixed ? Object.assign({}, theme.light, theme.overlay) : theme.light;
    const dark = fixed ? light : (theme.dark || theme.light);
    const scheme = (fixed && theme.overlay.scheme) || theme.shape.scheme;
    let text = `${selector} { ${scheme ? `color-scheme: ${scheme} !important; ` : ""}`
      + `${declarations(Object.assign(colorTokens(light), shapeTokens(theme.shape, overlay)))} }`;
    if (dark !== light) {
      text += ` @media (prefers-color-scheme: dark) { ${selector} { ${declarations(colorTokens(dark))} } }`;
    }
    return text;
  }

  /** Rules for the library page and popup, scoped to <html data-actle-theme>. */
  function pageCss(id) {
    const themeId = normalize(id);
    return css(`:root[data-actle-theme="${themeId}"]`, byId.get(themeId), false);
  }

  /** Rules adopted after each in-page overlay's own sheet. */
  function overlayCss(id) {
    return css(":host", byId.get(normalize(id)), true);
  }

  // Every overlay in this document adopts one shared sheet, so a style
  // change restyles open overlays as well as the next ones.
  let overlayTheme = DEFAULT;
  let overlaySheet = null;

  function adopt(shadow, sheet) {
    if (!overlaySheet) {
      overlaySheet = new CSSStyleSheet();
      overlaySheet.replaceSync(overlayCss(overlayTheme));
    }
    shadow.adoptedStyleSheets = [sheet, overlaySheet];
  }

  function setOverlayTheme(id) {
    const next = normalize(id);
    if (next === overlayTheme) return;
    overlayTheme = next;
    if (overlaySheet) overlaySheet.replaceSync(overlayCss(next));
  }

  let pageSheet = null;
  const CACHE_KEY = "actle-theme";

  /** Restyles an extension page. The local copy only avoids a flash of
   * Classic on the next open; the saved setting always wins. */
  function applyPage(doc, id, remember = true) {
    const themeId = normalize(id);
    if (!pageSheet) {
      pageSheet = new doc.defaultView.CSSStyleSheet();
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, pageSheet];
    }
    pageSheet.replaceSync(pageCss(themeId));
    doc.documentElement.dataset.actleTheme = themeId;
    if (remember) {
      try { doc.defaultView.localStorage.setItem(CACHE_KEY, themeId); } catch (_) {}
    }
    return themeId;
  }

  function applyRemembered(doc) {
    let remembered = DEFAULT;
    try { remembered = doc.defaultView.localStorage.getItem(CACHE_KEY); } catch (_) {}
    return applyPage(doc, remembered, false);
  }

  const api = { THEMES, DEFAULT, normalize, pageCss, overlayCss, adopt, setOverlayTheme, applyPage, applyRemembered };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ActleThemes = api;
})(typeof self !== "undefined" ? self : this);
