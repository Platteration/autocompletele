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
  policyPattern: require("./policy-pattern.js"),
  extract: require("./extract.js"),
  filer: require("./filer.js"),
  paletteSearch: require("./palette-search.js"),
  // Suite modules: Reply, Sheets, Forms, Guard and Notes (desktop/apps/ holds their shells).
  reply: require("./reply.js"),
  sheets: require("./sheets.js"),
  forms: require("./forms.js"),
  guard: require("./guard.js"),
  notes: require("./notes.js"),
  orgPolicy: require("./org-policy.js"),
  policySigning: require("./policy-signing.js"),
  policySource: require("./policy-source.js"),
  engine: require("./engine.js"),
  report: require("./report.js"),
  suggestions: require("./suggestions.js"),
  store: require("./store.js"),
  cryptoBox: require("./crypto-box.js"),
};
