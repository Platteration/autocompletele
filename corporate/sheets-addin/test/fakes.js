// Headless stand-ins for what the add-in runs against: a document whose
// elements record what the pane builds, an Excel workbook behind Office.js,
// a Google Sheets spreadsheet behind SpreadsheetApp and PropertiesService, and
// google.script.run. Each records the calls made and keeps a grid of display
// text, so the bridges can be driven without Excel, Office.js or a Google
// account. Used by the tests here and by corporate/test/sheets-app.test.js.
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
 * spec: { sheets: { name: [[display text]] }, active: { sheet, address }, settings: {}, failSave: "reason" }
 */
function fakeExcel(spec) {
  const calls = [];
  const settings = new Map(Object.entries(spec.settings || {}));
  const grids = {};
  for (const [name, rows] of Object.entries(spec.sheets)) grids[name] = rows.map((row) => row.slice());
  let active = Object.assign({}, spec.active);
  const handlers = [];
  const state = { syncs: 0, loads: [] };

  function range(sheet, grid, r, c, rows, cols) {
    const quoted = /\s/.test(sheet.name) ? "'" + sheet.name + "'" : sheet.name;
    const address = quoted + "!" + colName(c) + (r + 1) + (rows > 1 || cols > 1 ? ":" + colName(c + cols - 1) + (r + rows) : "");
    const obj = {
      worksheet: sheet, rowIndex: r, columnIndex: c, rowCount: rows, columnCount: cols, isNullObject: false, address,
      get text() { return Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => cellText(grid, r + i, c + j))); },
      load: (props) => state.loads.push([address, props]),
    };
    for (const prop of ["numberFormat", "values", "formulas"]) {
      Object.defineProperty(obj, prop, { set(value) {
        calls.push([prop, address, plain(value)]);
        if (prop !== "numberFormat") value.forEach((row, i) => row.forEach((cell, j) => { (grid[r + i] = grid[r + i] || [])[c + j] = cell; }));
      } });
    }
    return obj;
  }

  function worksheet(name) {
    const grid = grids[name];
    if (!grid) throw new Error("worksheet " + name + " not found");
    const sheet = { name, load: (props) => state.loads.push(["sheet " + name, props]) };
    sheet.getRangeByIndexes = (r, c, rows, cols) => range(sheet, grid, r, c, rows, cols);
    sheet.getRange = (ref) => { const at = parseA1(ref); return range(sheet, grid, at.row, at.col, 1, 1); };
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
    sync: async () => { state.syncs++; },
  };
  const Excel = { run: (fn) => Promise.resolve().then(() => fn(context)) };
  const Office = {
    ready: null,
    onReady: (callback) => { Office.ready = callback; },
    HostType: { Excel: "Excel", Word: "Word" },
    EventType: { DocumentSelectionChanged: "documentSelectionChanged" },
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    context: { document: {
      settings: {
        get: (key) => (settings.has(key) ? settings.get(key) : null),
        set: (key, value) => { settings.set(key, value); },
        saveAsync: (callback) => { calls.push(["saveAsync"]); callback(spec.failSave ? { status: "failed", error: { message: spec.failSave } } : { status: "succeeded" }); },
      },
      addHandlerAsync: (type, handler) => { handlers.push([type, handler]); },
    } },
  };
  return { Excel, Office, calls, settings, state, grids, handlers, select: (sheet, address) => { active = { sheet, address }; return Promise.all(handlers.map(([, h]) => h())); } };
}

/**
 * A Google spreadsheet behind the Apps Script services Code.gs touches.
 * spec: { sheets: { name: [[display text]] }, active: { sheet, row, col } (1-based), properties: {}, limit: bytes per property, failAt: nth setProperty throws }
 */
function fakeAppsScript(spec) {
  const calls = [];
  const grids = {};
  for (const [name, rows] of Object.entries(spec.sheets || {})) grids[name] = rows.map((row) => row.slice());
  let active = Object.assign({}, spec.active);
  const props = new Map(Object.entries(spec.properties || {}));
  const limit = spec.limit || 9216;
  const ui = { menus: [], sidebars: [] };
  let sets = 0;

  function rangeOf(name, row, col, rows, cols) {
    const grid = grids[name];
    const a1 = colName(col - 1) + row + (rows > 1 || cols > 1 ? ":" + colName(col + cols - 2) + (row + rows - 1) : "");
    const text = (r, c) => cellText(grid, r - 1, c - 1);
    const write = (values) => values.forEach((line, i) => line.forEach((cell, j) => { (grid[row - 1 + i] = grid[row - 1 + i] || [])[col - 1 + j] = cell; }));
    const self = {
      getRow: () => row, getColumn: () => col, getSheet: () => sheetOf(name), getA1Notation: () => a1,
      getDisplayValue: () => text(row, col),
      getDisplayValues: () => Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => text(row + i, col + j))),
      setNumberFormat: (format) => { calls.push(["setNumberFormat", a1, format]); return self; },
      setNumberFormats: (formats) => { calls.push(["setNumberFormats", a1, plain(formats)]); return self; },
      setValue: (value) => { calls.push(["setValue", a1, value]); write([[value]]); return self; },
      setValues: (values) => { calls.push(["setValues", a1, plain(values)]); write(values); return self; },
      setFormula: (formula) => { calls.push(["setFormula", a1, formula]); return self; },
    };
    return self;
  }

  function sheetOf(name) {
    const grid = grids[name];
    if (!grid) return null;
    return {
      getName: () => name,
      getLastRow: () => { const box = usedBox(grid); return box ? box.bottom + 1 : 0; },
      getActiveCell: () => rangeOf(name, active.row, active.col, 1, 1),
      getRange: (a, b, c, d) => {
        if (typeof a === "string") { const at = parseA1(a); return rangeOf(name, at.row + 1, at.col + 1, 1, 1); }
        return rangeOf(name, a, b, c || 1, d || 1);
      },
    };
  }

  const SpreadsheetApp = {
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
  return { globals: { SpreadsheetApp, HtmlService, PropertiesService }, calls, props, ui, grids, select: (sheet, row, col) => { active = { sheet, row, col }; } };
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

module.exports = { Node, fakeDocument, document, el, sandboxed, plain, storageOf, colName, parseA1, fakeExcel, fakeAppsScript, fakeGoogleRun };
