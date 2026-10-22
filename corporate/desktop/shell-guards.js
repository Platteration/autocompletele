// Decisions the Electron shell (main.js) takes about windows and about what a
// renderer may ask for, kept as plain functions so they run under Node in
// test/shell-guards.test.js. main.js needs Electron and calls these.
"use strict";

const nodePath = require("node:path");

// Popovers that open on an event the person did not just cause. A filing
// popover appears when a file settles in a watched folder (a browser download
// a web page started counts), so it must never take the keyboard focus: keys
// meant for another application would land in its Name field and the next
// Enter would make them a file name, an index entry and an audit line.
const UNPROMPTED_POPOVERS = new Set(["filing"]);

/**
 * The BrowserWindow method that shows a popover: "showInactive" or "show".
 * A filing popover, and any popover created with `focusable: false` (keyword
 * offers, Guard warnings: they open while the person types elsewhere), is
 * shown inactive. On macOS, Electron's show() activates the application for
 * a window that is not a panel even when the window cannot take the keys,
 * which hands the keys to another actle window such as an open dashboard.
 *
 * @param {string} kind  the popover state's kind
 * @param {{focusable?: boolean}} [options]  the BrowserWindow options it was created with
 */
function popoverShowMethod(kind, options) {
  if (UNPROMPTED_POPOVERS.has(kind)) return "showInactive";
  return options && options.focusable === false ? "showInactive" : "show";
}

/**
 * The path filing:reveal may show in the file manager, or null. A renderer
 * sends a filing index entry id (the Filing tab) or, for the Sheets tab, the
 * exact path of the last add-in configuration export. Anything else, an
 * entry's path included, is refused. Threat: a renderer that runs code it
 * should not (none is known; this is defence in depth) pointing Explorer or
 * Finder at any location, such as a UNC path that makes Windows connect to a
 * remote share and offer the person's credentials.
 *
 * @param {unknown} request
 * @param {{entries?: Array<{id?: string, path?: string}>, exportPaths?: string[]}} known
 */
function revealTarget(request, known) {
  if (typeof request !== "string" || !request) return null;
  const given = known || {};
  const entry = (given.entries || []).find((e) => e && typeof e.id === "string" && e.id === request);
  if (entry) return typeof entry.path === "string" && entry.path ? entry.path : null;
  return (given.exportPaths || []).some((p) => typeof p === "string" && p && p === request) ? request : null;
}

function pathFor(platform) {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/**
 * The watched folders that propose a document: the folder it is in, or a
 * recursive watch above it. Both sides are resolved first, so a policy path
 * written with a trailing separator or with forward slashes on Windows still
 * matches; Windows paths compare without case. Every covering folder is
 * returned (nested watches can both report the same document), so "Never
 * for this folder" can turn off each watch that would propose the next
 * document there.
 *
 * @param {string} filePath  the document
 * @param {Array<{path: string, recursive?: boolean}>} folders  watch folders, paths with ~ expanded
 * @param {{platform?: string}} [options]  defaults to this computer's platform
 */
function watchesCovering(filePath, folders, options) {
  const platform = (options && options.platform) || process.platform;
  const p = pathFor(platform);
  const fold = platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const folder = fold(p.resolve(p.dirname(String(filePath == null ? "" : filePath))));
  return (folders || []).filter((watch) => {
    if (!watch || typeof watch.path !== "string" || !watch.path.trim()) return false;
    const base = fold(p.resolve(watch.path));
    if (folder === base) return true;
    return watch.recursive === true && folder.startsWith(base.endsWith(p.sep) ? base : base + p.sep);
  });
}

/** The queued documents that some active watch still covers, in queue order. */
function stillWatched(files, activeFolders, options) {
  return (files || []).filter((file) => watchesCovering(file, activeFolders, options).length > 0);
}

/**
 * What "Never for this folder" tells the person when it turned off a watch
 * other than the document's own folder (a recursive parent), or null when it
 * turned off just that folder and the closing popover says enough.
 */
function ignoredFoldersMessage(filePath, turnedOff, options) {
  const platform = (options && options.platform) || process.platform;
  const p = pathFor(platform);
  const fold = platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
  const own = fold(p.resolve(p.dirname(String(filePath == null ? "" : filePath))));
  const wider = (turnedOff || []).filter((watch) => fold(p.resolve(watch.path)) !== own);
  if (!wider.length) return null;
  return "No longer watching " + turnedOff.map((watch) => watch.path + (watch.recursive ? " (and its sub-folders)" : "")).join(", ")
    + " for documents to file on this desk. The Filing tab turns a folder back on.";
}

/**
 * Every web contents keeps the page it loaded: a navigation the page starts
 * is cancelled and window.open is denied. Threat: a page that navigated
 * away (a link, a form without its handler, injected markup) would keep the
 * preload bridge and with it every IPC channel. Pages are loaded by main.js
 * with loadFile, which does not fire will-navigate.
 */
function guardNavigation(contents) {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

module.exports = { popoverShowMethod, revealTarget, watchesCovering, stillWatched, ignoredFoldersMessage, guardNavigation, UNPROMPTED_POPOVERS };
