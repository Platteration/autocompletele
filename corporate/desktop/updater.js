// Software updates for the packaged desktop app. A desk only ever asks the
// https server its organisation policy names (`updates.url`, `updates.channel`),
// so an unmanaged install never contacts anything. electron-updater does the
// download and the install on quit; this module keeps the decisions
// (configured or not, deferred or not) in plain Node so they can be tested.
//
// The server is any static https host with the files electron-builder writes
// next to the installers: <channel>.yml (Windows), <channel>-mac.yml and
// <channel>-linux.yml, plus the installer each one names.
"use strict";

const PHASES = Object.freeze(["idle", "checking", "current", "available", "downloading", "downloaded", "error"]);

/**
 * @param {{policy:Function, settings:Function, isPackaged?:boolean, autoUpdater?:object|null, log?:Function, audit?:Function, notify?:Function, now?:Function}} options
 *   `policy()` returns the merged policy (only `updates` is read), `settings()` the person's settings
 *   (only `deferUpdates`). `autoUpdater` is electron-updater's export or a stand-in; undefined loads the real one.
 */
function createUpdater(options) {
  const opts = Object.assign({ policy: () => ({}), settings: () => ({}), isPackaged: false, log: () => {}, audit: () => {}, notify: () => {}, now: () => Date.now() }, options || {});
  let autoUpdater = opts.autoUpdater;
  let unavailable = null;
  if (autoUpdater === undefined) {
    try {
      autoUpdater = require("electron-updater").autoUpdater;
    } catch (error) {
      autoUpdater = null;
      unavailable = "electron-updater is not installed";
    }
  }
  if (!autoUpdater) unavailable = unavailable || "no updater on this platform";

  const state = { phase: "idle", version: null, percent: null, error: null, checkedAt: null, feed: null };

  function feed() {
    const policy = opts.policy() || {};
    const updates = policy.updates || {};
    if (typeof updates.url !== "string" || !/^https:\/\//i.test(updates.url)) return null;
    return { url: updates.url, channel: typeof updates.channel === "string" && updates.channel ? updates.channel : "latest" };
  }

  function deferred() {
    const settings = opts.settings() || {};
    return settings.deferUpdates === true;
  }

  function set(phase, extra) {
    state.phase = PHASES.includes(phase) ? phase : "idle";
    Object.assign(state, extra || {});
  }

  if (autoUpdater && typeof autoUpdater.on === "function") {
    autoUpdater.on("checking-for-update", () => set("checking", { error: null }));
    autoUpdater.on("update-not-available", (info) => set("current", { version: info && info.version ? info.version : null, error: null }));
    autoUpdater.on("update-available", (info) => {
      const version = info && info.version ? String(info.version) : null;
      set(deferred() ? "available" : "downloading", { version, percent: null, error: null });
      opts.audit({ event: "update-available", version, channel: state.feed ? state.feed.channel : null, deferred: deferred() });
      if (deferred()) opts.notify("actle Corporate " + (version || "") + " is available. Updates are deferred: download it from the Policy tab when convenient.");
    });
    autoUpdater.on("download-progress", (progress) => set("downloading", { percent: progress && Number.isFinite(progress.percent) ? Math.round(progress.percent) : null }));
    autoUpdater.on("update-downloaded", (info) => {
      const version = info && info.version ? String(info.version) : state.version;
      set("downloaded", { version, percent: 100, error: null });
      opts.audit({ event: "update-downloaded", version });
      opts.notify("actle Corporate " + (version || "") + " is downloaded and installs when the app restarts.");
    });
    autoUpdater.on("error", (error) => {
      const message = String(error && error.message || error || "unknown error");
      set("error", { error: message });
      opts.log("update: " + message);
      opts.audit({ event: "update-failed", error: message.slice(0, 200) });
    });
  }

  /** Why a check would do nothing, or null when one can run. */
  function blocked() {
    if (!autoUpdater) return unavailable;
    if (!feed()) return "the organisation policy names no update server";
    if (!opts.isPackaged) return "not a packaged build";
    return null;
  }

  function configure() {
    const next = feed();
    autoUpdater.autoDownload = !deferred();
    autoUpdater.autoInstallOnAppQuit = true;
    if (!state.feed || state.feed.url !== next.url || state.feed.channel !== next.channel) {
      autoUpdater.setFeedURL({ provider: "generic", url: next.url, channel: next.channel });
      state.feed = next;
    }
  }

  /** Ask the server once. Never runs without an https server in the policy. */
  async function check() {
    const reason = blocked();
    if (reason) return { ok: false, reason };
    configure();
    state.checkedAt = opts.now();
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true, phase: state.phase };
    } catch (error) {
      const message = String(error && error.message || error);
      set("error", { error: message });
      opts.log("update check failed: " + message);
      return { ok: false, reason: message };
    }
  }

  /** Download the update that a check found while downloads were deferred. */
  async function download() {
    const reason = blocked();
    if (reason) return { ok: false, reason };
    if (state.phase !== "available") return { ok: false, reason: "no update is waiting to be downloaded" };
    configure();
    set("downloading", { percent: null });
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      const message = String(error && error.message || error);
      set("error", { error: message });
      return { ok: false, reason: message };
    }
  }

  /** Quit and run the downloaded installer. */
  function install() {
    if (state.phase !== "downloaded") return { ok: false, reason: "nothing has been downloaded" };
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  }

  function status() {
    const current = feed();
    return {
      available: !!autoUpdater,
      configured: !!current,
      url: current ? current.url : null,
      channel: current ? current.channel : null,
      packaged: !!opts.isPackaged,
      deferred: deferred(),
      blocked: blocked(),
      phase: state.phase,
      version: state.version,
      percent: state.percent,
      error: state.error,
      checkedAt: state.checkedAt,
    };
  }

  return { check, download, install, status, blocked };
}

module.exports = { createUpdater, PHASES };
