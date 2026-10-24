// cactle: the shape of a plan on the desk. Pure helpers over
// core/forms.js plans: the blanks a record asks for, the Tab presses between
// the steps of a plan (the shell moves through a form with Tab only), and
// the plan popover's height from what it will show. No Electron, no state.
"use strict";

const { template } = require("../../../core/personal.js");

// Popover height: the fixed parts, then per step its padding and border, 21 px per
// line of "label: value" (about 70 characters at 540 px), 17 px per sub-line
// ("needs ...", "Tab over ..."), and an input row per blank of the record, since a
// reference typed later can open every one of them.
const SIZE = Object.freeze({ width: 540, base: 230, step: 14, line: 21, sub: 17, blank: 62, max: 700, charsPerLine: 70 });

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The names of the [[blanks]] in a record's values, each once, in order of appearance. */
function blanksOf(record) {
  return [...new Set(Object.values(record.fields).flatMap((text) => template.fields(text).map((field) => field.name)))];
}

/**
 * The Tab presses before each step: the caret starts in the form's first
 * field, and every field without a value between two steps costs one Tab.
 * Without a form the record's own fields follow each other.
 */
function withTabs(steps, fields) {
  let caret = 0;
  let typed = false;
  return steps.map((step) => {
    const index = fields.findIndex((field) => field.name === step.field);
    const over = fields.slice(typed ? caret + 1 : caret, index).map((field) => field.label);
    const out = { field: step.field, label: step.label, value: step.value, missing: step.missing.slice(), source: step.source, tabs: index - caret, over };
    caret = index;
    typed = true;
    return out;
  });
}

/** The popover's size from the state it opens with; an unknown state gets the fixed parts only. */
function size(action) {
  const plan = action && isObject(action.plan) ? action.plan : {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const blanks = action && isObject(action.record) && Array.isArray(action.record.blanks) ? action.record.blanks.length : 0;
  let height = SIZE.base + SIZE.blank * blanks;
  for (const step of steps) {
    const text = String(step && step.label || "") + ": " + String(step && step.value || "");
    height += SIZE.step + SIZE.line * Math.max(1, Math.ceil(text.length / SIZE.charsPerLine));
    if (step && Array.isArray(step.missing) && step.missing.length) height += SIZE.sub;
    if (step && Array.isArray(step.over) && step.over.length) height += SIZE.sub;
  }
  return { width: SIZE.width, height: Math.min(SIZE.max, height) };
}

module.exports = { SIZE, blanksOf, withTabs, size };
