// Watches the folders where documents land and reports each new file once it
// has stopped growing, so a download or scan that is still being written is
// not read half way. Plain Node (no Electron): main.js decides what to do with
// a file; the assistant proposes and applies the filing.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({ settleMs: 1500, maxWaitMs: 60000 });
// Names browsers, Office and scanners use while a file is still being written.
const TEMPORARY = /(^\.|^~\$|\.(tmp|temp|crdownload|part|partial|download|swp)$)/i;

function createFolderWatcher(options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const onFile = typeof settings.onFile === "function" ? settings.onFile : () => {};
  const log = typeof settings.log === "function" ? settings.log : () => {};
  const watchers = [];
  const pending = new Map();
  // What was already reported, by size and modification time: the events a
  // file's final close raises after it settled must not report it again.
  const reported = new Map();
  let folders = [];

  function isTemporary(name) {
    return TEMPORARY.test(name);
  }

  function clearPending(file) {
    const entry = pending.get(file);
    if (entry) clearTimeout(entry.timer);
    pending.delete(file);
  }

  /** An event arms (or re-arms) the quiet-period timer; only the timer compares sizes. */
  function arm(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      clearPending(file);
      return;
    }
    if (!stat.isFile()) {
      clearPending(file);
      return;
    }
    const entry = pending.get(file) || { size: stat.size, timer: null, since: Date.now() };
    entry.size = stat.size;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => settle(file), settings.settleMs);
    if (entry.timer.unref) entry.timer.unref();
    pending.set(file, entry);
  }

  /** After a quiet period: report the file if it is the size it was when the timer was armed, else wait again. */
  function settle(file) {
    const entry = pending.get(file);
    if (!entry) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      clearPending(file);
      return;
    }
    if (!stat.isFile()) {
      clearPending(file);
      return;
    }
    if (stat.size !== entry.size && Date.now() - entry.since <= settings.maxWaitMs) {
      arm(file);
      return;
    }
    clearPending(file);
    const signature = stat.size + ":" + Math.floor(stat.mtimeMs);
    if (reported.get(file) === signature) return;
    reported.set(file, signature);
    if (reported.size > 500) reported.delete(reported.keys().next().value);
    try {
      onFile(file);
    } catch (error) {
      log("filing: " + error.message);
    }
  }

  function consider(folder, filename) {
    if (!filename) return;
    const name = path.basename(String(filename));
    if (isTemporary(name)) return;
    arm(path.join(folder.path, String(filename)));
  }

  function watchOne(folder) {
    if (!fs.existsSync(folder.path)) {
      log("filing: folder " + folder.path + " does not exist; not watched");
      return null;
    }
    try {
      const watcher = fs.watch(folder.path, { recursive: !!folder.recursive, persistent: false }, (eventType, filename) => consider(folder, filename));
      watcher.on("error", (error) => log("filing: watching " + folder.path + " failed: " + error.message));
      return watcher;
    } catch (error) {
      log("filing: cannot watch " + folder.path + ": " + error.message);
      return null;
    }
  }

  function stop() {
    for (const watcher of watchers.splice(0)) {
      try {
        watcher.close();
      } catch (error) {
        // Already closed.
      }
    }
    for (const file of [...pending.keys()]) clearPending(file);
    reported.clear();
  }

  /** Watch these folders ({path, recursive}) from now on, replacing the previous set. */
  function start(list) {
    stop();
    folders = (Array.isArray(list) ? list : []).filter((f) => f && typeof f.path === "string" && f.path);
    for (const folder of folders) {
      const watcher = watchOne(folder);
      if (watcher) watchers.push(watcher);
    }
    return watchers.length;
  }

  /** Every file already in a folder (for a rescan the person asks for). */
  function listFiles(folder, recursive) {
    const out = [];
    const walk = (dir, depth) => {
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        log("filing: cannot list " + dir + ": " + error.message);
        return;
      }
      for (const entry of names) {
        if (isTemporary(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isFile()) out.push(full);
        else if (entry.isDirectory() && recursive && depth < 8) walk(full, depth + 1);
      }
    };
    walk(folder, 0);
    return out.sort();
  }

  return {
    start,
    stop,
    listFiles,
    isTemporary,
    get folders() { return folders.slice(); },
    get watching() { return watchers.length; },
    get pending() { return pending.size; },
  };
}

module.exports = { DEFAULTS, TEMPORARY, createFolderWatcher };
