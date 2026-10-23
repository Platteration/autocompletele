// Regular expressions written in the organisation policy (filing fields, reply
// extractors, forms lookups and window titles, guard internal codes, sheets
// column rules, capture rules) run on what people type, copy and file. A
// pattern that backtracks catastrophically would freeze the desk from the
// person's own typing, so policy patterns are treated as untrusted input:
//
// 1. At policy load, check() refuses the shapes that backtrack exponentially
//    (a quantified group that itself holds an unbounded quantifier, an
//    unbounded quantifier over an alternation, backreferences), patterns
//    longer than 256 characters and more than four unbounded quantifiers.
//    The pattern is dropped with a policy warning, so `actle-admin sign`
//    refuses it too.
// 2. At run time, exec/test/matchAll cap the text a pattern sees and go
//    through a runner. The default runner calls the regular expression
//    directly (the add-in's browser bundle has nothing else); the desk
//    installs a runner with a time budget (desktop/pattern-runner.js). A
//    pattern that runs out of time is disabled for the rest of the session
//    and reported once.
//
// Pure: no Node built-ins, so the extle add-in can bundle it.
"use strict";

const LIMITS = Object.freeze({ maxPatternLength: 256, maxUnbounded: 4, largeRepeat: 32, maxInput: 10000 });

const cache = new Map();
const disabled = new Map();
let runner = null;
let onDisabled = null;

/**
 * Find the backtracking shapes in a pattern. Returns null when none is found,
 * or the reason. A small scanner, not a full parser: it tracks groups,
 * character classes, escapes and quantifiers, which is all the check needs.
 */
function unsafeShape(source) {
  const frames = [{ unbounded: false, alternation: false }];
  let total = 0;
  let last = null; // the atom a quantifier would apply to: { group: frame | null }
  let i = 0;
  const quantifierAt = (at) => {
    const ch = source[at];
    if (ch === "*" || ch === "+") return { length: 1, max: Infinity };
    if (ch === "?") return { length: 1, max: 1 };
    if (ch === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      if (!m) return null;
      const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
      return { length: m[0].length, max };
    }
    return null;
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (/[1-9]/.test(next || "") || (next === "k" && source[i + 2] === "<")) return "backreferences are not allowed";
      if ((next === "p" || next === "P" || next === "u") && source[i + 2] === "{") {
        const end = source.indexOf("}", i + 2);
        i = end < 0 ? source.length : end + 1;
      } else {
        i += 2;
      }
      last = { group: null };
    } else if (ch === "[") {
      i += 1;
      if (source[i] === "^") i += 1;
      if (source[i] === "]") i += 1;
      while (i < source.length && source[i] !== "]") i += source[i] === "\\" ? 2 : 1;
      i += 1;
      last = { group: null };
    } else if (ch === "(") {
      frames.push({ unbounded: false, alternation: false });
      i += 1;
      if (source[i] === "?") {
        // (?: (?= (?! (?<= (?<! (?<name>
        if (source[i + 1] === "<" && source[i + 2] !== "=" && source[i + 2] !== "!") {
          const end = source.indexOf(">", i);
          i = end < 0 ? source.length : end + 1;
        } else {
          i += source[i + 1] === "<" ? 3 : 2;
        }
      }
      last = null;
    } else if (ch === ")") {
      const frame = frames.length > 1 ? frames.pop() : frames[0];
      i += 1;
      last = { group: frame };
    } else if (ch === "|") {
      frames[frames.length - 1].alternation = true;
      i += 1;
      last = null;
    } else {
      const q = last ? quantifierAt(i) : null;
      if (!q) {
        i += 1;
        last = ch === "^" || ch === "$" ? null : { group: null };
        continue;
      }
      i += q.length;
      if (source[i] === "?") i += 1; // lazy
      const unbounded = q.max === Infinity || q.max > LIMITS.largeRepeat;
      const group = last.group;
      if (group && group.unbounded && q.max > 1) return "a repeated group holds a repeated part (nested quantifiers backtrack exponentially)";
      if (group && group.alternation && unbounded) return "a repeated group holds alternatives (they can backtrack exponentially)";
      if (unbounded) total += 1;
      if (total > LIMITS.maxUnbounded) return "more than " + LIMITS.maxUnbounded + " unbounded repeats";
      if (unbounded || (group && group.unbounded)) frames[frames.length - 1].unbounded = true;
      last = null;
    }
  }
  return null;
}

/** null when the pattern may be used, else the reason it is refused. */
function check(source, flags) {
  const text = String(source == null ? "" : source);
  if (!text) return "empty pattern";
  if (text.length > LIMITS.maxPatternLength) return "longer than " + LIMITS.maxPatternLength + " characters";
  try {
    new RegExp(text, flags || "");
  } catch (error) {
    return "invalid pattern (" + error.message + ")";
  }
  return unsafeShape(text);
}

function key(source, flags) {
  return flags + "\u0000" + source;
}

function compiled(source, flags) {
  const k = key(source, flags);
  let re = cache.get(k);
  if (!re) {
    re = new RegExp(source, flags);
    if (cache.size > 500) cache.clear();
    cache.set(k, re);
  }
  return re;
}

function capped(text, maxInput) {
  const s = String(text == null ? "" : text);
  const max = Number.isFinite(maxInput) && maxInput > 0 ? maxInput : LIMITS.maxInput;
  return s.length > max ? s.slice(0, max) : s;
}

/** Run one operation through the installed runner; a pattern that ran out of time is disabled. */
function run(op, source, flags, text, maxInput) {
  const k = key(source, flags);
  if (disabled.has(k)) return null;
  const re = compiled(source, flags);
  re.lastIndex = 0;
  const input = capped(text, maxInput);
  if (!runner) return direct(op, re, input);
  const result = runner(op, re, input);
  if (result && result.timedOut) {
    disabled.set(k, true);
    if (typeof onDisabled === "function") onDisabled(source, flags);
    return null;
  }
  return result ? result.value : null;
}

function direct(op, re, input) {
  if (op === "exec") return re.exec(input);
  if (op === "test") return re.test(input);
  return Array.from(input.matchAll(re));
}

/** First match of a policy pattern in text (capped), or null. */
function exec(source, flags, text, maxInput) {
  return run("exec", String(source), flags || "", text, maxInput);
}

function test(source, flags, text, maxInput) {
  return run("test", String(source), flags || "", text, maxInput) === true;
}

/** Every match; the flags must include "g". */
function matchAll(source, flags, text, maxInput) {
  const f = flags && flags.includes("g") ? flags : (flags || "") + "g";
  return run("matchAll", String(source), f, text, maxInput) || [];
}

/**
 * Install the runner the desk uses: (op, regex, text) -> { value } or
 * { timedOut: true }. `notify(source, flags)` hears about a pattern that was
 * disabled. Pass null to go back to direct calls (tests).
 */
function setRunner(fn, notify) {
  runner = typeof fn === "function" ? fn : null;
  onDisabled = typeof notify === "function" ? notify : null;
}

function reset() {
  cache.clear();
  disabled.clear();
}

module.exports = { LIMITS, check, unsafeShape, exec, test, matchAll, setRunner, reset, disabledPatterns: () => [...disabled.keys()] };
