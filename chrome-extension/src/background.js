// Chrome service worker / Firefox background page: seed examples on first
// install and keep the toolbar badge in sync with the enabled state.
// Firefox loads these dependencies through the generated background.scripts list.
if (typeof importScripts === "function") importScripts("storage.js", "premium-config.js", "license.js", "premium-service.js");

const storage = self.ShorthandStorage;
self.ActlePremiumService.create({ chrome, config: self.ActlePremiumConfig, license: self.ActleLicense }).install();

const EXAMPLES = [
  { trigger: "cool/", expansion: "That is really cool, thanks for sharing!" },
  { trigger: "sig/", expansion: "Best regards,\n{cursor}" },
  { trigger: "td/", expansion: "{date}" },
];

const SAVE_SELECTION_MENU_ID = "actle-save-selection";

function createSelectionMenu() {
  if (!chrome.contextMenus) return;
  // The callback only observes lastError: recreating on update is expected
  // to report a duplicate id, which would otherwise log an unchecked error.
  chrome.contextMenus.create({
    id: SAVE_SELECTION_MENU_ID,
    title: "Save selection as actle shorthand",
    contexts: ["selection"],
  }, () => void chrome.runtime.lastError);
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info) => {
    if (!info || info.menuItemId !== SAVE_SELECTION_MENU_ID || !info.selectionText) return;
    try {
      if (storage.savePendingDraft) await storage.savePendingDraft(info.selectionText);
    } catch (_) {
      // The library still opens; the person can paste the text themselves.
    }
    chrome.runtime.openOptionsPage();
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  createSelectionMenu();
  if (details.reason === "install") {
    const { shorthands } = await storage.getAll();
    if (shorthands.length === 0) await storage.replaceAll(EXAMPLES);
    chrome.runtime.openOptionsPage();
  }
  updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === storage.AREA && changes.settings) updateBadge();
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
