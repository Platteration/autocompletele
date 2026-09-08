(async function () {
  "use strict";
  const storage = self.ShorthandStorage;
  const enabledEl = document.getElementById("enabled");
  const siteEl = document.getElementById("site");
  const hostEl = document.getElementById("host");
  const countEl = document.getElementById("count");

  let host = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/.test(tab.url)) host = new URL(tab.url).hostname;
  } catch (_) { /* no tab access */ }

  const { shorthands, settings } = await storage.getAll();
  enabledEl.checked = settings.enabled !== false;
  const excluded = settings.excludedHosts || [];
  if (host) {
    hostEl.textContent = host;
    siteEl.checked = !excluded.includes(host);
  } else {
    siteEl.disabled = true;
  }
  countEl.textContent = `${shorthands.length} shorthand${shorthands.length === 1 ? "" : "s"} defined`;

  enabledEl.addEventListener("change", () => storage.saveSettings({ enabled: enabledEl.checked }));
  siteEl.addEventListener("change", async () => {
    const set = new Set(excluded);
    if (siteEl.checked) set.delete(host); else set.add(host);
    await storage.saveSettings({ excludedHosts: Array.from(set) });
  });
  document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
})();
