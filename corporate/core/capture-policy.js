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
// The engine also keeps no field text and runs no keyword or app checks in
// them (see decide's `sensitive` flag): what is typed at a no-echo password
// prompt must not be held in memory or offered back on the clipboard.
// These are the ones actle recognises by name; a terminal or prompt missing
// here is treated like any other window (see also SENSITIVE_TITLE).
const NEVER_LEARN_PROCESSES = Object.freeze([
  // Password managers and keyrings.
  "1password", "keepass", "keepassxc", "keepassx", "keeweb", "bitwarden", "lastpass", "dashlane", "nordpass", "enpass",
  "keeper", "keeperpasswordmanager", "roboform", "seahorse", "kwalletmanager5", "kwalletmanager", "gnome-keyring",
  // Terminals and SSH clients.
  "cmd", "powershell", "pwsh", "windowsterminal", "wt", "openconsole", "conhost", "terminal", "iterm", "iterm2",
  "gnome-terminal", "gnome-terminal-server", "konsole", "alacritty", "kitty", "xterm", "xfce4-terminal", "mate-terminal",
  "tilix", "terminator", "foot", "wezterm", "wezterm-gui", "kgx", "ptyxis", "urxvt", "urxvtd", "rxvt", "lxterminal",
  "qterminal", "sakura", "guake", "yakuake", "tilda", "st", "cool-retro-term", "deepin-terminal", "ghostty", "warp",
  "warp-terminal", "hyper", "tabby", "putty", "mintty", "conemu", "conemu64", "cmder", "termius",
  // Credential and elevation prompts.
  "mstsc", "credentialuibroker", "consent", "securityagent", "gcr-prompter", "lxpolkit", "ksshaskpass", "x11-ssh-askpass",
]);
// Families named by their start: GnuPG's pinentry-gnome3, pinentry-qt, ...;
// polkit-gnome-authentication-agent-1, polkit-kde-authentication-agent-1;
// ssh-askpass-gnome; MobaXterm_Personal_23.2.
const NEVER_LEARN_PREFIXES = Object.freeze(["pinentry", "polkit-", "ssh-askpass", "mobaxterm"]);
// Linux reports a process by /proc/<pid>/comm, which the kernel cuts to 15
// characters ("gnome-terminal-server" arrives as "gnome-terminal-").
const COMM_LENGTH = 15;
// English titles plus the sign-in and password words of German, French,
// Spanish, Portuguese and Dutch; a title in another language is not recognised.
const SENSITIVE_TITLE = new RegExp("\\b(?:" + [
  "password", "passcode", "passphrase", "sign ?in", "log ?in", "two[- ]factor", "2fa", "one[- ]time", "verification code",
  "security code", "credential", "authenticat", "unlock\\b", "sudo\\b",
  "anmeld", "kennwort", "passwort", "mot de passe", "connexion", "se connecter", "contraseña", "iniciar sesi[oó]n",
  "senha", "wachtwoord", "inloggen", "aanmelden",
].join("|") + ")", "i");

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

// Window-title patterns come from the policy: checked for backtracking shapes
// at load and run through the guarded runner (core/policy-pattern.js).
const policyPattern = require("./policy-pattern.js");
const TITLE_MAX = 1000;

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
  const refused = rule.titlePattern ? policyPattern.check(rule.titlePattern, "i") : null;
  if (refused) {
    warnings.push("capture rule " + rule.id + " ignored: " + (refused.startsWith("invalid pattern") ? "invalid title pattern" : "title pattern refused: " + refused));
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
  if (rule.titlePattern && policyPattern.test(rule.titlePattern, "i", asText(context.title), TITLE_MAX)) return true;
  return false;
}

/** True when the focused window looks like a credential prompt or a tool that handles secrets. */
function isSensitiveContext(context) {
  const ctx = context && typeof context === "object" ? context : {};
  if (ctx.secureInput === true || ctx.passwordField === true) return true;
  const name = baseName(ctx.process);
  if (NEVER_LEARN_PROCESSES.includes(name)) return true;
  if (NEVER_LEARN_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (name.length === COMM_LENGTH && NEVER_LEARN_PROCESSES.some((listed) => listed.startsWith(name))) return true;
  return SENSITIVE_TITLE.test(asText(ctx.title));
}

/**
 * Decide the mode for a focused window. `sensitive` is true for credential
 * prompts, password managers and terminals: shortcuts still expand there, but
 * the engine holds no field text and runs no keyword or app checks.
 * @returns {{mode:string, reason:string, rule:object|null, sensitive:boolean}}
 */
function decide(context, policy) {
  const ctx = context && typeof context === "object" ? context : {};
  const pol = policy && Array.isArray(policy.apps) ? policy : createPolicy(policy);
  if (ctx.secureInput === true || ctx.passwordField === true) {
    return { mode: "off", reason: "secure input field", rule: null, sensitive: true };
  }
  const rule = pol.apps.find((candidate) => ruleMatches(candidate, ctx)) || null;
  const sensitive = isSensitiveContext(ctx);
  let mode = rule ? rule.mode : pol.defaultMode;
  let reason = rule ? "rule " + rule.id : "default";
  if (mode === "learn" && sensitive) {
    mode = "triggers";
    reason = "learning is never enabled for credential prompts, password managers or terminals";
  }
  return { mode, reason, rule, sensitive };
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
  containsCardNumber,
  scrub,
};
