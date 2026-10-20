#!/usr/bin/env node
// Checks an unpacked electron-builder output (dist/<platform>-unpacked or the
// .app's Contents folder) for the layout main.js relies on: the shell inside
// app.asar, the core next to it and the personal modules next to the core.
// Usage: node scripts/check-package.js dist/linux-unpacked
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function resourcesDir(dir) {
  for (const candidate of [path.join(dir, "resources"), path.join(dir, "Resources"), path.join(dir, "Contents", "Resources")]) {
    if (fs.existsSync(path.join(candidate, "app.asar"))) return candidate;
  }
  return null;
}

/** Returns the problems found; an empty list means the package has everything main.js needs. */
function check(dir) {
  const problems = [];
  const resources = resourcesDir(dir);
  if (!resources) return ["no resources folder with app.asar under " + dir];
  for (const file of ["core/index.js", "core/personal.js", "chrome-extension/src/expander.js", "chrome-extension/src/template.js", "chrome-extension/src/palette.js"]) {
    if (!fs.existsSync(path.join(resources, file))) problems.push("missing " + path.join(resources, file));
  }
  if (problems.length) return problems;
  // The core must load from its packaged place, which is how the asar's main.js reaches it.
  const probe = spawnSync(process.execPath, ["-e", "const c = require(process.argv[1]); if (!c.personal.expander || !c.personal.template || !c.personal.palette) throw new Error('personal modules missing'); console.log(Object.keys(c).length)", path.join(resources, "core", "index.js")], { encoding: "utf8" });
  if (probe.status !== 0) problems.push("core does not load from " + resources + ": " + (probe.stderr || "").trim());
  return problems;
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/check-package.js <unpacked app folder>");
    process.exit(2);
  }
  const problems = check(path.resolve(dir));
  for (const problem of problems) console.error("problem: " + problem);
  if (!problems.length) console.log("package layout ok: " + path.resolve(dir));
  process.exit(problems.length ? 1 : 0);
}

module.exports = { check, resourcesDir };
