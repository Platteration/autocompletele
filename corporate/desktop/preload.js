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
  // Popover windows (template form, documents, keyword offer).
  getPopover: invoke("popover:get"),
  submitPopover: invoke("popover:submit"),
  closePopover: invoke("popover:close"),
  onChange: (listener) => {
    const handler = (event, payload) => listener(payload);
    ipcRenderer.on("app:changed", handler);
    return () => ipcRenderer.removeListener("app:changed", handler);
  },
});
