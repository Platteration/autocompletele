// Group names: a desk's groups in deployment.json and a collection's
// audience in the policy. Kept in a module of its own because both the policy
// parser and the policy fetcher need it and the fetcher is required by the
// parser's lookups.
"use strict";

// "*" fails the pattern on purpose: only code can ask for every collection.
const GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Group names from a string or a list: trimmed, lower-cased, deduplicated; what did not fit is reported. */
function groupNames(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const names = [];
  const rejected = [];
  for (const item of list) {
    const name = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (!name || !GROUP_PATTERN.test(name)) rejected.push(item);
    else if (!names.includes(name)) names.push(name);
  }
  return { names, rejected };
}

module.exports = { GROUP_PATTERN, groupNames };
