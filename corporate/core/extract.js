// Local text extraction for document filing. No dependencies: plain text is
// read as is; .docx and .xlsx are ZIP archives of XML, opened with Node's own
// zlib and stripped of their tags. Anything else (PDF included) is reported as
// unsupported with empty text, so the caller falls back to the file name.
// Nothing here throws on a bad file: a result always comes back, with `error`
// set when the file could not be read.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const LIMITS = Object.freeze({ maxBytes: 20 * 1024 * 1024, maxChars: 200000 });
const PLAIN = Object.freeze(["txt", "md", "csv", "json", "log", "text"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function extensionOf(filePath) {
  return path.extname(String(filePath == null ? "" : filePath)).slice(1).toLowerCase();
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return Object.hasOwn(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : whole;
  });
}

function stripTags(xml) {
  return decodeEntities(String(xml).replace(/<[^>]*>/g, ""));
}

function tidy(text) {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Read the entries of a ZIP archive held in a Buffer. Only what Office files
 * need: stored or deflated entries, no encryption, no ZIP64. Returns a Map of
 * entry name to a function that inflates it on demand.
 */
function readZip(buffer) {
  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;
  const minEocd = 22;
  if (buffer.length < minEocd) throw new Error("not a zip archive");
  let eocd = -1;
  for (let i = buffer.length - minEocd; i >= Math.max(0, buffer.length - minEocd - 65535); i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let position = centralOffset;
  for (let n = 0; n < count; n++) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== SIG_CENTRAL) throw new Error("damaged zip directory");
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const name = buffer.toString("utf8", position + 46, position + 46 + nameLength);
    entries.set(name, () => {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error("damaged zip entry " + name);
      const localName = buffer.readUInt16LE(localOffset + 26);
      const localExtra = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localName + localExtra;
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error("unsupported zip compression " + method + " in " + name);
    });
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Build a ZIP archive from {name: text} entries (deflated). Used by the tests
 * and the simulator to make small .docx and .xlsx files without fixtures.
 */
function zipArchive(files, options) {
  const store = !!(options && options.store);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const data = store ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(store ? 0 : 8, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));
    parts.push(local, nameBytes, data);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, directory, end]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Word: paragraphs become lines, tabs and breaks are kept. */
function docxText(entries) {
  const open = entries.get("word/document.xml");
  if (!open) throw new Error("no word/document.xml");
  const xml = open().toString("utf8");
  // Inside a table, cells become tab-separated columns and rows become lines.
  const withBreaks = xml
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>(\s*<\/w:tc>)/g, "$1")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  return stripTags(withBreaks);
}

/** Excel: shared strings and inline strings per cell, rows as lines, sheets separated by a blank line. */
function xlsxText(entries) {
  const sharedXml = entries.has("xl/sharedStrings.xml") ? entries.get("xl/sharedStrings.xml")().toString("utf8") : "";
  const shared = [];
  for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(stripTags(match[1].replace(/<\/t>/g, "")));
  }
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sheets.length) throw new Error("no worksheets");
  const blocks = [];
  for (const name of sheets) {
    const xml = entries.get(name)().toString("utf8");
    const rows = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] || "";
        const body = cell[2] || "";
        const type = (/\bt="([^"]*)"/.exec(attrs) || [])[1] || "";
        let value = "";
        if (type === "s") {
          const index = Number(stripTags((/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1] || ""));
          value = Number.isInteger(index) && shared[index] != null ? shared[index] : "";
        } else if (type === "inlineStr") {
          value = stripTags((/<is>([\s\S]*?)<\/is>/.exec(body) || [, ""])[1]);
        } else {
          value = stripTags((/<v>([\s\S]*?)<\/v>/.exec(body) || [, ""])[1]);
        }
        cells.push(value);
      }
      if (cells.some((c) => c !== "")) rows.push(cells.join("\t").replace(/\t+$/, ""));
    }
    blocks.push(rows.join("\n"));
  }
  return blocks.join("\n\n");
}

/**
 * Extract the text of a file for classification and field detection.
 * @returns {{text:string, kind:string, ext:string, unsupported:boolean, truncated:boolean, bytes:number, error:(string|null)}}
 */
function extractText(filePath, limits) {
  const settings = Object.assign({}, LIMITS, limits || {});
  const ext = extensionOf(filePath);
  const result = { text: "", kind: "unsupported", ext, unsupported: true, truncated: false, bytes: 0, error: null };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    result.error = error.message;
    return result;
  }
  result.bytes = stat.size;
  const kind = PLAIN.includes(ext) ? "text" : ext === "docx" ? "docx" : ext === "xlsx" ? "xlsx" : null;
  if (!kind) return result;
  result.kind = kind;
  result.unsupported = false;
  if (stat.size > settings.maxBytes) {
    result.error = "file is larger than " + settings.maxBytes + " bytes; only its name was used";
    return result;
  }
  let text;
  try {
    const buffer = fs.readFileSync(filePath);
    if (kind === "text") text = buffer.toString("utf8");
    else {
      const entries = readZip(buffer);
      text = kind === "docx" ? docxText(entries) : xlsxText(entries);
    }
  } catch (error) {
    result.error = "could not read " + kind + ": " + error.message;
    return result;
  }
  text = tidy(text);
  if (text.length > settings.maxChars) {
    text = text.slice(0, settings.maxChars);
    result.truncated = true;
  }
  result.text = text;
  return result;
}

module.exports = { LIMITS, PLAIN, extensionOf, extractText, readZip, zipArchive, stripTags, decodeEntities };
