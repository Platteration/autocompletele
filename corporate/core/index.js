// Public surface of the business-edition core. Everything is plain CommonJS
// with no dependencies beyond Node's standard library and the personal
// edition's DOM-free modules.
"use strict";

module.exports = {
  personal: require("./personal.js"),
  metrics: require("./metrics.js"),
  capturePolicy: require("./capture-policy.js"),
  diff: require("./diff.js"),
  variableDetector: require("./variable-detector.js"),
  phraseMiner: require("./phrase-miner.js"),
  keywordRules: require("./keyword-rules.js"),
  documents: require("./documents.js"),
  orgPolicy: require("./org-policy.js"),
  engine: require("./engine.js"),
  store: require("./store.js"),
};
