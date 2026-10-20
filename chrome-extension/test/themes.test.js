// Selectable styles: Classic stays untouched, every other style is complete
// and readable, and open overlays follow a style change.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const themes = require("../src/themes.js");

const SRC = path.join(__dirname, "..", "src");
const others = themes.THEMES.filter((theme) => theme.id !== "classic");

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// Each palette as its surfaces see it: the library and popup use light and
// dark; in-page overlays use a fixed overlay palette when a style has one.
function palettes(theme) {
  const list = [["light", theme.light, false], ["dark", theme.dark || theme.light, false]];
  if (theme.overlay) list.push(["overlay", Object.assign({}, theme.light, theme.overlay), true]);
  return list;
}

test("unknown or missing styles fall back to Classic", () => {
  for (const value of [undefined, null, "", "Classic", "unknown", 3, {}, ["swiss"]]) {
    assert.equal(themes.normalize(value), "classic");
  }
  for (const theme of themes.THEMES) assert.equal(themes.normalize(theme.id), theme.id);
  assert.equal(themes.DEFAULT, "classic");
});

test("the list offers Classic, Quiet Grid and the five mockup directions, once each", () => {
  assert.deepEqual(themes.THEMES.map((theme) => theme.id),
    ["classic", "quiet-grid", "quiet", "paper", "playful", "pro", "swiss"]);
  for (const theme of themes.THEMES) {
    assert.ok(theme.name && theme.note, `${theme.id} needs a name and a note`);
  }
});

test("Classic adds no rules, so every surface keeps its built-in look", () => {
  assert.equal(themes.pageCss("classic"), "");
  assert.equal(themes.overlayCss("classic"), "");
  assert.equal(themes.pageCss("not-a-style"), "");
});

test("every other style sets the same complete token set in light and dark", () => {
  const expected = themes.pageCss("swiss").split("@media")[0].match(/--[a-z-]+(?=:)/g);
  assert.ok(expected.length > 30);
  for (const theme of others) {
    const page = themes.pageCss(theme.id);
    assert.ok(page.startsWith(`:root[data-actle-theme="${theme.id}"] {`), theme.id);
    const [light, dark] = page.split("@media (prefers-color-scheme: dark)");
    assert.deepEqual(light.match(/--[a-z-]+(?=:)/g).sort(), [...expected].sort(), `${theme.id} light tokens`);
    assert.doesNotMatch(page, /undefined|null/, `${theme.id} has a missing value`);
    if (theme.dark) {
      for (const name of light.match(/--[a-z-]+(?=:)/g)) {
        if (/radius|font|mono|shadow|depth/.test(name)) continue;
        assert.match(dark, new RegExp(`${name}:`), `${theme.id} dark ${name}`);
      }
    } else {
      assert.equal(dark, undefined, `${theme.id} looks the same in both appearances`);
    }
    const overlay = themes.overlayCss(theme.id);
    assert.ok(overlay.startsWith(":host {"), theme.id);
    assert.doesNotMatch(overlay, /undefined|null/, `${theme.id} overlay has a missing value`);
  }
});

