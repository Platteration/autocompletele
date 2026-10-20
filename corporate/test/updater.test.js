const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUpdater } = require("../desktop/updater.js");
const { check } = require("../desktop/scripts/check-package.js");

function fakeAutoUpdater() {
  const fake = new EventEmitter();
  fake.calls = [];
  fake.autoDownload = true;
  fake.setFeedURL = (options) => fake.calls.push(["setFeedURL", options]);
  fake.checkForUpdates = async () => { fake.calls.push(["checkForUpdates"]); fake.emit("checking-for-update"); return null; };
  fake.downloadUpdate = async () => { fake.calls.push(["downloadUpdate"]); return []; };
  fake.quitAndInstall = (...args) => fake.calls.push(["quitAndInstall", ...args]);
  return fake;
}

function setup(overrides) {
  const fake = fakeAutoUpdater();
  const audits = [];
  const notices = [];
  const ctx = Object.assign({ policy: { updates: { url: "https://updates.example/actle", channel: "latest" } }, settings: { deferUpdates: false }, isPackaged: true }, overrides || {});
  const updater = createUpdater({
    policy: () => ctx.policy,
    settings: () => ctx.settings,
    isPackaged: ctx.isPackaged,
    autoUpdater: fake,
    audit: (entry) => audits.push(entry),
    notify: (message) => notices.push(message),
    now: () => 1700000000000,
  });
  return { updater, fake, audits, notices, ctx };
}

test("without an update server in the policy nothing is ever asked", async () => {
  const { updater, fake } = setup({ policy: { updates: { url: null, channel: "latest" } } });
  const result = await updater.check();
  assert.equal(result.ok, false);
  assert.match(result.reason, /names no update server/);
  assert.deepEqual(fake.calls, [], "neither setFeedURL nor checkForUpdates ran");
  assert.equal(updater.status().configured, false);
  assert.equal((await updater.download()).ok, false);
  assert.equal(updater.install().ok, false);
  // A url that is not https is refused here too, not only at policy parsing.
  const plain = setup({ policy: { updates: { url: "http://updates.example", channel: "latest" } } });
  assert.equal((await plain.updater.check()).ok, false);
  assert.deepEqual(plain.fake.calls, []);
});

test("a configured desk points electron-updater at the policy's server and channel, once", async () => {
  const { updater, fake } = setup({ policy: { updates: { url: "https://updates.example/actle", channel: "beta" } } });
  assert.equal((await updater.check()).ok, true);
  assert.deepEqual(fake.calls, [["setFeedURL", { provider: "generic", url: "https://updates.example/actle", channel: "beta" }], ["checkForUpdates"]]);
  assert.equal(fake.autoDownload, true);
  assert.equal(fake.autoInstallOnAppQuit, true);
  await updater.check();
  assert.equal(fake.calls.filter((c) => c[0] === "setFeedURL").length, 1, "the feed is set again only when the policy changes");
  assert.equal(updater.status().checkedAt, 1700000000000);
  assert.equal(updater.status().phase, "checking");
});

test("deferred updates are announced but not downloaded until the person asks", async () => {
  const { updater, fake, audits, notices, ctx } = setup({ settings: { deferUpdates: true } });
  await updater.check();
  assert.equal(fake.autoDownload, false, "electron-updater must not download on its own");
  fake.emit("update-available", { version: "0.2.0" });
  assert.equal(updater.status().phase, "available");
  assert.equal(updater.status().version, "0.2.0");
  assert.deepEqual(audits, [{ event: "update-available", version: "0.2.0", channel: "latest", deferred: true }]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /deferred/);
  assert.ok(!fake.calls.some((c) => c[0] === "downloadUpdate"));
  assert.equal(updater.install().ok, false, "nothing downloaded yet");
  // The person turns deferral off and downloads.
  ctx.settings = { deferUpdates: false };
  assert.equal((await updater.download()).ok, true);
  assert.ok(fake.calls.some((c) => c[0] === "downloadUpdate"));
  assert.equal(fake.autoDownload, true);
  fake.emit("download-progress", { percent: 42.6 });
  assert.equal(updater.status().percent, 43);
  fake.emit("update-downloaded", { version: "0.2.0" });
  assert.equal(updater.status().phase, "downloaded");
  assert.equal(audits[1].event, "update-downloaded");
  assert.equal(updater.install().ok, true);
  assert.deepEqual(fake.calls.at(-1), ["quitAndInstall", false, true]);
});

test("without deferral an available update downloads by itself, and errors are recorded without stopping the app", async () => {
  const { updater, fake, audits } = setup();
  await updater.check();
  fake.emit("update-available", { version: "0.2.0" });
  assert.equal(updater.status().phase, "downloading");
  assert.equal((await updater.download()).ok, false, "a download already in progress is not started twice");
  fake.emit("error", new Error("ENOTFOUND updates.example"));
  assert.equal(updater.status().phase, "error");
  assert.match(updater.status().error, /ENOTFOUND/);
  assert.equal(audits.at(-1).event, "update-failed");
  fake.checkForUpdates = async () => { throw new Error("HTTP 503"); };
  const result = await updater.check();
  assert.deepEqual(result, { ok: false, reason: "HTTP 503" });
});

test("an unpackaged run and a missing updater module are reported, never thrown", async () => {
  const dev = setup({ isPackaged: false });
  assert.match((await dev.updater.check()).reason, /not a packaged build/);
  assert.deepEqual(dev.fake.calls, []);
  const none = createUpdater({ policy: () => ({ updates: { url: "https://updates.example" } }), settings: () => ({}), isPackaged: true, autoUpdater: null });
  assert.equal((await none.check()).ok, false);
  assert.equal(none.status().available, false);
  assert.equal(none.install().ok, false);
});

test("the package check wants the core and the personal modules next to app.asar, and loads the core from there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actle-pkg-"));
  assert.match(check(dir)[0], /no resources folder/);
  const resources = path.join(dir, "resources");
  fs.mkdirSync(path.join(resources, "core"), { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), "");
  assert.ok(check(dir).some((p) => /missing .*core\/index\.js/.test(p)));
  const root = path.join(__dirname, "..");
  for (const name of fs.readdirSync(path.join(root, "core")).filter((n) => n.endsWith(".js"))) fs.copyFileSync(path.join(root, "core", name), path.join(resources, "core", name));
  fs.mkdirSync(path.join(resources, "chrome-extension", "src"), { recursive: true });
  for (const name of ["expander.js", "template.js", "palette.js"]) fs.copyFileSync(path.join(root, "..", "chrome-extension", "src", name), path.join(resources, "chrome-extension", "src", name));
  assert.deepEqual(check(dir), [], "the packaged layout resolves the personal modules through core/personal.js's second candidate");
  fs.rmSync(path.join(resources, "chrome-extension"), { recursive: true });
  assert.ok(check(dir).some((p) => /missing .*expander\.js/.test(p)));
  fs.rmSync(dir, { recursive: true, force: true });
});
