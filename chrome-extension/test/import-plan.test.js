const test = require("node:test");
const assert = require("node:assert/strict");
const { planImport, mergeImport } = require("../src/import-plan.js");

test("import plan separates additions, updates and unchanged triggers", () => {
  const current = [
    { trigger: "sig/", expansion: "Old signature" },
    { trigger: "brb/", expansion: "Be right back" },
  ];
  const incoming = [
    { trigger: "sig/", expansion: "New signature" },
    { trigger: "brb/", expansion: "Be right back" },
    { trigger: "ty/", expansion: "Thank you!" },
  ];

  const plan = planImport(current, incoming);
  assert.equal(plan.incomingCount, 3);
  assert.equal(plan.changedCount, 2);
  assert.deepEqual(plan.additions, [{ trigger: "ty/", expansion: "Thank you!" }]);
  assert.deepEqual(plan.updates, [
    { trigger: "sig/", before: "Old signature", after: "New signature" },
  ]);
  assert.deepEqual(plan.unchanged, [{ trigger: "brb/", expansion: "Be right back" }]);
});

test("merge keeps local-only shorthands while updating matching triggers", () => {
  const current = [
    { id: "1", trigger: "local/", expansion: "Keep me", order: 1 },
    { id: "2", trigger: "sig/", expansion: "Old", order: 2 },
  ];
  const incoming = [
    { trigger: "sig/", expansion: "New" },
    { trigger: "new/", expansion: "Brand new" },
  ];

  assert.deepEqual(mergeImport(current, incoming), [
    { trigger: "local/", expansion: "Keep me" },
    { trigger: "sig/", expansion: "New" },
    { trigger: "new/", expansion: "Brand new" },
  ]);
});

test("helpers tolerate missing lists", () => {
  assert.deepEqual(planImport(null, undefined), {
    additions: [], updates: [], unchanged: [], incomingCount: 0, changedCount: 0,
  });
  assert.deepEqual(mergeImport(undefined, null), []);
});
