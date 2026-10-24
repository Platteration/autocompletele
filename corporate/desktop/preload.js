// The only bridge between the dashboard pages and the main process. Every
// call is an ipcRenderer.invoke with plain data; no Node objects cross over.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("actle", {
  getSummary: invoke("metrics:summary"),
  getSeries: invoke("metrics:series"),
  getByApp: invoke("metrics:byApp"),
  getLibrary: invoke("library:get"),
  saveShorthand: invoke("library:save"),
  deleteShorthand: invoke("library:delete"),
  importLibrary: invoke("library:import"),
  exportLibrary: invoke("library:export"),
  previewReport: invoke("report:preview"),
  saveReport: invoke("report:save"),
  getPolicyInfo: invoke("policy:info"),
  refreshPolicy: invoke("policy:refresh"),
  getAudit: invoke("policy:audit"),
  getSettings: invoke("settings:get"),
  saveSettings: invoke("settings:save"),
  setEnabled: invoke("settings:enabled"),
  getCandidates: invoke("learning:candidates"),
  acceptCandidate: invoke("learning:accept"),
  dismissCandidate: invoke("learning:dismiss"),
  getLearningInfo: invoke("learning:info"),
  suggest: invoke("suggestions:add"),
  unsuggest: invoke("suggestions:remove"),
  getSuggestions: invoke("suggestions:list"),
  saveSuggestions: invoke("suggestions:save"),
  clearLearning: invoke("learning:clear"),
  getStatus: invoke("app:status"),
  // Search palette window.
  paletteSearch: invoke("palette:search"),
  paletteChoose: invoke("palette:choose"),
  paletteClose: invoke("palette:close"),
  // Document filing.
  getFilingInfo: invoke("filing:info"),
  getFilingRecent: invoke("filing:recent"),
  undoFiling: invoke("filing:undo"),
  searchFiling: invoke("filing:search"),
  clearFiling: invoke("filing:clear"),
  addFilingFolder: invoke("filing:addFolder"),
  removeFilingFolder: invoke("filing:removeFolder"),
  ignoreFilingFolder: invoke("filing:ignoreFolder"),
  rescanFilingFolder: invoke("filing:rescan"),
  // A filing index entry id, or the exact path of the last extle export; any other path is refused.
  revealFiled: invoke("filing:reveal"),
  // The suite's apps: tabs and channels they register (desktop/apps/index.js).
  listApps: invoke("apps:list"),
  invoke: (channel, payload) => ipcRenderer.invoke("app:invoke", { channel, payload }),
  // Popover windows (template form, documents, keyword offer, filing, app popovers).
  getPopover: invoke("popover:get"),
  submitPopover: invoke("popover:submit"),
  closePopover: invoke("popover:close"),
  // main.js has put this popover on screen (filing.js counts clicks only from then).
  onPopoverShown: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("popover:shown", handler);
    return () => ipcRenderer.removeListener("popover:shown", handler);
  },
  onChange: (listener) => {
    const handler = (event, payload) => listener(payload);
    ipcRenderer.on("app:changed", handler);
    return () => ipcRenderer.removeListener("app:changed", handler);
  },
});
