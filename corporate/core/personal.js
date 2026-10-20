// The business edition shares the personal edition's matching, placeholder,
// template and search logic rather than copying it. A rule change in the extension's
// DOM-free modules therefore reaches both editions, and the shared conformance
// suite in ../../shared runs here as well (see test/conformance.test.js).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// In the repository the personal modules are two folders up. A packaged desktop
// app carries a copy next to this folder instead (desktop/package.json,
// "build.extraResources"), so both places are tried.
const SOURCES = [
  path.join(__dirname, "..", "..", "chrome-extension", "src"),
  path.join(__dirname, "..", "chrome-extension", "src"),
];

function load(name) {
  const dir = SOURCES.find((candidate) => fs.existsSync(path.join(candidate, name)));
  if (!dir) {
    const error = new Error("cannot find chrome-extension/src/" + name + " next to " + __dirname);
    error.code = "MODULE_NOT_FOUND";
    throw error;
  }
  return require(path.join(dir, name));
}

const expander = load("expander.js");
const template = load("template.js");
const palette = load("palette.js");

module.exports = { expander, template, palette };
