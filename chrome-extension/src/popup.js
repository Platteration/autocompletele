(async function () {
  "use strict";
  const storage = self.ShorthandStorage;
  const palette = self.ShorthandPalette;
  const template = self.ShorthandTemplate;
  const templateForm = self.ShorthandTemplateForm;
  const enabledEl = document.getElementById("enabled");
  const siteEl = document.getElementById("site");
  const hostEl = document.getElementById("host");
  const countEl = document.getElementById("count");
  const statusEl = document.getElementById("status");
  const searchEl = document.getElementById("search");
  const resultsEl = document.getElementById("results");
  const toastEl = document.getElementById("toast");

  let host = "";
  let shorthands = [];
  let excluded = [];
  let visible = [];

  function setStatus(enabled, siteEnabled) {
    const active = enabled && siteEnabled;
    statusEl.textContent = active ? "Active" : "Paused";
    statusEl.dataset.state = active ? "active" : "paused";
    statusEl.setAttribute("aria-label", active ? "Expansion active" : "Expansion paused");
  }

  function say(text) {
    toastEl.textContent = text;
    if (text) setTimeout(() => {
      if (toastEl.textContent === text) toastEl.textContent = "";
    }, 1800);
  }

  async function copy(shorthand) {
    if (!shorthand || templateForm.isOpen()) return;
    if (template.requiresInput(shorthand.expansion)) {
      const previous = document.activeElement;
      templateForm.show({
        trigger: shorthand.trigger,
        expansion: shorthand.expansion,
        actionLabel: "Copy text",
        restoreFocus: true,
        async onSubmit(result) {
          try {
            await navigator.clipboard.writeText(result.text);
            say(`Copied ${shorthand.trigger}`);
            if (previous && previous.isConnected) previous.focus({ preventScroll: true });
            return true;
          } catch (_) {
            return "Could not copy to clipboard. Please try again.";
          }
        },
      });
      return;
    }
    try {
      const text = template.variables(shorthand.expansion).length
        ? template.render(shorthand.expansion).text
        : template.fill(shorthand.expansion, {});
      await navigator.clipboard.writeText(text);
      say(`Copied ${shorthand.trigger}`);
    } catch (_) {
      say("Could not copy to clipboard.");
    }
  }

  function renderResults() {
    visible = palette.search(shorthands, searchEl.value, 6);
    resultsEl.textContent = "";
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = shorthands.length ? "No matching shorthand." : "No shorthands yet.";
      resultsEl.appendChild(empty);
      return;
    }

    for (const shorthand of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "result";
      const needsInput = template.requiresInput(shorthand.expansion);
      button.title = needsInput
        ? `Fill in and copy ${shorthand.trigger}`
        : `Copy expansion for ${shorthand.trigger}`;

      const head = document.createElement("div");
      head.className = "result-head";
      const trigger = document.createElement("span");
      trigger.className = "trigger";
      trigger.textContent = shorthand.trigger;
      const copyHint = document.createElement("span");
      copyHint.className = "copy";
      copyHint.textContent = needsInput ? "Fill in" : "Copy";
      head.append(trigger, copyHint);

      const expansion = document.createElement("div");
      expansion.className = "expansion";
      expansion.textContent = shorthand.expansion.replace(/\s+/g, " ").trim();
      button.append(head, expansion);
      button.addEventListener("click", () => copy(shorthand));
      resultsEl.appendChild(button);
    }
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/.test(tab.url)) host = new URL(tab.url).hostname;
  } catch (_) { /* no tab access */ }

  const data = await storage.getAll();
  shorthands = data.shorthands;
  const settings = data.settings;
  enabledEl.checked = settings.enabled !== false;
  excluded = settings.excludedHosts || [];

  let siteEnabled = true;
  if (host) {
    hostEl.textContent = host;
    siteEnabled = !excluded.includes(host);
    siteEl.checked = siteEnabled;
  } else {
    siteEl.checked = true;
    siteEl.disabled = true;
    hostEl.textContent = "Unavailable on this page";
  }

  countEl.textContent = `${shorthands.length} shorthand${shorthands.length === 1 ? "" : "s"}`;
  setStatus(enabledEl.checked, siteEnabled);
  renderResults();

  searchEl.addEventListener("input", renderResults);
  searchEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && visible[0]) {
      event.preventDefault();
      copy(visible[0]);
    }
    if (event.key === "ArrowDown") {
      const first = resultsEl.querySelector(".result");
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  resultsEl.addEventListener("keydown", (event) => {
    if (!event.target.classList.contains("result")) return;
    const buttons = Array.from(resultsEl.querySelectorAll(".result"));
    const index = buttons.indexOf(event.target);
    if (event.key === "ArrowDown" && buttons[index + 1]) {
      event.preventDefault();
      buttons[index + 1].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (buttons[index - 1]) buttons[index - 1].focus(); else searchEl.focus();
    }
  });

  enabledEl.addEventListener("change", async () => {
    await storage.saveSettings({ enabled: enabledEl.checked });
    setStatus(enabledEl.checked, siteEl.disabled ? true : siteEl.checked);
  });

  siteEl.addEventListener("change", async () => {
    const set = new Set(excluded);
    if (siteEl.checked) set.delete(host); else set.add(host);
    excluded = Array.from(set);
    await storage.saveSettings({ excludedHosts: excluded });
    setStatus(enabledEl.checked, siteEl.checked);
  });

  document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
})();
