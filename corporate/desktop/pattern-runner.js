// The desk's runner for policy patterns (core/policy-pattern.js): each match
// runs in a vm context with a time budget, so a pattern the static check let
// through but that still backtracks for too long is interrupted instead of
// freezing the key hook. Each guarded call costs about a third of a
// millisecond; policy patterns run at word ends, on focus changes, on a
// copied message or a new document, never on every key.
"use strict";

const vm = require("node:vm");

const DEFAULT_BUDGET_MS = 50;

function createPatternRunner(options) {
  const budget = Math.max(1, Math.floor(Number(options && options.budgetMs) || DEFAULT_BUDGET_MS));
  const context = vm.createContext(Object.create(null));
  const scripts = {
    exec: new vm.Script("re.exec(text)"),
    test: new vm.Script("re.test(text)"),
    matchAll: new vm.Script("Array.from(text.matchAll(re))"),
  };
  return function run(op, re, text) {
    const script = scripts[op];
    if (!script) return { value: null };
    context.re = re;
    context.text = text;
    try {
      return { value: script.runInContext(context, { timeout: budget }) };
    } catch (error) {
      if (error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { timedOut: true };
      throw error;
    } finally {
      context.re = null;
      context.text = null;
    }
  };
}

module.exports = { DEFAULT_BUDGET_MS, createPatternRunner };