test("Dark Pro and the Bright Playful overlays stay dark on light pages", () => {
  assert.match(themes.pageCss("pro"), /color-scheme: dark !important/);
  assert.match(themes.overlayCss("pro"), /color-scheme: dark !important/);
  assert.match(themes.overlayCss("playful"), /color-scheme: dark !important; --bg: #fff8ec; --card: #241541;/);
  assert.doesNotMatch(themes.overlayCss("playful"), /prefers-color-scheme/);
  assert.doesNotMatch(themes.pageCss("playful"), /color-scheme: dark !important/);
});

test("text and controls meet WCAG AA in every style, appearance and overlay", () => {
  const text = [["text", "panel"], ["text", "surface"], ["text", "soft"], ["muted", "panel"], ["muted", "surface"],
    ["muted", "soft"], ["accent", "panel"], ["accent", "surface"], ["accent", "soft"], ["buttonText", "button"],
    ["buttonText", "buttonHover"], ["danger", "panel"], ["danger", "dangerSoft"], ["success", "panel"], ["warning", "panel"]];
  const page = [["text", "bg"], ["muted", "bg"], ["accent", "bg"], ["sidebarText", "sidebar"], ["sidebarMuted", "sidebar"],
    ["sidebarActiveText", "sidebarActive"], ["completion", "sidebar"]];
  for (const theme of others) {
    for (const [mode, colors, overlay] of palettes(theme)) {
      for (const [fg, bg] of overlay ? text : [...text, ...page]) {
        const ratio = contrast(colors[fg], colors[bg]);
        assert.ok(ratio >= 4.5, `${theme.id} ${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
      if (!overlay) {
        const focus = colors.sidebarFocus || colors.sidebarActiveText;
        const ratio = contrast(focus, colors.sidebar);
        assert.ok(ratio >= 3, `${theme.id} ${mode}: sidebar focus ring on the sidebar is ${ratio.toFixed(2)}:1`);
      }
      for (const [fg, bg] of [["control", "panel"], ["accent", "panel"]]) {
        const ratio = contrast(colors[fg], colors[bg]);
        assert.ok(ratio >= 3, `${theme.id} ${mode}: ${fg} boundary on ${bg} is ${ratio.toFixed(2)}:1`);
      }
      const frame = colors.frame || colors.accent;
      const field = mode === "dark" ? colors.panel : "#ffffff";
      assert.ok(contrast(frame, field) >= 3, `${theme.id} ${mode}: expansion outline on a field`);
    }
  }
});

test("every token a style sets is read by at least one surface", () => {
  const sources = fs.readdirSync(SRC).filter((name) => /\.(css|html|js)$/.test(name) && name !== "themes.js")
    .map((name) => fs.readFileSync(path.join(SRC, name), "utf8")).join("\n");
  for (const name of new Set(themes.pageCss("swiss").match(/--[a-z-]+(?=:)/g))) {
    assert.ok(sources.includes(`var(${name}`), `${name} is set but never used`);
  }
});

test("every in-page overlay adopts the shared style sheet", () => {
  for (const name of fs.readdirSync(SRC).filter((file) => file.endsWith(".js") && file !== "themes.js")) {
    const source = fs.readFileSync(path.join(SRC, name), "utf8");
    assert.doesNotMatch(source, /adoptedStyleSheets\s*=/, `${name} must use ActleThemes.adopt`);
  }
  for (const name of ["picker.js", "suggestions.js", "template-form.js", "expansion-feedback.js", "premium-client.js"]) {
    assert.match(fs.readFileSync(path.join(SRC, name), "utf8"), /ActleThemes\.adopt\(shadow, /, name);
  }
});

function sandboxed() {
  class Sheet { constructor() { this.text = ""; } replaceSync(text) { this.text = text; } }
  const store = new Map();
  const doc = {
    adoptedStyleSheets: [],
    documentElement: { dataset: {} },
    defaultView: {
      CSSStyleSheet: Sheet,
      localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) },
    },
  };
  const context = { self: {}, CSSStyleSheet: Sheet };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(SRC, "themes.js"), "utf8"), context);
  return { api: context.self.ActleThemes, doc, store };
}

test("open overlays share one sheet and follow a style change", () => {
  const { api } = sandboxed();
  const own = { text: "own" };
  const first = {}, second = {};
  api.adopt(first, own);
  assert.equal(first.adoptedStyleSheets[0], own, "an overlay's own rules come first");
  assert.equal(first.adoptedStyleSheets[1].text, "", "Classic adds nothing");
  api.setOverlayTheme("swiss");
  api.adopt(second, own);
  assert.equal(first.adoptedStyleSheets[1], second.adoptedStyleSheets[1]);
  assert.equal(first.adoptedStyleSheets[1].text, api.overlayCss("swiss"));
  api.setOverlayTheme("unknown");
  assert.equal(second.adoptedStyleSheets[1].text, "", "an unknown style restores Classic");
});

test("extension pages apply the saved style and remember it only when asked", () => {
  const { api, doc, store } = sandboxed();
  assert.equal(api.applyRemembered(doc), "classic");
  assert.equal(doc.documentElement.dataset.actleTheme, "classic");
  assert.equal(doc.adoptedStyleSheets.length, 1);
  assert.equal(store.size, 0, "reading the remembered style writes nothing");

  assert.equal(api.applyPage(doc, "paper"), "paper");
  assert.equal(doc.adoptedStyleSheets.length, 1, "one sheet is reused");
  assert.equal(doc.adoptedStyleSheets[0].text, api.pageCss("paper"));
  assert.equal(store.get("actle-theme"), "paper");

  api.applyPage(doc, "pro", false);
  assert.equal(doc.documentElement.dataset.actleTheme, "pro");
  assert.equal(store.get("actle-theme"), "paper", "a preview does not replace the remembered style");
  assert.equal(api.applyRemembered(doc), "paper");
});

test("unavailable page storage still applies the style", () => {
  const { api, doc } = sandboxed();
  Object.defineProperty(doc.defaultView, "localStorage", { get() { throw new Error("blocked"); } });
  assert.equal(api.applyRemembered(doc), "classic");
  assert.equal(api.applyPage(doc, "swiss"), "swiss");
  assert.equal(doc.documentElement.dataset.actleTheme, "swiss");
});

test("Swiss Grid and Warm Paper restyle overlay structure; other styles only recolor", () => {
  for (const id of ["swiss", "paper"]) {
    const css = themes.overlayCss(id);
    for (const rule of [".item {", "div.heading", ".brand::after", ".hint kbd", "header.heading"]) {
      assert.ok(css.includes(rule), `${id} overlays restyle ${rule}`);
    }
  }
  assert.match(themes.overlayCss("swiss"), /\.item\[data-selected="true"\], \.item\[data-selected="true"\]:hover \{ background: #d7000f; \}/);
  assert.match(themes.overlayCss("paper"), /\.item\[data-selected="true"\]::after \{ content: "↵";/);
  for (const theme of others.filter((entry) => !["swiss", "paper"].includes(entry.id))) {
    assert.doesNotMatch(themes.overlayCss(theme.id), /\.item|\.brand|\.heading/, `${theme.id} sets tokens only`);
  }
  // White on the selected Swiss row, in both appearances.
  assert.ok(contrast("#ffffff", "#d7000f") >= 4.5);
});

test("the page flavor sheet only styles Swiss Grid and Warm Paper", () => {
  const css = fs.readFileSync(path.join(SRC, "themes.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => match[1].trim());
  assert.ok(rules.length > 50);
  for (const selector of rules) {
    // Split the selector list at top-level commas only.
    const parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < selector.length; i++) {
      if (selector[i] === "(") depth++;
      else if (selector[i] === ")") depth--;
      else if (selector[i] === "," && depth === 0) { parts.push(selector.slice(start, i)); start = i + 1; }
    }
    parts.push(selector.slice(start));
    for (const part of parts) {
      assert.match(part.trim(), /^(:root)?(\[data-actle-theme="(swiss|paper)"\]|:is\(\[data-actle-theme="swiss"\], \[data-actle-theme="paper"\]\))/,
        `unscoped rule: ${part.trim()}`);
    }
  }
});
