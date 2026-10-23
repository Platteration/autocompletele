// extle for Google Sheets: the server side of the sidebar. Reads the
// active cell's displayed text, its column's header from row 1 and the
// column's displayed values; writes completions as text so a date or a code
// is not reinterpreted. The configuration lives in the document's properties.
// In a strict column it replaces aliases cell by cell and turns the
// spreadsheet's own list validation on or off.
// Driven with fake services in corporate/sheets-addin/test/hosts.test.js;
// not run against Google here (no account in the build environment), see README.md.

var CONFIG_KEY = "actleSheetsConfig";
var CHUNK_BYTES = 8192;   // a document property holds at most 9 KB, measured in bytes, so chunks are cut by UTF-8 size
var MAX_ROWS_CAP = 20000; // the sidebar asks for 5000; an odd client cannot ask for the whole sheet

function onOpen() {
  SpreadsheetApp.getUi().createMenu("extle").addItem("Open sidebar", "showSidebar").addToUi();
}

function showSidebar() {
  var page = HtmlService.createTemplateFromFile("Sidebar").evaluate().setTitle("extle");
  SpreadsheetApp.getUi().showSidebar(page);
}

/** Lets Sidebar.html pull in the generated includes: <?!= include("sheets-core") ?>. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** The selection as the pane needs it: displayed texts, never raw dates or numbers. */
function getActiveCellContext(maxRows) {
  var limit = Math.min(Math.max(1, Math.floor(Number(maxRows)) || 5000), MAX_ROWS_CAP);
  var sheet = SpreadsheetApp.getActiveSheet();
  var cell = sheet.getActiveCell();
  var row = cell.getRow();
  var column = cell.getColumn();
  var lastRow = sheet.getLastRow();
  var available = Math.max(0, lastRow - 1);
  var values = [];
  var rows = []; // the row of each value, for a column check
  if (available > 0) {
    var texts = sheet.getRange(2, column, Math.min(available, limit), 1).getDisplayValues();
    for (var i = 0; i < texts.length; i++) {
      // The selected cell's own text is what is being completed, not a value to learn from.
      if (i + 2 === row) continue;
      values.push(texts[i][0]);
      rows.push(i + 2);
    }
  }
  return {
    sheet: sheet.getName(),
    address: cell.getA1Notation(),
    text: cell.getDisplayValue(),
    header: sheet.getRange(1, column).getDisplayValue(),
    values: values,
    rows: rows,
    clipped: available > limit,
  };
}

function sheetFor(target) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(String(target.sheet));
  if (!sheet) throw new Error("sheet " + target.sheet + " is gone");
  return sheet;
}

function rangeOf(target) {
  return sheetFor(target).getRange(String(target.address));
}

function writeValue(target, value) {
  var range = rangeOf(target);
  range.setNumberFormat("@");
  range.setValue(String(value));
}

function writeRows(target, rows) {
  var start = rangeOf(target);
  var block = start.getSheet().getRange(start.getRow(), start.getColumn(), rows.length, rows[0].length);
  block.setNumberFormats(rows.map(function (row) {
    return row.map(function (value) { return typeof value === "string" ? "@" : "General"; });
  }));
  block.setValues(rows);
}

function writeFormula(target, formula) {
  rangeOf(target).setFormula(String(formula));
}

/**
 * Write the list's spelling into cells of one column, as text. Each cell is
 * read again first; one whose displayed text is no longer what the check read
 * is skipped and returned with its text now. changes: [{ row, from, to }].
 */
function replaceValues(target, changes) {
  var sheet = sheetFor(target);
  var column = String(target.column);
  var rows = changes.map(function (change) { return Number(change.row); });
  var top = Math.min.apply(null, rows);
  var bottom = Math.max.apply(null, rows);
  var now = sheet.getRange(column + top + ":" + column + bottom).getDisplayValues();
  var written = [];
  var skipped = [];
  for (var i = 0; i < changes.length; i++) {
    var change = changes[i];
    var text = now[change.row - top][0];
    if (text !== change.from) {
      skipped.push({ row: change.row, text: text });
      continue;
    }
    var cell = sheet.getRange(column + change.row);
    cell.setNumberFormat("@");
    cell.setValue(String(change.to));
    written.push(change.row);
  }
  return { written: written, skipped: skipped };
}

/** The column from row 2 to the sheet's last row, as A1 notation; rows added later are not included. */
function belowHeader(sheet, column) {
  var last = sheet.getMaxRows();
  if (last < 2) throw new Error("the sheet has no rows below the header");
  return String(column) + "2:" + String(column) + last;
}

/** The spreadsheet's own list validation: a dropdown, and any other value refused. Replaces what was there. */
function setListValidation(target, values) {
  var sheet = sheetFor(target);
  var a1 = belowHeader(sheet, target.column);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(values.map(String), true).setAllowInvalid(false).build();
  sheet.getRange(a1).setDataValidation(rule);
  return { range: a1 };
}

/** Clears every data validation rule on the column from row 2 down, not only one set here. */
function clearListValidation(target) {
  var sheet = sheetFor(target);
  var a1 = belowHeader(sheet, target.column);
  sheet.getRange(a1).clearDataValidations();
  return { range: a1 };
}

/**
 * Cut text into pieces of at most `limit` UTF-8 bytes, never between the two
 * halves of a surrogate pair. Property values are measured in bytes, so 8,000
 * characters of Cyrillic (16,000 bytes) would not fit one property.
 */
function chunkByBytes(text, limit) {
  var chunks = [];
  var start = 0;
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    var low = code >= 0xdc00 && code <= 0xdfff;
    var size = code < 0x80 ? 1 : code < 0x800 ? 2 : low || (code >= 0xd800 && code <= 0xdbff) ? 2 : 3;
    if (bytes + size > limit) {
      var cut = low ? i - 1 : i; // a low surrogate follows its high half into the next chunk
      if (cut > start) {
        chunks.push(text.slice(start, cut));
        start = cut;
        bytes = low ? 2 : 0;
      }
    }
    bytes += size;
  }
  chunks.push(text.slice(start));
  return chunks;
}

/** The saved configuration, or "" when there is none or a chunk is missing (the sidebar then uses the browser's copy). */
function loadConfig() {
  var properties = PropertiesService.getDocumentProperties();
  var count = Number(properties.getProperty(CONFIG_KEY + ".count")) || 0;
  var parts = [];
  for (var i = 0; i < count; i++) {
    var part = properties.getProperty(CONFIG_KEY + "." + i);
    if (part === null || part === undefined) return "";
    parts.push(part);
  }
  return parts.join("");
}

/**
 * Keep the configuration in the document's properties. The count is set to 0
 * first and to the real number last, so a write that fails halfway leaves no
 * configuration rather than a mix of old and new chunks.
 */
function saveConfig(text) {
  var properties = PropertiesService.getDocumentProperties();
  var value = String(text || "");
  var previous = Number(properties.getProperty(CONFIG_KEY + ".count")) || 0;
  var chunks = value ? chunkByBytes(value, CHUNK_BYTES) : [];
  properties.setProperty(CONFIG_KEY + ".count", "0");
  for (var i = 0; i < chunks.length; i++) properties.setProperty(CONFIG_KEY + "." + i, chunks[i]);
  for (var j = chunks.length; j < previous; j++) properties.deleteProperty(CONFIG_KEY + "." + j);
  properties.setProperty(CONFIG_KEY + ".count", String(chunks.length));
}
