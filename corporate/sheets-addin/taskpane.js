// extle for Excel: the Office.js bridge behind pane.js. Reads the
// active cell's displayed text, its column's header from row 1 and the
// column's displayed values from the used range; writes completions as text
// (number format "@") so a date or a code is not reinterpreted by the cell.
// The bridge is exposed as window.ActleSheetsExcel so it can be driven with
// a fake Excel and Office (corporate/sheets-addin/test/hosts.test.js); the
// real Office.js and Excel were not run here, see README.md.
(function (root) {
  "use strict";

  const MAX_ROWS = 5000; // rows of one column read per selection change; more would make every click slow
  const SETTING = "actleSheetsConfig";

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
      // The selected cell's own text is what is being completed, not a value to learn from.
      if (column) column.text.forEach((row, i) => { if (column.rowIndex + i !== cell.rowIndex) values.push(row[0]); });
      return { sheet: sheet.name, address: cell.address.split("!").pop(), text: cell.text[0][0], header: header.text[0][0], values, clipped };
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
    const created = root.ActleSheetsPane.createPane({
      document,
      root: pane,
      core: root.ActleSheets,
      storage,
      bridge: { readContext, writeValue, writeRows, writeFormula, loadConfig, saveConfig, onSelectionChanged },
    });
    created.start().catch((error) => { pane.textContent = "extle could not start: " + ((error && error.message) || error); });
    return created;
  }

  root.ActleSheetsExcel = { MAX_ROWS, SETTING, readContext, writeValue, writeRows, writeFormula, loadConfig, saveConfig, onSelectionChanged, start };
  if (typeof Office !== "undefined" && Office && typeof Office.onReady === "function") Office.onReady(start);
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
