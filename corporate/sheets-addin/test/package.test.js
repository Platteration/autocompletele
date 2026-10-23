// The package build (build.js in package mode, INSTALL.md): the folder an HTTPS host serves for
// Excel with its generated manifest and icons, and the Apps Script files. Read here the way a
// host would read them: the manifest with a strict XML reader, the icons byte by byte with a CRC-32
// of the test's own. No Office or Google service was asked to accept the package.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const build = require("../build.js");

const ADDIN = path.join(__dirname, "..");
const EXAMPLE = path.join(ADDIN, "extle.config.example.json");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "extle-package-"));
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const CONFIG = Object.freeze({
  id: "3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f",
  baseUrl: "https://addins.example.org/extle/",
  providerName: "Example Logistics Ltd",
  version: "1.2.0.0",
  supportUrl: "https://intranet.example.org/help/extle?topic=install&lang=en",
});
const EXCEL_FILES = ["manifest.xml", "taskpane.html", "taskpane.js", "pane.js", "pane.css", "dist/sheets-core.js", "assets/icon-16.png", "assets/icon-32.png", "assets/icon-64.png", "assets/icon-80.png"];
const APPS_SCRIPT_FILES = ["Code.gs", "Sidebar.html", "sheets-core.html", "pane.html", "appsscript.json"];

/**
 * A strict reader for the XML a manifest is made of: an optional prolog, comments, elements whose
 * attributes are quoted and not repeated, text, the five named entities and character references.
 * Throws on anything that is not well-formed, and on a raw > in text, which the build escapes.
 */
function parseXml(xml) {
  let i = 0;
  const fail = (why) => {
    throw new Error(why + " at offset " + i + ": " + JSON.stringify(xml.slice(i, i + 40)));
  };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(xml)) fail("a character XML 1.0 does not allow");
  const NAME = /[A-Za-z_][\w.:-]*/y;
  const name = () => {
    NAME.lastIndex = i;
    const match = NAME.exec(xml);
    if (!match) fail("a missing name");
    i = NAME.lastIndex;
    return match[0];
  };
  const space = () => {
    const before = i;
    while (/\s/.test(xml[i] || "")) i++;
    return i > before;
  };
  const ENTITY = /&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;
  const decode = (raw) => {
    if (/&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(raw)) fail("a bare & in " + JSON.stringify(raw));
    return raw.replace(ENTITY, (whole, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity] || String.fromCodePoint(entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)));
  };
  const comment = () => {
    const end = xml.indexOf("-->", i + 4);
    if (end < 0) fail("an unclosed comment");
    const body = xml.slice(i + 4, end);
    if (body.includes("--") || body.endsWith("-")) fail("-- inside a comment");
    i = end + 3;
  };
  const misc = () => {
    for (;;) {
      space();
      if (xml.startsWith("<!--", i)) comment();
      else return;
    }
  };
  const element = () => {
    if (xml[i] !== "<") fail("expected an element");
    i++;
    const node = { name: name(), attrs: {}, children: [], text: "" };
    for (;;) {
      const spaced = space();
      if (xml.startsWith("/>", i)) {
        i += 2;
        return node;
      }
      if (xml[i] === ">") {
        i++;
        break;
      }
      if (!spaced) fail("attributes not separated by white space");
      const key = name();
      if (Object.hasOwn(node.attrs, key)) fail("a repeated attribute " + key);
      space();
      if (xml[i] !== "=") fail("an attribute without =");
      i++;
      space();
      const quote = xml[i];
      if (quote !== '"' && quote !== "'") fail("an unquoted attribute " + key);
      const end = xml.indexOf(quote, i + 1);
      if (end < 0) fail("an unclosed attribute value");
      const raw = xml.slice(i + 1, end);
      if (raw.includes("<")) fail("a < inside an attribute value");
      node.attrs[key] = decode(raw);
      i = end + 1;
    }
    for (;;) {
      const next = xml.indexOf("<", i);
      if (next < 0) fail("an unclosed element " + node.name);
      const raw = xml.slice(i, next);
      if (raw.includes(">")) fail("a raw > in text");
      node.text += decode(raw);
      i = next;
      if (xml.startsWith("</", i)) {
        i += 2;
        const closing = name();
        if (closing !== node.name) fail("</" + closing + "> closes <" + node.name + ">");
        space();
        if (xml[i] !== ">") fail("an unfinished closing tag");
        i++;
        return node;
      }
      if (xml.startsWith("<!--", i)) comment();
      else if (xml.startsWith("<!", i) || xml.startsWith("<?", i)) fail("CDATA, a DOCTYPE or a processing instruction");
      else node.children.push(element());
    }
  };
  if (xml.startsWith("<?xml")) {
    const end = xml.indexOf("?>");
    if (end < 0) fail("an unclosed prolog");
    if (!/^<\?xml version="1\.0" encoding="UTF-8"\?>$/.test(xml.slice(0, end + 2))) fail("a prolog other than version 1.0, UTF-8");
    i = end + 2;
  }
  misc();
  const root = element();
  misc();
  if (i !== xml.length) fail("content after the root element");
  return root;
}

