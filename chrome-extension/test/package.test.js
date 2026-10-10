const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildPackages } = require("../scripts/build.js");

test("browser packages contain only runtime files and installable manifests", async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "shorthand-package-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  buildPackages(output);
  const archives = {};
  for (const browser of ["chrome", "firefox"]) {
    const directory = path.join(output, browser);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json")));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, "actle");
    assert.equal(manifest.action.default_title, "actle");
    assert.deepEqual(manifest.permissions, ["storage"]);
    assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
    if (browser === "chrome") {
      assert.deepEqual(manifest.background, { service_worker: "src/background.js" });
      assert.equal(manifest.browser_specific_settings, undefined);
    } else {
      assert.deepEqual(manifest.background, { scripts: ["src/storage.js", "src/background.js"] });
      assert.deepEqual(manifest.browser_specific_settings.gecko, {
        id: "{54b890b4-5bb5-4f1f-a949-2d595afe249c}",
        strict_min_version: "142.0",
        data_collection_permissions: { required: ["none"] },
      });
    }
    const required = [manifest.options_page, manifest.action.default_popup,
      ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((c) => c.js),
      ...(manifest.background.scripts || [manifest.background.service_worker])];
    for (const file of required) assert.ok(fs.statSync(path.join(directory, file)).isFile(), file);
    const files = fs.readdirSync(directory, { recursive: true }).filter((file) =>
      fs.statSync(path.join(directory, file)).isFile()).map((file) => file.split(path.sep).join("/"));
    for (const file of files) assert.match(file, /^(manifest\.json|src\/[^/]+\.(js|html|css)|icons\/icon\d+\.png)$/);
    assert.ok(files.includes("src/options.js"));
    assert.ok(files.includes("src/popup.js"));
    assert.ok(files.includes("src/brand.js"));
    assert.ok(files.includes("src/brand.css"));

    const archivePath = path.join(output, `actle-${browser}-${manifest.version}.zip`);
    const archive = fs.readFileSync(archivePath);
    archives[archivePath] = archive;
    // Inspect local entries independently of the writer, including exact file contents.
    const archivedFiles = [];
    let offset = 0;
    while (archive.readUInt32LE(offset) === 0x04034b50) {
      assert.equal(archive.readUInt16LE(offset + 8), 0, "uncompressed ZIP entry");
      const size = archive.readUInt32LE(offset + 18);
      const nameLength = archive.readUInt16LE(offset + 26);
      const extraLength = archive.readUInt16LE(offset + 28);
      const name = archive.toString("utf8", offset + 30, offset + 30 + nameLength);
      const start = offset + 30 + nameLength + extraLength;
      archivedFiles.push(name);
      assert.deepEqual(archive.subarray(start, start + size), fs.readFileSync(path.join(directory, name)));
      offset = start + size;
    }
    assert.deepEqual(archivedFiles.sort(), files.sort());
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, "central directory follows entries");
    assert.equal(archive.readUInt32LE(archive.length - 22), 0x06054b50, "end of central directory");
  }

  // A rebuild also removes stale packaged files without depending on mtimes.
  fs.writeFileSync(path.join(output, "firefox", "stale.txt"), "stale");
  buildPackages(output);
  assert.equal(fs.existsSync(path.join(output, "firefox", "stale.txt")), false);
  for (const [archivePath, original] of Object.entries(archives)) {
    assert.deepEqual(fs.readFileSync(archivePath), original, "ZIP bytes are reproducible");
  }
});
