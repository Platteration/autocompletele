// The business edition shares the personal edition's matching, placeholder and
// template logic rather than copying it. A rule change in the extension's
// DOM-free modules therefore reaches both editions, and the shared conformance
// suite in ../../shared runs here as well (see test/conformance.test.js).
"use strict";

const expander = require("../../chrome-extension/src/expander.js");
const template = require("../../chrome-extension/src/template.js");

module.exports = { expander, template };
