// Headless stand-ins for what the add-in runs against: a document whose
// elements record what the pane builds, an Excel workbook behind Office.js,
// a Google Sheets spreadsheet behind SpreadsheetApp and PropertiesService, and
// google.script.run. Each records the calls made and keeps a grid of cell
// values, read back as text, so the bridges can be driven without Excel,
// Office.js or a Google account. Used by the tests here and by corporate/test/sheets-app.test.js.
"use strict";

const fs = require("node:fs");
const vm = require("node:vm");

class Node {
  constructor(tag) { Object.assign(this, { tagName: tag, children: [], attrs: {}, listeners: {}, className: "", value: "", own: "" }); }
  append(...items) { for (const item of items) this.children.push(typeof item === "string" ? Object.assign(new Node("#text"), { own: item }) : item); }
  set textContent(value) { this.children = []; this.own = String(value); }
  get textContent() { return this.own + this.children.map((c) => c.textContent).join(""); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  async fire(type, event) { for (const fn of this.listeners[type] || []) await fn(event || {}); }
  click() { return this.fire("click"); }
  all(test, out = []) { if (test(this)) out.push(this); for (const c of this.children) c.all(test, out); return out; }
  find(test) { return this.all(test)[0] || null; }
  button(label) { return this.find((n) => n.tagName === "button" && n.textContent === label); }
  // One focus for all fake documents: the element focus() was last called on, as document.activeElement.
  focus() { focused.node = this; }
}

const focused = { node: null };

/** A document with one element the pages look up by id ("pane"). */
function fakeDocument(ids) {
  const byId = Object.assign({}, ids || {});
  return { createElement: (tag) => new Node(tag), getElementById: (id) => byId[id] || null, byId, get activeElement() { return focused.node; } };
}

const document = fakeDocument();

function el(tag, attrs, children) {
  const node = new Node(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children || []) node.append(child);
  return node;
}

/** Run a browser script in its own realm, with self and window pointing at the sandbox plus the globals given. */
function sandboxed(file, globals) {
  const sandbox = Object.assign({}, globals || {});
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.runInContext(fs.readFileSync(file, "utf8"), vm.createContext(sandbox), { filename: file });
  return sandbox;
}

// Plain data for cross-realm comparisons: objects made inside a vm context have another Object.prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

function storageOf(initial) {
  const map = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

function colName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** "B4" -> 0-based { row: 3, col: 1 }. */
function parseA1(ref) {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(String(ref).trim());
  if (!match) throw new Error("not a cell reference: " + ref);
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

/** "B4" or "B3:C7" -> 0-based { row, col, rows, cols }. */
function parseRange(ref) {
  const [first, last] = String(ref).split(":");
  const a = parseA1(first);
  const b = last == null ? a : parseA1(last);
  if (b.row < a.row || b.col < a.col) throw new Error("not a range: " + ref);
  return { row: a.row, col: a.col, rows: b.row - a.row + 1, cols: b.col - a.col + 1 };
}

/** "1.10" > "1.9": requirement set versions compare part by part. */
function versionAtLeast(have, want) {
  const a = String(have).split(".").map(Number);
  const b = String(want).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

function cellText(grid, row, col) {
  return grid[row] && grid[row][col] != null ? String(grid[row][col]) : "";
}

/** The bounding box of the non-empty cells, 0-based, or null for an empty grid. */
function usedBox(grid) {
  let box = null;
  grid.forEach((row, r) => row.forEach((cell, c) => {
    if (cell == null || cell === "") return;
    box = box ? { top: Math.min(box.top, r), left: Math.min(box.left, c), bottom: Math.max(box.bottom, r), right: Math.max(box.right, c) } : { top: r, left: c, bottom: r, right: c };
  }));
  return box;
}

/**
 * An Excel workbook behind the Office.js objects taskpane.js touches.
 * spec: { sheets: { name: [[value]] } (a string, number or boolean; text gives it as a string), active: { sheet, address }, settings: {}, failSave: "reason",
 *         apiSets: { ExcelApi: "1.17" } (what isSetSupported answers; ExcelApi 1.17 when not given),
 *         formulas: { name: { A1: "=..." } } (Range.formulas of those cells; any other cell gives its value, as documented),
 *         spills: { name: { A1: anchor A1 } } (cells a dynamic array spills into, for getSpillParentOrNullObject),
 *         protect: { name: [A1] } (a write to one of these cells stops the batch: the commands after it are not run
 *         and context.sync() rejects with the trace messages run before it, as OfficeExtension.Error documents),
 *         refuseRule: "message" (setting dataValidation.rule stops the batch the same way; read when the rule is set) }
 * validations: address -> { rule, errorAlert } as Range.dataValidation was last set; clear() deletes the address.
 */
function fakeExcel(spec) {
  const calls = [];
  const settings = new Map(Object.entries(spec.settings || {}));
  const grids = {};
  for (const [name, rows] of Object.entries(spec.sheets)) grids[name] = rows.map((row) => row.slice());
  let active = Object.assign({}, spec.active);
  const handlers = [];
  const state = { syncs: 0, loads: [], spillLookups: [] };
  const validations = {};
  const apiSets = spec.apiSets || { ExcelApi: "1.17" };
  // Formulas by sheet, keyed "row,col" (0-based); a cell without one reads as its value.
  const formulas = {};
  for (const [name, cells] of Object.entries(spec.formulas || {})) {
    formulas[name] = new Map(Object.entries(cells).map(([a1, formula]) => { const at = parseA1(a1); return [at.row + "," + at.col, formula]; }));
  }
  // The batch since the last sync: once a command fails, the ones after it are not run.
  const batch = { failed: null, traces: [] };

  function range(sheet, grid, r, c, rows, cols) {
    const quoted = /\s/.test(sheet.name) ? "'" + sheet.name + "'" : sheet.name;
    const address = quoted + "!" + colName(c) + (r + 1) + (rows > 1 || cols > 1 ? ":" + colName(c + cols - 1) + (r + rows) : "");
    const own = formulas[sheet.name] = formulas[sheet.name] || new Map();
    const obj = {
      worksheet: sheet, rowIndex: r, columnIndex: c, rowCount: rows, columnCount: cols, isNullObject: false, address,
      get text() { return Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => cellText(grid, r + i, c + j))); },
      load: (props) => state.loads.push([address, props]),
      // Range.getSpillParentOrNullObject (ExcelApi 1.12): the anchor of a single cell a dynamic array spills into.
      getSpillParentOrNullObject: () => {
        const anchor = rows === 1 && cols === 1 && spec.spills && spec.spills[sheet.name] ? Object.entries(spec.spills[sheet.name]).find(([a1]) => { const at = parseA1(a1); return at.row === r && at.col === c; }) : null;
        state.spillLookups.push(address);
        return anchor ? { isNullObject: false, address: anchor[1], load: () => {} } : { isNullObject: true, load: () => {} };
      },
    };
    const protectedCell = () => Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => [r + i, c + j])).flat().some(([pr, pc]) => (spec.protect && spec.protect[sheet.name] || []).some((a1) => { const at = parseA1(a1); return at.row === pr && at.col === pc; }));
    for (const prop of ["numberFormat", "values", "formulas"]) {
      Object.defineProperty(obj, prop, {
        // Only formulas is read back: a cell's formula, or its value when it has none ("If a cell has no formula, its value
        // is returned instead"), so a number stays a number; an empty cell gives "".
        get: prop !== "formulas" ? undefined : () => Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => {
          if (own.has((r + i) + "," + (c + j))) return own.get((r + i) + "," + (c + j));
          const value = grid[r + i] ? grid[r + i][c + j] : null;
          return value == null ? "" : value;
        })),
        set(value) {
          if (batch.failed) return; // not run: an earlier command of this batch failed
          if (protectedCell()) { batch.failed = new Error("the cell " + address + " is protected"); return; }
          calls.push([prop, address, plain(value)]);
          if (prop === "numberFormat") return;
          value.forEach((row, i) => row.forEach((cell, j) => {
            (grid[r + i] = grid[r + i] || [])[c + j] = cell;
            if (prop === "formulas") own.set((r + i) + "," + (c + j), cell);
            else own.delete((r + i) + "," + (c + j));
          }));
        },
      });
    }
    // Range.dataValidation (ExcelApi 1.8): clear(), and the rule and errorAlert set as plain objects, run in batch order.
    const validation = { clear: () => {
      if (batch.failed) return;
      calls.push(["dataValidation.clear", address]);
      delete validations[address];
    } };
    for (const prop of ["rule", "errorAlert"]) {
      Object.defineProperty(validation, prop, { set(value) {
        if (batch.failed) return;
        if (prop === "rule" && spec.refuseRule) { batch.failed = new Error(spec.refuseRule); return; }
        calls.push(["dataValidation." + prop, address, plain(value)]);
        validations[address] = Object.assign({}, validations[address], { [prop]: plain(value) });
      } });
    }
    obj.dataValidation = validation;
    return obj;
  }

  function worksheet(name) {
    const grid = grids[name];
    if (!grid) throw new Error("worksheet " + name + " not found");
    const sheet = { name, load: (props) => state.loads.push(["sheet " + name, props]) };
    sheet.getRangeByIndexes = (r, c, rows, cols) => range(sheet, grid, r, c, rows, cols);
    sheet.getRange = (ref) => { const at = parseRange(ref); return range(sheet, grid, at.row, at.col, at.rows, at.cols); };
    sheet.getUsedRangeOrNullObject = () => {
      const box = usedBox(grid);
      return box ? range(sheet, grid, box.top, box.left, box.bottom - box.top + 1, box.right - box.left + 1) : { isNullObject: true, load() {} };
    };
    return sheet;
  }

  const context = {
    workbook: {
      getActiveCell: () => { const at = parseA1(active.address); return range(worksheet(active.sheet), grids[active.sheet], at.row, at.col, 1, 1); },
      worksheets: { getItem: worksheet },
    },
    // OfficeExtension.ClientRequestContext.trace: a message run in order with the batch's commands.
    trace: (message) => { if (!batch.failed) batch.traces.push(String(message)); },
    sync: async () => {
      state.syncs++;
      const failed = batch.failed;
      const traces = batch.traces.splice(0);
      batch.failed = null;
      if (failed) throw Object.assign(failed, { traceMessages: traces });
    },
  };
  const Excel = { run: (fn) => Promise.resolve().then(() => fn(context)) };
  const Office = {
    ready: null,
    onReady: (callback) => { Office.ready = callback; },
    HostType: { Excel: "Excel", Word: "Word" },
    EventType: { DocumentSelectionChanged: "documentSelectionChanged" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    context: { requirements: { isSetSupported: (name, version) => Object.hasOwn(apiSets, name) && versionAtLeast(apiSets[name], version == null ? "1.1" : version) }, document: {
      settings: {
        get: (key) => (settings.has(key) ? settings.get(key) : null),
        set: (key, value) => { settings.set(key, value); },
        saveAsync: (callback) => { calls.push(["saveAsync"]); callback(spec.failSave ? { status: "failed", error: { message: spec.failSave } } : { status: "succeeded" }); },
      },
      addHandlerAsync: (type, handler) => { handlers.push([type, handler]); },
    } },
  };
  return { Excel, Office, calls, settings, state, grids, handlers, validations, formulas, select: (sheet, address) => { active = { sheet, address }; return Promise.all(handlers.map(([, h]) => h())); } };
}

