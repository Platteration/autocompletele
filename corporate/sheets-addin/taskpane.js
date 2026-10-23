// extle for Excel: the Office.js bridge behind pane.js. Reads the
// active cell's displayed text, its column's header from row 1 and the
// column's displayed values from the used range; writes completions as text
// (number format "@") so a date or a code is not reinterpreted by the cell.
// In a strict column it replaces aliases cell by cell and turns Excel's own
// list validation on or off (ExcelApi 1.8; where Excel lacks it, the pane
// does not offer it).
// The bridge is exposed as window.ActleSheetsExcel so it can be driven with
// a fake Excel and Office (corporate/sheets-addin/test/hosts.test.js); the
// real Office.js and Excel were not run here, see README.md.
(function (root) {
  "use strict";

  const MAX_ROWS = 5000; // rows of one column read per selection change; more would make every click slow
  const SETTING = "actleSheetsConfig";
  const SHEET_ROWS = 1048576; // rows of a worksheet (Excel's specifications and limits); list validation covers row 2 to here
  // The longest list written into a validation rule, commas included. Not in the Office.js reference; Excel's
  // Source box and the libraries that write .xlsx files take 255, and a longer list is reported lost on reopening.
  const LIST_SOURCE_MAX = 255;
  const VALIDATION_SET = ["ExcelApi", "1.8"]; // Range.dataValidation

  function readContext() {
    return Excel.run(async (context) => {
      const cell = context.workbook.getActiveCell();
      cell.load("address, text, rowIndex, columnIndex");
      const sheet = cell.worksheet;
      sheet.load("name");
      const used = sheet.getUsedRangeOrNullObject(true);
      used.load("rowIndex, rowCount");
      await context.sync();
      const header = sheet.getRangeByIndexes(0, cell.columnIndex, 1, 1);
      header.load("text");
      let column = null;
      let clipped = false;
      if (!used.isNullObject) {
        const from = Math.max(used.rowIndex, 1); // row 1 (index 0) is the header
        const available = used.rowIndex + used.rowCount - from;
        clipped = available > MAX_ROWS;
        if (available > 0) {
          column = sheet.getRangeByIndexes(from, cell.columnIndex, Math.min(available, MAX_ROWS), 1);
          column.load("text, rowIndex");
        }
      }
      await context.sync();
      const values = [];
      const rows = []; // the 1-based row of each value, for a column check
      // The selected cell's own text is what is being completed, not a value to learn from.
      if (column) {
        column.text.forEach((row, i) => {
          if (column.rowIndex + i === cell.rowIndex) return;
          values.push(row[0]);
          rows.push(column.rowIndex + i + 1);
        });
      }
      return { sheet: sheet.name, address: cell.address.split("!").pop(), text: cell.text[0][0], header: header.text[0][0], values, rows, clipped };
    });
  }

  function range(context, target) {
    return context.workbook.worksheets.getItem(target.sheet).getRange(target.address);
  }

  function writeValue(target, value) {
    return Excel.run(async (context) => {
      const cell = range(context, target);
      cell.numberFormat = [["@"]];
      cell.values = [[String(value)]];
      await context.sync();
    });
  }

  function writeRows(target, rows) {
    return Excel.run(async (context) => {
      const cell = range(context, target);
      cell.load("rowIndex, columnIndex");
      await context.sync();
      const block = cell.worksheet.getRangeByIndexes(cell.rowIndex, cell.columnIndex, rows.length, rows[0].length);
      // Text cells are written as text; numbers and booleans keep the general format.
      block.numberFormat = rows.map((row) => row.map((value) => (typeof value === "string" ? "@" : "General")));
      block.values = rows;
      await context.sync();
    });
  }

  function writeFormula(target, formula) {
    return Excel.run(async (context) => {
      range(context, target).formulas = [[formula]];
      await context.sync();
    });
  }

  /**
   * Write the list's spelling into cells of one column, as text. Each cell is
   * read again first; one whose text is no longer what the check read is
   * skipped and returned with its text now. changes: [{ row, from, to }].
   */
  function replaceValues(target, changes) {
    return Excel.run(async (context) => {
      const sheet = context.workbook.worksheets.getItem(target.sheet);
      const top = Math.min(...changes.map((change) => change.row));
      const bottom = Math.max(...changes.map((change) => change.row));
      const now = sheet.getRange(target.column + top + ":" + target.column + bottom);
      now.load("text");
      await context.sync();
      const written = [];
      const skipped = [];
      for (const change of changes) {
        const text = now.text[change.row - top][0];
        if (text !== change.from) {
          skipped.push({ row: change.row, text });
          continue;
        }
        const cell = sheet.getRange(target.column + change.row);
        cell.numberFormat = [["@"]];
        cell.values = [[String(change.to)]];
        written.push(change.row);
      }
      await context.sync();
      return { written, skipped };
    });
  }

  /** Why Excel cannot take this list in a validation rule, or null. */
  function listRefusal(values) {
    const comma = values.find((value) => value.includes(","));
    if (comma) return "the value " + JSON.stringify(comma) + " holds a comma, and Excel reads the list in a validation rule as values separated by commas";
    const length = values.join(",").length;
    return length > LIST_SOURCE_MAX ? "it is " + length + " characters long with its commas, and Excel takes at most " + LIST_SOURCE_MAX + " in a validation rule" : null;
  }

  function belowHeader(column) {
    return column + "2:" + column + SHEET_ROWS;
  }

  /** Excel's own list validation on the column from row 2 down: a dropdown, and a stop alert for any other value. Replaces what was there. */
  function setListValidation(target, values, message) {
    return Excel.run(async (context) => {
      const address = belowHeader(target.column);
      const range = context.workbook.worksheets.getItem(target.sheet).getRange(address);
      range.dataValidation.clear();
      range.dataValidation.rule = { list: { inCellDropDown: true, source: values.join(",") } };
      range.dataValidation.errorAlert = { showAlert: true, style: "Stop", title: "extle", message: String(message || "") };
      await context.sync();
      return { range: address };
    });
  }

  /** Clears every data validation rule on the column from row 2 down, not only one set here. */
  function clearListValidation(target) {
    return Excel.run(async (context) => {
      const address = belowHeader(target.column);
      context.workbook.worksheets.getItem(target.sheet).getRange(address).dataValidation.clear();
      await context.sync();
      return { range: address };
    });
  }

  function loadConfig() {
    return Promise.resolve(Office.context.document.settings.get(SETTING) || "");
  }

  function saveConfig(text) {
    return new Promise((resolve, reject) => {
      Office.context.document.settings.set(SETTING, String(text || ""));
      Office.context.document.settings.saveAsync((result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) resolve();
        else reject(new Error((result.error && result.error.message) || "the document settings were not saved"));
      });
    });
  }

  function onSelectionChanged(handler) {
    Office.context.document.addHandlerAsync(Office.EventType.DocumentSelectionChanged, () => handler());
  }

  /** What Office.onReady calls: builds the pane in #pane, or says why not. */
  function start(info) {
    const pane = document.getElementById("pane");
    if (!info || info.host !== Office.HostType.Excel) {
      pane.textContent = "extle runs in Excel. Open this pane from an Excel workbook.";
      return null;
    }
    let storage = null;
    try {
      storage = root.localStorage || null;
    } catch (error) {
      storage = null;
    }
    // Where Excel lacks the API set, the pane leaves list validation out instead of the manifest asking for more.
    const validation = Office.context.requirements.isSetSupported(VALIDATION_SET[0], VALIDATION_SET[1]);
    const created = root.ActleSheetsPane.createPane({
      document,
      root: pane,
      core: root.ActleSheets,
      storage,
      bridge: {
        readContext, writeValue, writeRows, writeFormula, replaceValues, loadConfig, saveConfig, onSelectionChanged,
        listValidation: validation ? { refusal: listRefusal, apply: setListValidation, remove: clearListValidation } : null,
        listValidationMissing: validation ? "" : "List validation is not offered: this Excel does not have " + VALIDATION_SET.join(" ") + ".",
      },
    });
    created.start().catch((error) => { pane.textContent = "extle could not start: " + ((error && error.message) || error); });
    return created;
  }

  root.ActleSheetsExcel = { MAX_ROWS, SETTING, SHEET_ROWS, LIST_SOURCE_MAX, readContext, writeValue, writeRows, writeFormula, replaceValues, listRefusal, setListValidation, clearListValidation, loadConfig, saveConfig, onSelectionChanged, start };
  if (typeof Office !== "undefined" && Office && typeof Office.onReady === "function") Office.onReady(start);
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
