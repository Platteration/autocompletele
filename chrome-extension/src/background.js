// Service worker: seeds a couple of example shorthands on first install and
// keeps the toolbar badge in sync with the enabled state.
importScripts("storage.js");

const storage = self.ShorthandStorage;

const EXAMPLES = [
  { trigger: "cool/", expansion: "That is really cool, thanks for sharing!" },
  { trigger: "sig/", expansion: "Best regards,\n{cursor}" },
  { trigger: "td/", expansion: "{date}" },
];

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    const { shorthands } = await storage.getAll();
    if (shorthands.length === 0) await storage.replaceAll(EXAMPLES);
    chrome.runtime.openOptionsPage();
  }
  updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) updateBadge();
});

async function updateBadge() {
  try {
    const { settings } = await storage.getAll();
    const off = settings.enabled === false;
    await chrome.action.setBadgeText({ text: off ? "off" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#9ca3af" });
  } catch (_) {
    // ignore
  }
}
