// Word-level diff used by the variable detector and the overlay that shows
// which parts of similar messages change. Small inputs only (messages, not
// documents), so a plain longest-common-subsequence table is fine.
"use strict";

const TOKEN = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu;
const MAX_CELLS = 400000;

/** Split text into words, whitespace runs and single punctuation marks. */
function tokenize(text) {
  const source = String(text == null ? "" : text);
  return source.match(TOKEN) || [];
}

function isSpace(token) {
  return /^\s+$/.test(token);
}

/** Length of the longest common subsequence of two token arrays. */
function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  if (a.length * b.length > MAX_CELLS) return 0;
  let prev = new Array(b.length + 1).fill(0);
  let cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Diff two token arrays.
 * @returns {Array<{type:"equal"|"replace"|"insert"|"delete", a:string[], b:string[], aStart:number, aEnd:number}>}
 *   aStart/aEnd index into `a`; an insert has aStart === aEnd.
 */
function diff(a, b) {
  const left = Array.isArray(a) ? a : tokenize(a);
  const right = Array.isArray(b) ? b : tokenize(b);
  if (left.length * right.length > MAX_CELLS) {
    return left.length || right.length
      ? [{ type: "replace", a: left.slice(), b: right.slice(), aStart: 0, aEnd: left.length }]
      : [];
  }
  const n = left.length;
  const m = right.length;
  const table = new Array(n + 1);
  for (let i = 0; i <= n; i++) table[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  let pendingA = [];
  let pendingB = [];
  let pendingStart = 0;
  const flush = () => {
    if (!pendingA.length && !pendingB.length) return;
    const type = pendingA.length && pendingB.length ? "replace" : pendingA.length ? "delete" : "insert";
    ops.push({ type, a: pendingA, b: pendingB, aStart: pendingStart, aEnd: pendingStart + pendingA.length });
    pendingA = [];
    pendingB = [];
  };
  while (i < n || j < m) {
    if (i < n && j < m && left[i] === right[j]) {
      flush();
      const last = ops[ops.length - 1];
      if (last && last.type === "equal") {
        last.a.push(left[i]);
        last.b.push(right[j]);
        last.aEnd++;
      } else {
        ops.push({ type: "equal", a: [left[i]], b: [right[j]], aStart: i, aEnd: i + 1 });
      }
      i++;
      j++;
      continue;
    }
    if (!pendingA.length && !pendingB.length) pendingStart = i;
    if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
      pendingB.push(right[j]);
      j++;
    } else {
      pendingA.push(left[i]);
      i++;
    }
  }
  flush();
  return ops;
}

/** 0..1 similarity of two texts by shared word tokens (whitespace ignored). */
function similarity(a, b) {
  const left = tokenize(a).filter((t) => !isSpace(t));
  const right = tokenize(b).filter((t) => !isSpace(t));
  if (!left.length && !right.length) return 1;
  if (!left.length || !right.length) return 0;
  return 2 * lcsLength(left, right) / (left.length + right.length);
}

module.exports = { tokenize, isSpace, lcsLength, diff, similarity };