/**
 * A Google spreadsheet behind the Apps Script services Code.gs touches.
 * spec: { sheets: { name: [[display text]] }, active: { sheet, row, col } (1-based), properties: {}, limit: bytes per property, failAt: nth setProperty throws,
 *         maxRows: { name: rows } (Sheet.getMaxRows; 1000 or the grid's length when not given), refuseRule: "message" (setDataValidation throws),
 *         formulas: { name: { A1: "=..." } } (Range.getFormulas of those cells; "" for any other cell),
 *         protect: { name: [A1] } (setNumberFormat and setValue on one of these cells throw) }
 * validations: name -> { A1: DataValidation } as Range.setDataValidation left them; clearDataValidations() deletes the A1 key.
 */
function fakeAppsScript(spec) {
  const calls = [];
  const grids = {};
  for (const [name, rows] of Object.entries(spec.sheets || {})) grids[name] = rows.map((row) => row.slice());
  let active = Object.assign({}, spec.active);
  const props = new Map(Object.entries(spec.properties || {}));
  const limit = spec.limit || 9216;
  const ui = { menus: [], sidebars: [] };
  const validations = {};
  let sets = 0;
  // Formulas by sheet, keyed by single-cell A1.
  const formulas = {};
  for (const [name, cells] of Object.entries(spec.formulas || {})) formulas[name] = new Map(Object.entries(cells));

  function rangeOf(name, row, col, rows, cols) {
    const grid = grids[name];
    const a1 = colName(col - 1) + row + (rows > 1 || cols > 1 ? ":" + colName(col + cols - 2) + (row + rows - 1) : "");
    const text = (r, c) => cellText(grid, r - 1, c - 1);
    const own = formulas[name] = formulas[name] || new Map();
    const at = (r, c) => colName(c - 1) + r;
    const write = (values) => values.forEach((line, i) => line.forEach((cell, j) => { (grid[row - 1 + i] = grid[row - 1 + i] || [])[col - 1 + j] = cell; own.delete(at(row + i, col + j)); }));
    const guard = () => {
      const locked = (spec.protect && spec.protect[name]) || [];
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) if (locked.includes(at(row + i, col + j))) throw new Error(at(row + i, col + j) + " is protected");
    };
    const self = {
      getRow: () => row, getColumn: () => col, getSheet: () => sheetOf(name), getA1Notation: () => a1,
      getDisplayValue: () => text(row, col),
      getDisplayValues: () => Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => text(row + i, col + j))),
      getFormulas: () => Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => own.get(at(row + i, col + j)) || "")),
      setNumberFormat: (format) => { guard(); calls.push(["setNumberFormat", a1, format]); return self; },
      setNumberFormats: (formats) => { calls.push(["setNumberFormats", a1, plain(formats)]); return self; },
      setValue: (value) => { guard(); calls.push(["setValue", a1, value]); write([[value]]); return self; },
      setValues: (values) => { calls.push(["setValues", a1, plain(values)]); write(values); return self; },
      setFormula: (formula) => { calls.push(["setFormula", a1, formula]); own.set(a1, String(formula)); return self; },
      setDataValidation: (rule) => {
        if (spec.refuseRule) throw new Error(spec.refuseRule);
        calls.push(["setDataValidation", a1, rule.describe()]);
        (validations[name] = validations[name] || {})[a1] = rule;
        return self;
      },
      clearDataValidations: () => { calls.push(["clearDataValidations", a1]); if (validations[name]) delete validations[name][a1]; return self; },
    };
    return self;
  }

  function sheetOf(name) {
    const grid = grids[name];
    if (!grid) return null;
    return {
      getName: () => name,
      getLastRow: () => { const box = usedBox(grid); return box ? box.bottom + 1 : 0; },
      getMaxRows: () => (spec.maxRows && spec.maxRows[name] != null ? spec.maxRows[name] : Math.max(1000, grid.length)),
      getActiveCell: () => rangeOf(name, active.row, active.col, 1, 1),
      getRange: (a, b, c, d) => {
        if (typeof a === "string") { const at = parseRange(a); return rangeOf(name, at.row + 1, at.col + 1, at.rows, at.cols); }
        return rangeOf(name, a, b, c || 1, d || 1);
      },
    };
  }

  // SpreadsheetApp.newDataValidation(): the builder calls Code.gs makes, and a DataValidation with the documented getters.
  const VALUE_IN_LIST = "VALUE_IN_LIST";
  function newDataValidation() {
    const made = { criteria: null, values: [], allowInvalid: true };
    const builder = {
      requireValueInList: (values, showDropdown) => { Object.assign(made, { criteria: VALUE_IN_LIST, values: [values.slice(), showDropdown !== false] }); return builder; },
      setAllowInvalid: (allow) => { made.allowInvalid = !!allow; return builder; },
      build: () => {
        const rule = { getCriteriaType: () => made.criteria, getCriteriaValues: () => made.values.slice(), getAllowInvalid: () => made.allowInvalid };
        rule.describe = () => plain({ criteria: made.criteria, values: made.values, allowInvalid: made.allowInvalid });
        return rule;
      },
    };
    return builder;
  }
  const SpreadsheetApp = {
    DataValidationCriteria: { VALUE_IN_LIST },
    newDataValidation,
    getActiveSheet: () => sheetOf(active.sheet),
    getActiveSpreadsheet: () => ({ getSheetByName: sheetOf }),
    getUi: () => ({
      createMenu: (title) => { const menu = { title, items: [], addItem(label, fn) { menu.items.push([label, fn]); return menu; }, addToUi() { ui.menus.push(menu); } }; return menu; },
      showSidebar: (page) => { ui.sidebars.push(page); },
    }),
  };
  const HtmlService = {
    createTemplateFromFile: (name) => ({ evaluate: () => ({ setTitle: (title) => ({ file: name, title }) }) }),
    createHtmlOutputFromFile: (name) => ({ getContent: () => "<!-- include " + name + " -->" }),
  };
  const properties = {
    getProperty: (key) => (props.has(key) ? props.get(key) : null),
    setProperty: (key, value) => {
      sets++;
      if (spec.failAt && sets === spec.failAt) throw new Error("property write failed");
      if (Buffer.byteLength(String(value), "utf8") > limit) throw new Error("value of " + key + " exceeds " + limit + " bytes");
      props.set(key, String(value));
      calls.push(["setProperty", key, String(value).length]);
    },
    deleteProperty: (key) => { props.delete(key); calls.push(["deleteProperty", key]); },
  };
  const PropertiesService = { getDocumentProperties: () => properties };
  return { globals: { SpreadsheetApp, HtmlService, PropertiesService }, calls, props, ui, grids, validations, formulas, select: (sheet, row, col) => { active = { sheet, row, col }; } };
}

/**
 * google.script.run over a set of server functions. With deferred: true the
 * calls wait until flush(), so a slow answer can be made to arrive late.
 */
function fakeGoogleRun(server, options) {
  const settings = options || {};
  const pending = [];
  const calls = [];
  function runner(success, failure) {
    const out = { withSuccessHandler: (fn) => runner(fn, failure), withFailureHandler: (fn) => runner(success, fn) };
    for (const name of Object.keys(server)) {
      out[name] = (...args) => {
        calls.push([name, ...plain(args)]);
        const job = () => { try { success(server[name](...args)); } catch (error) { failure({ message: error.message }); } };
        if (settings.deferred) pending.push(job);
        else job();
      };
    }
    return out;
  }
  return { run: runner(() => {}, () => {}), calls, pending, flush: (count) => { pending.splice(0, count == null ? pending.length : count).forEach((job) => job()); } };
}

module.exports = { Node, fakeDocument, document, el, sandboxed, plain, storageOf, colName, parseA1, parseRange, fakeExcel, fakeAppsScript, fakeGoogleRun };
