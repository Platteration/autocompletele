// The folder watcher is plain Node, so its settle-before-report behaviour is
// exercised here with real files and short timers.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFolderWatcher, TEMPORARY } = require("../desktop/filer.js");

function temp() {
  return fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-watch-"));
}

function waitFor(check, ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > ms) return reject(new Error("timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("temporary and hidden names are never reported", () => {
  for (const name of [".DS_Store", "~$report.docx", "setup.tmp", "big.crdownload", "file.part", "a.partial", "x.download", ".hidden.pdf"]) {
    assert.ok(TEMPORARY.test(name), name);
  }
  for (const name of ["report.docx", "scan 1.pdf", "notes.txt", "archive.tar.gz"]) assert.ok(!TEMPORARY.test(name), name);
});

test("a new file is reported once it stops growing; a missing folder is logged, not fatal", async () => {
  const dir = temp();
  const seen = [];
  const logged = [];
  const watcher = createFolderWatcher({ onFile: (file) => seen.push(file), log: (line) => logged.push(line), settleMs: 150 });
  const count = watcher.start([{ path: dir }, { path: path.join(dir, "missing") }, { path: "" }, null]);
  assert.equal(count, 1);
  assert.equal(watcher.watching, 1);
  assert.match(logged[0], /does not exist/);
  const file = path.join(dir, "scan.pdf");
  const handle = fs.openSync(file, "w");
  fs.writeSync(handle, "part one ");
  await new Promise((resolve) => setTimeout(resolve, 60)); // inside the settle window: not reported yet
  fs.writeSync(handle, "part two");
  fs.closeSync(handle);
  await waitFor(() => seen.length > 0, 3000);
  assert.deepEqual(seen, [file]);
  assert.equal(fs.readFileSync(file, "utf8"), "part one part two", "reported only after the last write");
  fs.writeFileSync(path.join(dir, "download.crdownload"), "x");
  fs.mkdirSync(path.join(dir, "sub"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(seen.length, 1, "temporary names and folders are not reported");
  watcher.stop();
  assert.equal(watcher.watching, 0);
  assert.equal(watcher.pending, 0);
  fs.writeFileSync(path.join(dir, "after-stop.txt"), "x");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(seen.length, 1, "nothing is reported after stop");
});

test("listFiles returns documents, skipping temporary names and, unless asked, subfolders", () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "b.txt"), "b");
  fs.writeFileSync(path.join(dir, "a.pdf"), "a");
  fs.writeFileSync(path.join(dir, ".hidden"), "h");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "c.docx"), "c");
  const watcher = createFolderWatcher({});
  assert.deepEqual(watcher.listFiles(dir, false).map((f) => path.relative(dir, f)), ["a.pdf", "b.txt"]);
  assert.deepEqual(watcher.listFiles(dir, true).map((f) => path.relative(dir, f)), ["a.pdf", "b.txt", path.join("sub", "c.docx")]);
  assert.deepEqual(watcher.listFiles(path.join(dir, "nope"), true), []);
});
