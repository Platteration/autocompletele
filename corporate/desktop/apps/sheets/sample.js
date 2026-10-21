// The sample sheets section the simulator walks through. It is also the
// section proposed for corporate/shared/org-policy.example.json (which has
// none yet), so the simulation will match what the example documents.
"use strict";

const SAMPLE_SECTION = Object.freeze({
  vocabularies: {
    customers: {
      values: ["Acme Logistics GmbH", "Birch & Co", "Northern Acme Ltd", "Zed Transport"],
      aliases: { ACME: "Acme Logistics GmbH", Birch: "Birch & Co", NAL: "Northern Acme Ltd" },
    },
    costCentres: {
      values: ["CC-100 Logistics", "CC-200 Sales", "CC-300 Warehouse"],
      aliases: { Sales: "CC-200 Sales" },
    },
  },
  columns: [
    { match: { header: "^(customer|client)", sheet: "^Orders" }, vocabulary: "customers" },
    { match: { header: "^cost cent" }, vocabulary: "costCentres" },
    { match: { header: "notes?$" }, kind: "notes" },
  ],
  blocks: [
    { trigger: "/exp", label: "Expense rows", rows: [["Date", "Amount", "Cost centre"], ["", 0, ""]] },
    { trigger: "/vat", label: "VAT at 19%", formula: "=ROUND(B2*0.19, 2)" },
  ],
});

module.exports = { SAMPLE_SECTION };
