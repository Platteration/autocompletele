// The business edition shares the personal edition's matching, placeholder,
// template and search logic rather than copying it. A rule change in the extension's
// DOM-free modules therefore reaches both editions, and the shared conformance
// suite in ../../shared runs here as well (see test/conformance.test.js).
"use strict";

const expander = require("../../chrome-extension/src/expander.js");
const template = require("../../chrome-extension/src/template.js");
const palette = require("../../chrome-extension/src/palette.js");

module.exports = { expander, template, palette };