const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
const all = (node, name) => descendants(node).filter((child) => child.name === name);
const one = (node, name) => {
  const found = all(node, name);
  assert.equal(found.length, 1, "one <" + name + ">");
  return found[0];
};

/** Every URL a manifest holds, in attributes and text, without the namespace declarations. */
function urls(root) {
  const found = [];
  for (const node of [root, ...descendants(root)]) {
    for (const [key, value] of Object.entries(node.attrs)) if (key !== "xmlns" && !key.startsWith("xmlns:") && /^[a-z]+:\/\//i.test(value)) found.push({ element: node.name, value });
    if (/^[a-z]+:\/\//i.test(node.text.trim())) found.push({ element: node.name, value: node.text.trim() });
  }
  return found;
}

// CRC-32 as the PNG specification gives it (polynomial 0xEDB88320), written here so the build's own is not checked against itself.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Read a PNG: the signature, every chunk with its CRC checked, IHDR first, IEND last. */
function readPng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "the PNG signature");
  const chunks = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    assert.equal(bytes.readUInt32BE(at + 8 + length), crc32(bytes.subarray(at + 4, at + 8 + length)), "the CRC of " + type);
    chunks.push({ type, data });
    at += 12 + length;
  }
  assert.equal(chunks[0].type, "IHDR");
  assert.equal(chunks[0].data.length, 13);
  assert.equal(chunks.at(-1).type, "IEND");
  assert.equal(chunks.at(-1).data.length, 0);
  const header = chunks[0].data;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert.deepEqual([...header.subarray(8)], [8, 6, 0, 0, 0], "8 bits per channel, RGBA, deflate, filter method 0, not interlaced");
  const rows = zlib.inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
  assert.equal(rows.length, height * (1 + width * 4));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(rows[y * (1 + width * 4)], 0, "filter type 0 on row " + y);
    rows.copy(pixels, y * width * 4, y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4));
  }
  return { width, height, pixels, types: chunks.map((chunk) => chunk.type) };
}

/** WCAG 2 relative luminance and contrast ratio. */
function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

function filesUnder(folder, prefix = "") {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(folder, entry.name), prefix + entry.name + "/") : [prefix + entry.name])).sort();
}

