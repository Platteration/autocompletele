// Package the same readable sources for both stores; no bundling or remote code.
const fs = require("node:fs");
const path = require("node:path");
const { crc32 } = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const FIREFOX_ID = "{54b890b4-5bb5-4f1f-a949-2d595afe249c}";

function browserManifest(browser) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  if (browser === "firefox") {
    manifest.background = { scripts: ["src/storage.js", "src/premium-config.js", "src/license.js", "src/premium-service.js", "src/background.js"] };
    manifest.browser_specific_settings = {
      gecko: {
        // Keep this ID stable across releases: Firefox uses it for updates/storage.
        id: FIREFOX_ID,
        strict_min_version: "142.0",
        // Firefox uses local storage; Chrome's browser-managed sync is not enabled.
        data_collection_permissions: { required: ["none"] },
      },
    };
  }
  return manifest;
}

// Write standard, uncompressed ZIP entries. Fixed metadata and sorted names make
// release bytes reproducible without a system zip tool or packaging dependency.
function zip(files) {
  const entries = [];
  const directory = [];
  let offset = 0;
  for (const [filename, bytes] of files) {
    const name = Buffer.from(filename, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // ZIP 2.0
    header.writeUInt16LE(0x0800, 6); // UTF-8 filenames
    header.writeUInt16LE(33, 12); // 1980-01-01, 00:00:00
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    entries.push(header, name, bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}

function buildPackages(output = path.join(ROOT, "dist")) {
  // Only runtime sources and PNG icons go to stores; tests, tooling, npm files,
  // private local configuration and existing build products cannot slip in.
  const names = [
    ...fs.readdirSync(path.join(ROOT, "src")).filter((name) => /^[\w-]+\.(js|html|css)$/.test(name)).map((name) => `src/${name}`),
    ...fs.readdirSync(path.join(ROOT, "icons")).filter((name) => /^icon\d+\.png$/.test(name)).map((name) => `icons/${name}`),
  ];
  const sources = names.map((name) => [name, fs.readFileSync(path.join(ROOT, name))]);
  fs.mkdirSync(output, { recursive: true });
  for (const browser of ["chrome", "firefox"]) {
    const manifest = browserManifest(browser);
    const files = [...sources, ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")]];
    files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const stage = path.join(output, browser);
    fs.rmSync(stage, { recursive: true, force: true });
    for (const [name, bytes] of files) {
      const target = path.join(stage, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    fs.writeFileSync(path.join(output, `actle-${browser}-${manifest.version}.zip`), zip(files));
  }
}

if (require.main === module) {
  buildPackages();
  console.log("Chrome and Firefox packages written to chrome-extension/dist/");
}

module.exports = { buildPackages };
