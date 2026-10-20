// Decides, per application, how much of what a person types the assistant may
// look at. Three modes:
//   off      – nothing is read; no expansion either.
//   triggers – a short rolling buffer is matched against triggers and never
//              stored (the same behaviour as the personal Windows app).
//   learn    – the text typed in that application is kept, scrubbed, so the
//              phrase miner can propose shortcuts. Only applications a person
//              or an organisation policy lists explicitly get this mode.
"use strict";

const MODES = Object.freeze(["off", "triggers", "learn"]);
const DEFAULT_MODE = "triggers";

// Applications that never enter learn mode, whatever a rule says. Threat: the
// learning corpus is written to disk; a password manager's or terminal's
// keystrokes landing there would turn the assistant into a credential log.
const NEVER_LEARN_PROCESSES = Object.freeze([
  "1password", "keepass", "keepassxc", "bitwarden", "lastpass", "dashlane", "nordpass", "enpass",
  "cmd", "powershell", "pwsh", "windowsterminal", "wt", "terminal", "iterm", "iterm2", "gnome-terminal",
  "konsole", "alacritty", "kitty", "xterm", "mstsc", "credentialuibroker", "consent", "gnome-keyring",
]);
const SENSITIVE_TITLE = /\b(?:password|passcode|passphrase|sign ?in|log ?in|two[- ]factor|2fa|one[- ]time|verification code|security code|credential)/i;

function asText(value) {
  return String(value == null ? "" : value).trim();
}

function baseName(process) {
  const name = asText(process).toLowerCase().replace(/\\/g, "/");
  const last = name.slice(name.lastIndexOf("/") + 1);
  return last.replace(/\.(?:exe|app)$/, "");
}

function list(value) {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const one = asText(value);
  return one ? [one] : [];
}

function regex(pattern) {
  const source = asText(pattern);
  if (!source) return null;
  try {
    return new RegExp(source, "i");
  } catch (error) {
    return null;
  }
}

/** Normalise one application rule; returns null (and a warning) when unusable. */
function normalizeRule(raw, warnings, index) {
  if (!raw || typeof raw !== "object") {
    warnings.push("capture rule " + index + " ignored: not an object");
    return null;
  }
  const match = raw.match && typeof raw.match === "object" ? raw.match : raw;
  const rule = {
    id: asText(raw.id) || "app-" + index,
    label: asText(raw.label),
    mode: MODES.includes(raw.mode) ? raw.mode : DEFAULT_MODE,
    processes: list(match.process).map(baseName).filter(Boolean),
    bundleIds: list(match.bundleId).map((id) => id.toLowerCase()),
    titlePattern: asText(match.title),
  };
  if (rule.titlePattern && !regex(rule.titlePattern)) {
    warnings.push("capture rule " + rule.id + " ignored: invalid title pattern");
    return null;
  }
  if (!rule.processes.length && !rule.bundleIds.length && !rule.titlePattern) {
    warnings.push("capture rule " + rule.id + " ignored: it matches no application");
    return null;
  }
  if (!rule.label) rule.label = rule.processes[0] || rule.bundleIds[0] || rule.titlePattern;
  return rule;
}

/** Build a policy from {defaultMode, apps:[...]}; invalid rules are skipped, never fatal. */
function createPolicy(config) {
  const source = config && typeof config === "object" ? config : {};
  const warnings = [];
  const apps = (Array.isArray(source.apps) ? source.apps : [])
    .map((raw, index) => normalizeRule(raw, warnings, index))
    .filter(Boolean);
  const defaultMode = MODES.includes(source.defaultMode) ? source.defaultMode : DEFAULT_MODE;
  return { defaultMode, apps, warnings };
}

function ruleMatches(rule, context) {
  const process = baseName(context.process);
  if (process && rule.processes.includes(process)) return true;
  const bundleId = asText(context.bundleId).toLowerCase();
  if (bundleId && rule.bundleIds.includes(bundleId)) return true;
  if (rule.titlePattern) {
    const pattern = regex(rule.titlePattern);
    if (pattern && pattern.test(asText(context.title))) return true;
  }
  return false;
}

/** True when the focused window looks like a credential prompt or a tool that handles secrets. */
function isSensitiveContext(context) {
  const ctx = context && typeof context === "object" ? context : {};
  if (ctx.secureInput === true || ctx.passwordField === true) return true;
  if (NEVER_LEARN_PROCESSES.includes(baseName(ctx.process))) return true;
  return SENSITIVE_TITLE.test(asText(ctx.title));
}

/**
 * Decide the mode for a focused window.
 * @returns {{mode:string, reason:string, rule:object|null}}
 */
function decide(context, policy) {
  const ctx = context && typeof context === "object" ? context : {};
  const pol = policy && Array.isArray(policy.apps) ? policy : createPolicy(policy);
  if (ctx.secureInput === true || ctx.passwordField === true) {
    return { mode: "off", reason: "secure input field", rule: null };
  }
  const rule = pol.apps.find((candidate) => ruleMatches(candidate, ctx)) || null;
  let mode = rule ? rule.mode : pol.defaultMode;
  let reason = rule ? "rule " + rule.id : "default";
  if (mode === "learn" && isSensitiveContext(ctx)) {
    mode = "triggers";
    reason = "learning is never enabled for credential prompts, password managers or terminals";
  }
  return { mode, reason, rule };
}

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
const SECRET_LABEL = /\b(password|passwd|passcode|passphrase|pwd|pin|secret|token|api[ _-]?key|otp)\b(\s*(?:[:=]|is)\s*)(\S+)/gi;
const TOKEN = /(?<![\w\/@.-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![\w\/@.-])/g;

/** True when the text contains a card number that passes the Luhn check. */
function containsCardNumber(text) {
  const source = String(text == null ? "" : text);
  for (const match of source.matchAll(CARD)) {
    if (luhn(match[0].replace(/[ -]/g, ""))) return true;
  }
  return false;
}

/**
 * Mask things that must never reach the learning corpus. Threat: a card number
 * or a pasted token typed into an email client in learn mode would otherwise
 * be written to disk and could be proposed back as a "frequent phrase".
 * @returns {{text:string, redactions:number}}
 */
function scrub(text) {
  let redactions = 0;
  let out = String(text == null ? "" : text);
  out = out.replace(CARD, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (!luhn(digits)) return match;
    redactions++;
    return "[card]";
  });
  out = out.replace(SECRET_LABEL, (match, label, sep) => {
    redactions++;
    return label + sep + "[redacted]";
  });
  out = out.replace(TOKEN, () => {
    redactions++;
    return "[token]";
  });
  return { text: out, redactions };
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  NEVER_LEARN_PROCESSES,
  baseName,
  createPolicy,
  decide,
  isSensitiveContext,
  ruleMatches,
  containsCardNumber,
  luhn,
  scrub,
};