test("a package holds what Excel and Apps Script need, with the manifest made from the configuration", () => {
  const out = temp();
  const result = build.buildPackage({ config: CONFIG, out });
  assert.equal(result.out, out);
  assert.equal(result.dev, false);
  assert.deepEqual(result.excel, EXCEL_FILES);
  assert.deepEqual(result.appsScript, APPS_SCRIPT_FILES);
  assert.deepEqual(result.extra, []);
  assert.deepEqual(filesUnder(path.join(out, "excel")), [...EXCEL_FILES].sort(), "the excel folder holds exactly what the host must serve");
  assert.deepEqual(filesUnder(path.join(out, "apps-script")), [...APPS_SCRIPT_FILES].sort());

  const manifest = fs.readFileSync(path.join(out, "excel", "manifest.xml"), "utf8");
  const root = parseXml(manifest);
  assert.equal(root.name, "OfficeApp");
  assert.equal(root.attrs.xmlns, "http://schemas.microsoft.com/office/appforoffice/1.1");
  assert.equal(root.attrs["xsi:type"], "TaskPaneApp");
  assert.deepEqual(root.children.map((child) => child.name), ["Id", "Version", "ProviderName", "DefaultLocale", "DisplayName", "Description", "IconUrl", "HighResolutionIconUrl", "SupportUrl", "Hosts", "Requirements", "DefaultSettings", "Permissions", "VersionOverrides"], "the base manifest's elements in the schema's order, without AppDomains");
  assert.equal(one(root, "Id").text, CONFIG.id);
  assert.equal(one(root, "Version").text, CONFIG.version);
  assert.equal(one(root, "ProviderName").text, CONFIG.providerName);
  assert.equal(one(root, "DisplayName").attrs.DefaultValue, build.NAME, "extle unless the configuration names it");
  assert.equal(root.children.find((child) => child.name === "Description").attrs.DefaultValue, build.DEFAULT_DESCRIPTION);
  assert.equal(one(root, "SupportUrl").attrs.DefaultValue, CONFIG.supportUrl, "the support page as given, its & escaped and read back");
  assert.ok(manifest.includes("topic=install&amp;lang=en"));
  assert.equal(one(one(root, "DefaultSettings"), "SourceLocation").attrs.DefaultValue, CONFIG.baseUrl + "taskpane.html");
  assert.equal(one(root, "IconUrl").attrs.DefaultValue, CONFIG.baseUrl + "assets/icon-32.png");
  assert.equal(one(root, "HighResolutionIconUrl").attrs.DefaultValue, CONFIG.baseUrl + "assets/icon-64.png");
  const set = one(one(root, "Requirements"), "Set");
  assert.deepEqual(set.attrs, { Name: "ExcelApi", MinVersion: "1.7" }, "the pane needs ExcelApi 1.7 at load; 1.8 and 1.12 are checked at run time");
  assert.equal(all(root, "AppDomains").length, 0);
  assert.equal(all(root, "AppDomain").length, 0);

  const found = urls(root);
  const served = found.filter((url) => url.element !== "SupportUrl");
  assert.equal(found.length - served.length, 1, "one support URL");
  assert.equal(served.length, 7, "IconUrl, HighResolutionIconUrl, SourceLocation, three ribbon images and the pane's URL resource");
  for (const url of served) {
    assert.ok(url.value.startsWith(CONFIG.baseUrl), url.element + " " + url.value + " is under baseUrl");
    const file = path.join(out, "excel", ...url.value.slice(CONFIG.baseUrl.length).split("/"));
    assert.ok(fs.statSync(file).isFile(), url.value + " is a file of the excel folder");
  }
  for (const text of ["localhost", "{{", "}}", ...build.PLACEHOLDER_IDS]) assert.equal(manifest.includes(text), false, text + " is not in a manifest built without --dev");
  assert.match(manifest, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!-- extle for Excel, generated by corporate\/sheets-addin\/build.js in package mode /);
  assert.equal(manifest.includes("development package"), false);

  // The ribbon: each Icon names its images by resid; each resid's URL is a PNG of the size it is declared as.
  const images = new Map(all(one(root, "Resources"), "bt:Image").map((image) => [image.attrs.id, image.attrs.DefaultValue]));
  const icons = all(root, "Icon");
  assert.equal(icons.length, 2, "the group and the button");
  for (const icon of icons) {
    assert.deepEqual(icon.children.map((image) => image.attrs.size), ["16", "32", "80"], "the three sizes Microsoft requires");
    for (const image of icon.children) {
      assert.ok(image.attrs.resid.length <= 32, "a resid holds at most 32 characters");
      const url = images.get(image.attrs.resid);
      const png = readPng(fs.readFileSync(path.join(out, "excel", url.slice(CONFIG.baseUrl.length))));
      assert.equal(png.width, Number(image.attrs.size));
      assert.equal(png.height, Number(image.attrs.size));
    }
  }
  // Lengths from Microsoft's manifest reference.
  const strings = (block) => all(one(root, block), "bt:String").map((string) => string.attrs.DefaultValue);
  assert.deepEqual(strings("bt:ShortStrings"), [build.NAME, "Open " + build.NAME]);
  assert.deepEqual(strings("bt:LongStrings"), ["Open the " + build.NAME + " pane: complete cells from your organisation's vocabularies and insert blocks or formulas by trigger."]);
  for (const node of [root, ...descendants(root)]) if (node.attrs.id && node.name.startsWith("bt:")) assert.ok(node.attrs.id.length <= 32, node.attrs.id);
  remove(out);
});

test("every icon is a PNG of its size with a valid IHDR, CRCs that check and the pixels build.js drew", () => {
  const out = temp();
  build.buildPackage({ config: CONFIG, out });
  const white = [255, 255, 255];
  for (const size of build.ICON_SIZES) {
    const bytes = fs.readFileSync(path.join(out, "excel", "assets", "icon-" + size + ".png"));
    assert.deepEqual(bytes, build.iconPng(size));
    const png = readPng(bytes);
    assert.deepEqual([png.width, png.height], [size, size]);
    assert.deepEqual(png.types, ["IHDR", "IDAT", "IEND"]);
    assert.deepEqual(png.pixels, build.iconPixels(size), "the pixels survive the encoding");
    const pixel = (x, y) => [...png.pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    assert.equal(pixel(0, 0)[3], 0, "a rounded corner is transparent");
    assert.deepEqual(pixel(Math.floor(size / 2), 1), [...build.ICON_COLOUR, 255], "the square is the accent colour");
    let glyph = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b, a] = pixel(x, y);
        if (r === 255 && g === 255 && b === 255) {
          glyph++;
          assert.equal(a, 255, "the letter is opaque");
        } else assert.deepEqual([r, g, b], build.ICON_COLOUR, "two colours only");
      }
    }
    assert.ok(glyph > 0 && glyph < size * size * 0.4, size + ": a letter, not a filled square");
  }
  assert.ok(contrast(white, build.ICON_COLOUR) >= 4.5, "the white letter on the accent colour meets WCAG AA for text: " + contrast(white, build.ICON_COLOUR).toFixed(2));
  // The checker itself: a flipped bit fails the CRC.
  const broken = Buffer.from(build.iconPng(16));
  broken[20] ^= 1;
  assert.throws(() => readPng(broken), /the CRC of IHDR/);
  remove(out);
});

test("the same configuration gives the same bytes twice", () => {
  const a = temp();
  const b = temp();
  build.buildPackage({ config: CONFIG, out: a });
  build.buildPackage({ config: CONFIG, out: b });
  for (const folder of ["excel", "apps-script"]) {
    for (const file of filesUnder(path.join(a, folder))) assert.deepEqual(fs.readFileSync(path.join(b, folder, file)), fs.readFileSync(path.join(a, folder, file)), folder + "/" + file);
  }
  for (const file of filesUnder(a)) assert.equal(fs.readFileSync(path.join(a, file)).includes(build.ROOT), false, file + " holds no absolute path");
  remove(a);
  remove(b);
});

test("taskpane.html's scripts and styles, and Sidebar.html's includes, resolve inside the package", () => {
  const out = temp();
  build.buildPackage({ config: CONFIG, out });
  const excel = path.join(out, "excel");
  const page = fs.readFileSync(path.join(excel, "taskpane.html"), "utf8");
  const references = [...page.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(references, ["https://appsforoffice.microsoft.com/lib/1/hosted/office.js", "pane.css", "dist/sheets-core.js", "pane.js", "taskpane.js"]);
  for (const reference of references.filter((ref) => !/^https:/.test(ref))) assert.ok(fs.statSync(path.join(excel, reference)).isFile(), reference);
  // The pages and scripts are the sources, byte for byte; the bundle and the includes are what build() writes.
  const plain = temp();
  build.build({ out: plain });
  for (const file of ["taskpane.html", "taskpane.js", "pane.js", "pane.css"]) assert.deepEqual(fs.readFileSync(path.join(excel, file)), fs.readFileSync(path.join(ADDIN, file)), file);
  assert.deepEqual(fs.readFileSync(path.join(excel, "dist", "sheets-core.js")), fs.readFileSync(path.join(plain, "dist", "sheets-core.js")));

  const appsScript = path.join(out, "apps-script");
  for (const file of ["Code.gs", "Sidebar.html", "appsscript.json"]) assert.deepEqual(fs.readFileSync(path.join(appsScript, file)), fs.readFileSync(path.join(ADDIN, "apps-script", file)), file);
  for (const file of ["sheets-core.html", "pane.html"]) assert.deepEqual(fs.readFileSync(path.join(appsScript, file)), fs.readFileSync(path.join(plain, "apps-script", file)), file);
  const sidebar = fs.readFileSync(path.join(appsScript, "Sidebar.html"), "utf8");
  const includes = [...sidebar.matchAll(/<\?!= include\("([^"]+)"\); \?>/g)].map((match) => match[1]);
  assert.deepEqual(includes, ["sheets-core", "pane"]);
  // Code.gs serves an include with HtmlService.createHtmlOutputFromFile(name), the project's file name.html.
  assert.match(fs.readFileSync(path.join(appsScript, "Code.gs"), "utf8"), /function include\(name\) \{\n  return HtmlService\.createHtmlOutputFromFile\(name\)\.getContent\(\);/);
  for (const name of includes) assert.ok(fs.statSync(path.join(appsScript, name + ".html")).isFile(), name + ".html");
  assert.match(fs.readFileSync(path.join(appsScript, "Code.gs"), "utf8"), /HtmlService\.createTemplateFromFile\("Sidebar"\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(appsScript, "appsscript.json"), "utf8"));
  assert.equal(manifest.runtimeVersion, "V8");
  assert.deepEqual(manifest.oauthScopes, ["https://www.googleapis.com/auth/spreadsheets.currentonly", "https://www.googleapis.com/auth/script.container.ui"]);
  remove(out);
  remove(plain);
});

test("text from the configuration is escaped in the manifest and reads back exactly", () => {
  const out = temp();
  const config = { ...CONFIG, providerName: "Birch & Co <\"Ltd\"> 'North'", displayName: "R&D <extle>", description: "Fills <cells> & \"rows\"; it's {{ID}}." };
  build.buildPackage({ config, out });
  const manifest = fs.readFileSync(path.join(out, "excel", "manifest.xml"), "utf8");
  const root = parseXml(manifest);
  assert.equal(one(root, "ProviderName").text, config.providerName);
  assert.equal(one(root, "DisplayName").attrs.DefaultValue, config.displayName);
  assert.equal(root.children.find((child) => child.name === "Description").attrs.DefaultValue, config.description, "a value that looks like a placeholder is not filled again");
  assert.deepEqual(all(one(root, "bt:ShortStrings"), "bt:String").map((string) => string.attrs.DefaultValue), [config.displayName, "Open " + config.displayName]);
  assert.ok(manifest.includes("<ProviderName>Birch &amp; Co &lt;&quot;Ltd&quot;&gt; &apos;North&apos;</ProviderName>"));
  assert.equal(manifest.includes("<extle>"), false);
  assert.equal(manifest.includes("<cells>"), false);
  assert.equal(build.escapeXml("<a href=\"x\">Tom & Jerry's</a>"), "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;");
  // The reader refuses what an unescaped value would leave.
  assert.throws(() => parseXml('<a b="Tom & Jerry"/>'), /a bare &/);
  assert.throws(() => parseXml('<a b="<x>"/>'), /a < inside an attribute value/);
  assert.throws(() => parseXml("<a>1 > 0</a>"), /a raw > in text/);
  assert.throws(() => parseXml("<a b=c/>"), /an unquoted attribute/);
  assert.throws(() => parseXml("<a><b></a>"), /<\/a> closes <b>/);
  assert.throws(() => parseXml('<a b="1" b="2"/>'), /a repeated attribute/);
  assert.throws(() => parseXml("<a/><b/>"), /content after the root element/);
  assert.throws(() => parseXml("<!-- build.js --package --><a/>"), /-- inside a comment/);
  assert.throws(() => parseXml("<a>\u0001</a>"), /a character XML 1.0 does not allow/);
  remove(out);
});

test("the template: every placeholder is one build.js fills, a stray or unknown one stops the build", () => {
  const template = fs.readFileSync(build.TEMPLATE, "utf8");
  assert.deepEqual([...new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((match) => match[1]))].sort(), ["BASE_URL", "DESCRIPTION", "DISPLAY_NAME", "ID", "PROVIDER_NAME", "SUPPORT_URL", "VERSION"]);
  assert.equal(/localhost|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(template), false, "the template holds no address or GUID of its own");
  assert.equal([...template.matchAll(/https?:\/\//g)].length, [...template.matchAll(/xmlns(?::\w+)?="https?:\/\//g)].length, "only namespaces");
  const config = build.validateConfig(CONFIG);
  assert.throws(() => build.manifestFor(config, "<a>{{NOPE}}</a>"), /a placeholder build.js does not fill: \{\{NOPE\}\}/);
  assert.throws(() => build.manifestFor(config, "<a>{{ ID }}</a>"), /a placeholder that is not \{\{NAME\}\} in capitals/);
  assert.throws(() => build.manifestFor(config, "<a>{{id}}</a>"), /a placeholder that is not \{\{NAME\}\} in capitals/);
  assert.equal(build.fillTemplate("<a>{{ID}}</a>", { ID: "x&y" }), "<a>x&amp;y</a>");
});

test("a configuration is refused with every problem named, and nothing is written", () => {
  const refused = (change, pattern, options = {}) => {
    const config = typeof change === "function" ? change({ ...CONFIG }) : { ...CONFIG, ...change };
    const out = path.join(temp(), "package");
    assert.throws(() => build.buildPackage({ config, out, dev: options.dev }), (error) => {
      assert.match(error.message, /^the configuration cannot be packaged:\n {2}- /);
      assert.ok(error.problems.some((problem) => pattern.test(problem)), JSON.stringify(error.problems) + " names " + pattern);
      if (options.count !== undefined) assert.equal(error.problems.length, options.count, JSON.stringify(error.problems));
      return true;
    });
    assert.equal(fs.existsSync(out), false, "nothing written for " + JSON.stringify(change));
    remove(path.dirname(out));
  };
  const accepted = (change, options = {}) => build.validateConfig(typeof change === "function" ? change({ ...CONFIG }) : { ...CONFIG, ...change }, options);

  // id
  for (const id of ["not-a-guid", "{3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6f}", "3f2b8c1e5d4a4e7b9c601a2b3c4d5e6f", "3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6", "3f2b8c1e-5d4a-4e7b-9c60-1a2b3c4d5e6g", 42]) refused({ id }, /^id must be a GUID/, { count: 1 });
  for (const id of [...build.PLACEHOLDER_IDS, build.PLACEHOLDER_IDS[0].toUpperCase()]) {
    refused({ id }, /^id .* is a placeholder, not a GUID made for your organisation; generate one with: node -e "console.log\(crypto.randomUUID\(\)\)"/, { count: 1 });
    assert.equal(accepted({ id }, { dev: true }).id, id, "a development package may keep the placeholder");
  }
  assert.equal(accepted({ id: CONFIG.id.toUpperCase() }).id, CONFIG.id.toUpperCase(), "capitals are a GUID too");

  // baseUrl and supportUrl
  refused({ baseUrl: "http://addins.example.org/extle/" }, /^baseUrl must start with https:\/\/ \(http:\/\/ is accepted only for localhost, with --dev\)/, { count: 1 });
  refused({ baseUrl: "http://addins.example.org/extle/" }, /^baseUrl must start with https:\/\//, { dev: true, count: 1 });
  refused({ baseUrl: "http://localhost:3000/" }, /^baseUrl points at localhost/, { count: 2 });
  for (const baseUrl of ["https://localhost:3000/", "https://127.0.0.1/", "https://[::1]:3000/", "https://extle.localhost/"]) {
    refused({ baseUrl }, /^baseUrl points at .*, which Excel on other computers cannot reach; build with --dev/, { count: 1 });
    assert.equal(accepted({ baseUrl }, { dev: true }).baseUrl, baseUrl);
  }
  assert.equal(accepted({ baseUrl: "http://localhost:3000/", supportUrl: "http://localhost:3000/help" }, { dev: true }).baseUrl, "http://localhost:3000/");
  for (const baseUrl of ["ftp://addins.example.org/", "file:///C:/extle/"]) refused({ baseUrl }, /^baseUrl must start with https:\/\/$/);
  for (const baseUrl of ["", "addins.example.org/extle", "https://", 7]) refused({ baseUrl }, /^baseUrl (must be a URL|is not a URL)/);
  refused({ baseUrl: "https://addins.example.org/extle/?v=1" }, /^baseUrl must be a folder, without \? or #/);
  refused({ baseUrl: "https://addins.example.org/extle/#top" }, /^baseUrl must be a folder, without \? or #/);
  refused({ baseUrl: "https://admin:secret@addins.example.org/extle/" }, /^baseUrl must not hold a user name or password/);
  refused({ supportUrl: "http://intranet.example.org/help" }, /^supportUrl must start with https:\/\//, { count: 1 });
  refused({ supportUrl: "https://localhost/help" }, /^supportUrl points at localhost/, { count: 1 });
  assert.equal(accepted({ baseUrl: "https://Addins.Example.org/extle" }).baseUrl, "https://addins.example.org/extle/", "a folder without its closing / gets one");
  const long = (length) => "https://addins.example.org/" + "a".repeat(length - "https://addins.example.org/".length - "/taskpane.html".length) + "/";
  assert.equal((accepted({ baseUrl: long(build.LIMITS.sourceLocation) }).baseUrl + "taskpane.html").length, build.LIMITS.sourceLocation);
  refused({ baseUrl: long(build.LIMITS.sourceLocation + 1) }, /^baseUrl is too long: .* is 2019 characters, and the manifest's SourceLocation allows 2018$/);

  // version
  for (const version of ["1.0.0.0.0", "1.0.0.123456", "v1", "1..0", "", "1.0 ", "1.0.0.0-beta", 1]) refused({ version }, /^version must be 1 to 4 numbers of at most 5 digits/, { count: 1 });
  for (const version of ["1", "1.2", "1.2.3", "1.2.3.4", "99999.0.0.99999"]) assert.equal(accepted({ version }).version, version);

  // texts
  refused({ providerName: "   " }, /^providerName is empty/);
  refused({ providerName: "Birch\tCo" }, /^providerName holds a control character/);
  refused({ providerName: "Birch \ud800 Co" }, /^providerName holds a broken character/);
  refused({ providerName: "x".repeat(126) }, /^providerName is 126 characters long; the manifest allows 125$/);
  assert.equal(accepted({ providerName: "x".repeat(125) }).providerName.length, 125);
  refused({ displayName: "x".repeat(121) }, /^displayName is 121 characters long; the manifest allows 120 here, since the ribbon button's label, "Open " and the name, may hold 125$/);
  assert.equal(accepted({ displayName: "x".repeat(120) }).displayName.length, 120);
  refused({ description: "x".repeat(251) }, /^description is 251 characters long; the manifest allows 250$/);
  assert.equal(accepted({ description: "x".repeat(250) }).description.length, 250);
  refused({ displayName: 5 }, /^displayName must be a text/);

  // keys
  refused((config) => { delete config.id; delete config.version; return config; }, /^id is missing$/, { count: 2 });
  refused({ baseURL: "https://addins.example.org/" }, /^unknown key "baseURL" \(the keys are id, baseUrl, providerName, version, supportUrl, displayName, description\)$/, { count: 1 });
  for (const config of [null, [], "extle", 3]) refused(() => config, /^the configuration must be a JSON object$/, { count: 1 });
  refused({ id: "x", baseUrl: "http://addins.example.org/", version: "one" }, /^id must be a GUID/, { count: 3 });
});

test("the example configuration builds only as a development package; the real one and the package stay out of git", () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
  assert.throws(() => build.validateConfig(example), (error) => {
    assert.deepEqual(error.problems.map((problem) => problem.split(" ")[0]), ["id", "baseUrl", "supportUrl"]);
    return true;
  });
  const dev = build.validateConfig(example, { dev: true });
  assert.equal(dev.id, build.PLACEHOLDER_IDS[0]);
  assert.equal(dev.baseUrl, "https://localhost:3000/");
  const ignored = fs.readFileSync(path.join(ADDIN, ".gitignore"), "utf8").split("\n");
  for (const line of ["package/", "extle.config.json"]) assert.ok(ignored.includes(line), line + " is not committed");
  assert.equal(ignored.includes("extle.config.example.json"), false);
});

test("a rebuild replaces its own files, keeps any other and lists it, and a development build says so", () => {
  const out = temp();
  build.buildPackage({ config: CONFIG, out });
  fs.writeFileSync(path.join(out, "excel", "pane.js"), "changed by hand");
  fs.writeFileSync(path.join(out, "excel", "old-pane.js"), "from an older version");
  fs.writeFileSync(path.join(out, "apps-script", ".clasp.json"), "{\"scriptId\":\"abc\"}");
  fs.writeFileSync(path.join(out, "apps-script", "Old.gs"), "function old() {}");
  const again = build.buildPackage({ config: { ...CONFIG, version: "1.2.0.1" }, out, dev: true });
  assert.equal(again.dev, true);
  assert.deepEqual(fs.readFileSync(path.join(out, "excel", "pane.js")), fs.readFileSync(path.join(ADDIN, "pane.js")), "the build's own file is written again");
  assert.deepEqual(again.extra, ["excel/old-pane.js", "apps-script/Old.gs"], "other files are listed, clasp's own dot file is not");
  assert.equal(fs.readFileSync(path.join(out, "apps-script", ".clasp.json"), "utf8"), "{\"scriptId\":\"abc\"}", "clasp's settings survive a rebuild");
  assert.ok(fs.existsSync(path.join(out, "excel", "old-pane.js")), "nothing is deleted");
  const manifest = fs.readFileSync(path.join(out, "excel", "manifest.xml"), "utf8");
  assert.equal(parseXml(manifest).children.find((child) => child.name === "Version").text, "1.2.0.1");
  assert.match(manifest, /A development package, for testing on this computer only\. -->/);
  remove(out);
});

test("the command line: refusals exit 1 with the problems, --dev builds the example, arguments are checked", () => {
  const script = path.join(ADDIN, "build.js");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const dir = temp();
  const out = path.join(dir, "package");
  const refused = run("--package", EXAMPLE, "--out", out);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /^build\.js: the configuration cannot be packaged:\n {2}- id 7b1f6c9a-0000-4000-8000-000000000001 is a placeholder/);
  assert.equal(fs.existsSync(out), false);
  const built = run("--package", EXAMPLE, "--out", out, "--dev");
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /^packaged extle 0\.1\.0\.0 \(development package, for this computer only\) in /);
  assert.match(built.stdout, /excel\/ {8}serve this folder at https:\/\/localhost:3000\/ and upload excel\/manifest\.xml/);
  assert.match(built.stdout, /next steps: INSTALL\.md\n$/);
  assert.ok(fs.existsSync(path.join(out, "excel", "manifest.xml")));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ id: 1 }");
  assert.match(run("--package", bad, "--out", out).stderr, /^build\.js: .*bad\.json is not JSON: /);
  assert.match(run("--package", path.join(dir, "missing.json")).stderr, /^build\.js: cannot read the configuration .*missing\.json: /);
  assert.deepEqual(build.packageArguments(["--package", "a.json", "--out", "d", "--dev"]), { configFile: "a.json", out: "d", dev: true });
  assert.throws(() => build.packageArguments(["--dev"]), /^Error: --dev needs --package FILE$/);
  assert.throws(() => build.packageArguments(["--package"]), /^Error: --package needs a value$/);
  assert.throws(() => build.packageArguments(["--package", "--dev"]), /^Error: --package needs a value$/);
  assert.throws(() => build.packageArguments(["--package", "a.json", "--zip"]), /^Error: unknown argument "--zip"; package mode takes --package FILE, --out DIR and --dev$/);
  const plain = run("--out", path.join(dir, "plain"));
  assert.equal(plain.status, 0, "the plain build is unchanged");
  assert.match(plain.stdout, /^built dist\/sheets-core\.js, apps-script\/sheets-core\.html, apps-script\/pane\.html in /);
  remove(dir);
});
