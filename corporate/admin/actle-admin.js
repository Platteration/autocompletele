#!/usr/bin/env node
// Administrator tool for the business edition. No dependencies.
//
//   node admin/actle-admin.js keygen <dir>
//   node admin/actle-admin.js sign <policy.json> --key <private.pem> [--serial N] [--layer NAME] [--out <file>] [--allow-warnings]
//   node admin/actle-admin.js verify <signed.json> --pub <public.pem> [--pub <other.pem>]
//   node admin/actle-admin.js validate <policy.json | signed.json>
//   node admin/actle-admin.js layers <org.json> [<team.json> ...]
//   node admin/actle-admin.js report <report.json> [...] [--policy <file>] [--rate N] [--currency C] [--csv <file>]
//   node admin/actle-admin.js suggestions <file.json> [...] [--policy <file>] [--min-desks N] [--out <library.json>]
//   node admin/actle-admin.js license issue --key <vendor.key> --org <name> --seats N --expires YYYY-MM-DD [--tier team|business|enterprise] [--grace DAYS] [--id ID] [--out <file>]
//   node admin/actle-admin.js license show <token|file|policy.json> [--pub <vendor.pub>]
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const signing = require("../core/policy-signing.js");
const orgPolicy = require("../core/org-policy.js");
const report = require("../core/report.js");
const suggestions = require("../core/suggestions.js");
const license = require("../core/license.js");
const { normalizeDeployment } = require("../core/policy-source.js");

const USAGE = `actle Corporate admin tool

  keygen <dir>                    create policy-signing.key (keep secret) and policy-signing.pub
  sign <policy.json> --key <file> [--serial N] [--layer NAME] [--tier NAME] [--groups a,b] [--out <file>] [--allow-warnings]
                                  sign a policy for distribution; refuses over the tier's caps unless --allow-warnings
  verify <signed.json> --pub <file> [--pub <file>]
                                  check a signed policy against public keys
  validate <file> [--tier NAME] [--groups a,b]
                                  parse a plain or signed policy and list problems, including the tier's caps
  layers <file> [<file> ...] [--tier NAME] [--groups a,b]
                                  show the result of layering policies, most general first
  audience <file> [<file> ...] [--groups a,b] [--tier NAME]
                                  show what desks in each group receive (collections, counts, caps)
  report <report.json> [...] [--policy <file>] [--rate N] [--currency C] [--csv <file>]
                                  roll desks' usage reports up into a team view
  suggestions <file.json> [...] [--policy <file>] [--min-desks N] [--out <library.json>]
                                  rank phrases people suggested; write a library to review
  license issue --key <vendor.key> --org <name> --seats N --expires YYYY-MM-DD [--tier team|business|enterprise] [--grace DAYS] [--id ID] [--out <file>]
                                  issue a business licence token (vendor only); the tier defaults to business
  license show <token | file with the token | policy.json> [--pub <vendor.pub>]
                                  print what a licence token says and, with --pub, whether it verifies
  deployment --pub <file> [--pub <file>] --source layer=NAME,label=TEXT,url=https://… [--source …] [--group NAME …] [--refresh MINUTES] --out <deployment.json>
                                  write a desk's deployment.json (sources, pinned keys, the desk's groups, refresh)
  rotate --old <keys dir> --new <keys dir> --deployment <deployment.json> --layer <policy.json> [--layer …] --out-dir <dir>
                                  start a signing-key rotation: new keys, two-key deployment, layers re-signed`;

function writeKeyPair(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "policy-signing.key");
  const pubFile = path.join(dir, "policy-signing.pub");
  // Never overwrite a key: losing the private key means every desk has to be
  // re-deployed with a new public key.
  for (const file of [keyFile, pubFile]) {
    if (fs.existsSync(file)) throw new Error(file + " already exists; refusing to overwrite a signing key");
  }
  const pair = signing.generateKeyPair();
  fs.writeFileSync(keyFile, pair.privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(pubFile, pair.publicKey, { encoding: "utf8", flag: "wx" });
  return { pair, keyFile, pubFile };
}

/** "layer=org,label=Organisation,url=https://…" -> source object. */
function parseSource(text) {
  const source = {};
  for (const part of String(text).split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error("--source parts look like key=value: " + JSON.stringify(part));
    source[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return source;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (name === "allow-warnings" || name === "json") {
        flags[name] = true;
      } else {
        const value = argv[++i];
        if (value === undefined) throw new Error("--" + name + " needs a value");
        (flags[name] = flags[name] || []).push(value);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function one(flags, name) {
  return flags[name] ? flags[name][flags[name].length - 1] : undefined;
}

function readJsonFile(file) {
  const text = fs.readFileSync(file, "utf8");
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(file + " is not valid JSON: " + error.message);
  }
}

/** A signed file yields its payload; a plain file is used as is. */
function policyFrom(file) {
  const { text, value } = readJsonFile(file);
  if (value && value.format === signing.FORMAT && typeof value.payload === "string") {
    return { signed: true, keyId: value.keyId, policy: JSON.parse(value.payload) };
  }
  return { signed: false, policy: value, text };
}

/** The payload of a licence token, decoded but not verified (the desk verifies; here it only names the tier). */
function decodeLicence(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== license.PREFIX) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (error) {
    return null;
  }
}

/**
 * Which tier a policy's caps are checked against: --tier, else the licence
 * token found in the raw policies (unverified). Returns { tier, how } or null.
 */
function tierFor(flags, rawPolicies) {
  const flag = one(flags, "tier");
  if (flag !== undefined) {
    if (!license.TIERS[flag]) throw new Error("--tier must be one of " + license.TIER_IDS.join(", "));
    return { tier: flag, how: "from --tier" };
  }
  for (const raw of rawPolicies) {
    const payload = raw && typeof raw === "object" ? decodeLicence(raw.licence) : null;
    if (payload) return { tier: license.tierOfLicence(payload), how: "from the licence in the policy, not verified" };
  }
  return null;
}

/** --groups a,b → ["a","b"]; absent → "*" (every collection, so checks cover everything). */
function groupsFor(flags) {
  const flag = one(flags, "groups");
  if (flag === undefined) return "*";
  const names = orgPolicy.groupNames(flag.split(","));
  if (names.rejected.length) throw new Error("--groups: " + names.rejected.map((g) => JSON.stringify(g)).join(", ") + " is not a group name (lower-case letters, digits and dashes)");
  return names.names;
}

/** Every kind of desk a policy can reach: no groups, then each group a collection's audience names. */
function deskViews(parsed) {
  const groups = [];
  for (const collection of parsed.collections || []) {
    for (const name of collection.audience) if (!groups.includes(name)) groups.push(name);
  }
  return [[]].concat(groups.map((name) => [name]));
}

function viewLabel(groups) {
  return groups === "*" ? "desks in every group" : groups.length ? "desks in group " + groups.join(", ") : "desks with no groups";
}

/**
 * The tier line for a command's output and the cap warnings to add to the
 * policy's own. Caps are checked per kind of desk, so a policy no real desk
 * exceeds is not refused: the view with the largest overage is reported.
 */
function tierCheck(parsed, found, layers, raw, groups) {
  if (!found) return { line: "tier:             not known (no licence in these files; pass --tier); caps not checked", warnings: [] };
  const line = "tier:             " + license.TIERS[found.tier].name + " (" + found.how + ")";
  if (groups !== "*" || raw === undefined) return { line, warnings: license.tierWarnings(parsed, found.tier, { layers }) };
  let worst = { warnings: [], groups: [] };
  for (const view of deskViews(parsed)) {
    const warnings = license.tierWarnings(orgPolicy.parse(raw, { groups: view }), found.tier, { layers });
    if (warnings.length > worst.warnings.length || (warnings.length && warnings.join().length > worst.warnings.join().length)) worst = { warnings, groups: view };
  }
  return { line, warnings: worst.warnings.map((w) => viewLabel(worst.groups) + ": " + w) };
}

function summary(policy) {
  const lines = [];
  lines.push("organisation:     " + (policy.organization || "(not named)"));
  if (policy.serial) lines.push("serial:           " + policy.serial);
  lines.push("paused:           " + (policy.paused.active ? "YES" + (policy.paused.message ? " (" + policy.paused.message + ")" : "") : "no"));
  lines.push("default capture:  " + policy.capture.defaultMode);
  for (const rule of policy.capture.apps) lines.push("  app rule        " + rule.mode.padEnd(8) + " " + rule.label);
  lines.push("shared shortcuts: " + policy.library.length);
  lines.push("keyword rules:    " + policy.keywordRules.length);
  lines.push("document sets:    " + policy.documents.shortcuts.map((s) => s.trigger).join(", "));
  lines.push("lookups:          " + policy.lookups.map((l) => l.trigger).join(", "));
  const collections = policy.collections || [];
  lines.push("collections:      " + collections.length + (collections.length ? ": " + collections.map((c) => c.id + " (" + (c.audience.length ? c.audience.join(", ") : "everyone") + ")").join(", ") : ""));
  lines.push("groups:           " + (policy.groups === "*" ? "every collection (a desk in every group)" : policy.groups.length ? policy.groups.join(", ") : "none (only what everyone gets)"));
  lines.push("typing speed:     " + policy.typing.charsPerMinute + " characters per minute");
  return lines.join("\n");
}

function run(argv, io) {
  const out = (io && io.stdout) || ((line) => process.stdout.write(line + "\n"));
  const err = (io && io.stderr) || ((line) => process.stderr.write(line + "\n"));
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(error.message);
    return 2;
  }
  const [command, ...rest] = args.positional;
  try {
    switch (command) {
      case "keygen": {
        const dir = rest[0];
        if (!dir) throw new Error("keygen needs a folder");
        const { pair, keyFile, pubFile } = writeKeyPair(dir);
        out("key id " + pair.keyId);
        out("private key: " + keyFile + " (keep it off shared drives)");
        out("public key:  " + pubFile + " (put its text in each desk's deployment.json publicKeys)");
        return 0;
      }
      case "sign": {
        const file = rest[0];
        const keyFile = one(args.flags, "key");
        if (!file || !keyFile) throw new Error("sign needs <policy.json> and --key <private key file>");
        const { value } = readJsonFile(file);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(file + " is not a JSON object");
        const serialFlag = one(args.flags, "serial");
        if (serialFlag !== undefined) {
          const serial = Number(serialFlag);
          if (!Number.isSafeInteger(serial) || serial < 1) throw new Error("--serial must be a positive integer");
          value.serial = serial;
        }
        const layerFlag = one(args.flags, "layer");
        if (layerFlag !== undefined) value.layer = layerFlag;
        const groups = groupsFor(args.flags);
        const parsed = orgPolicy.parse(value, { groups });
        const tier = tierCheck(parsed, tierFor(args.flags, [value]), 1, value, groups);
        const warnings = parsed.warnings.concat(tier.warnings);
        for (const warning of warnings) err("warning: " + warning);
        if (warnings.length && !args.flags["allow-warnings"]) {
          throw new Error("not signed: fix the warnings above or pass --allow-warnings");
        }
        const envelope = signing.signPolicy(value, fs.readFileSync(keyFile, "utf8"));
        const deploymentFile = one(args.flags, "deployment");
        if (deploymentFile) {
          const pinned = normalizeDeployment(readJsonFile(deploymentFile).value).publicKeys.map((pem) => signing.keyId(pem));
          if (!pinned.includes(envelope.keyId)) err("warning: key " + envelope.keyId + " is not pinned in " + deploymentFile + "; desks with that deployment will refuse this policy");
          const layers = normalizeDeployment(readJsonFile(deploymentFile).value).sources.map((s) => s.layer);
          if (!layers.includes(value.layer)) err("warning: no source in " + deploymentFile + " expects layer " + JSON.stringify(value.layer));
        }
        const text = JSON.stringify(envelope, null, 2) + "\n";
        const target = one(args.flags, "out");
        if (target) {
          fs.writeFileSync(target, text, "utf8");
          out("signed layer " + value.layer + " serial " + value.serial + " with key " + envelope.keyId + " -> " + target);
        } else {
          out(text.trimEnd());
        }
        return 0;
      }
      case "verify": {
        const file = rest[0];
        const keys = (args.flags.pub || []).map((p) => fs.readFileSync(p, "utf8"));
        if (!file || !keys.length) throw new Error("verify needs <signed.json> and at least one --pub <public key file>");
        const result = signing.verifyEnvelope(fs.readFileSync(file, "utf8"), keys);
        if (!result.ok) {
          err("NOT VALID: " + result.error);
          return 1;
        }
        out("valid: layer " + result.layer + ", serial " + result.serial + ", key " + result.keyId + ", sha256 " + result.hash);
        return 0;
      }
      case "validate": {
        const file = rest[0];
        if (!file) throw new Error("validate needs a file");
        const source = policyFrom(file);
        const groups = groupsFor(args.flags);
        const parsed = orgPolicy.parse(source.policy, { groups });
        const tier = tierCheck(parsed, tierFor(args.flags, [source.policy]), 1, source.policy, groups);
        out((source.signed ? "signed policy (key " + source.keyId + ", signature not checked; use verify)" : "plain policy") + "\n" + summary(parsed) + "\n" + tier.line);
        const warnings = parsed.warnings.concat(tier.warnings);
        for (const warning of warnings) err("warning: " + warning);
        return warnings.length ? 1 : 0;
      }
      case "layers": {
        if (!rest.length) throw new Error("layers needs at least one file");
        const raw = rest.map((file) => policyFrom(file).policy);
        const merged = orgPolicy.merge(raw);
        if (args.flags.json) {
          out(JSON.stringify(merged, null, 2));
          return 0;
        }
        const groups = groupsFor(args.flags);
        const parsed = orgPolicy.parse(merged, { groups });
        const tier = tierCheck(parsed, tierFor(args.flags, [merged]), rest.length, merged, groups);
        out("layered " + rest.length + " file(s), most general first\n" + summary(parsed) + "\n" + tier.line);
        const warnings = parsed.warnings.concat(tier.warnings);
        for (const warning of warnings) err("warning: " + warning);
        return warnings.length ? 1 : 0;
      }
      case "audience": {
        if (!rest.length) throw new Error("audience needs at least one policy file");
        const raw = rest.length === 1 ? policyFrom(rest[0]).policy : orgPolicy.merge(rest.map((file) => policyFrom(file).policy));
        const everything = orgPolicy.parse(raw, { groups: "*" });
        const found = tierFor(args.flags, [raw]);
        const asked = one(args.flags, "groups");
        const views = asked === undefined ? deskViews(everything) : [groupsFor(args.flags)];
        let problems = 0;
        for (const view of views) {
          const parsed = orgPolicy.parse(raw, { groups: view });
          const received = parsed.collections.filter((c) => c.applied);
          const hidden = parsed.collections.filter((c) => !c.applied);
          out("desk groups:      " + (view.length ? view.join(", ") : "(none)"));
          out("  receives:       " + parsed.library.length + " shortcuts, " + parsed.keywordRules.length + " keyword rules, " + parsed.documents.shortcuts.length + " document sets, " + parsed.lookups.length + " lookups");
          out("  collections:    " + (received.length ? received.map((c) => c.label + " (" + [].concat(c.members.library, c.members.documents, c.members.lookups).join(", ") + ")").join("; ") : "(none)")
            + (hidden.length ? "; not shared: " + hidden.map((c) => c.label).join(", ") : ""));
          const warnings = parsed.warnings.concat(found ? license.tierWarnings(parsed, found.tier, { layers: rest.length }) : []);
          for (const warning of warnings) err("warning: " + viewLabel(view) + ": " + warning);
          problems += warnings.length;
        }
        out(tierCheck(everything, found, rest.length).line);
        return problems ? 1 : 0;
      }
      case "report": {
        if (!rest.length) throw new Error("report needs at least one usage report file");
        const reports = [];
        const unreadable = [];
        for (const file of rest) {
          try {
            reports.push(JSON.parse(fs.readFileSync(file, "utf8")));
          } catch (error) {
            // One unreadable file must not stop the roll-up of the others.
            unreadable.push(file + ": " + error.message);
            reports.push(null);
          }
        }
        const policyFile = one(args.flags, "policy");
        const policy = policyFile ? orgPolicy.parse(policyFrom(policyFile).policy, { groups: "*" }) : null;
        const rate = one(args.flags, "rate");
        if (rate !== undefined && !(Number(rate) > 0)) throw new Error("--rate must be a positive number");
        const merged = report.mergeReports(reports, {
          hourlyRate: rate === undefined ? undefined : Number(rate),
          currency: one(args.flags, "currency"),
          organizationShortcuts: report.organizationShortcuts(policy),
        });
        for (const line of unreadable) err("warning: " + line);
        for (const warning of merged.warnings) err("warning: " + warning);
        const hours = (s) => (s / 3600).toFixed(1) + " h";
        out("desks:            " + merged.desks);
        if (merged.range) out("period:           " + new Date(merged.range.from).toISOString().slice(0, 10) + " to " + new Date(merged.range.to - 1).toISOString().slice(0, 10));
        out("inserts:          " + merged.totals.inserts);
        out("keystrokes saved: " + merged.totals.keystrokesSaved);
        out("time saved:       " + hours(merged.totals.secondsSaved));
        if (merged.value) out("estimated value:  " + merged.value.amount.toFixed(2) + (merged.value.currency ? " " + merged.value.currency : "") + " at " + merged.value.hourlyRate + " per hour");
        out("personal shortcuts (not itemised): " + merged.personal.inserts + " inserts");
        if (merged.byTeam.length) out("\nby team");
        for (const t of merged.byTeam) out("  " + t.team.padEnd(20) + String(t.desks).padStart(4) + " desks " + hours(t.secondsSaved).padStart(10));
        if (merged.byShortcut.length) out("\norganisation shortcuts by use");
        for (const s of merged.byShortcut) out("  " + (s.kind + " " + s.trigger).padEnd(30) + String(s.inserts).padStart(6) + " inserts on " + s.desks + " desk(s)");
        if (merged.unused.length) out("\nnever used: " + merged.unused.map((s) => (s.kind ? s.kind + " " : "") + s.trigger).join(", "));
        for (const row of merged.licences) {
          let seats = null;
          let tier = null;
          const payload = policy && policy.licence ? decodeLicence(policy.licence) : null;
          if (payload && payload.id === row.id) {
            seats = payload.seats;
            tier = license.tierOfLicence(payload);
          }
          out("licence " + row.id + ": " + row.desks + " desk(s)" + (seats != null ? " of " + seats + " seats" : "") + (tier ? ", " + license.TIERS[tier].name + " tier" : ""));
          if (seats != null && row.desks > seats) err("warning: licence " + row.id + " is over its " + seats + " seats by " + (row.desks - seats));
          for (const t of row.tiers || []) {
            if (tier && t.tier !== tier) err("warning: licence " + row.id + ": " + t.desks + " desk(s) report the " + (license.TIERS[t.tier] ? license.TIERS[t.tier].name : t.tier) + " tier, not the licence's " + license.TIERS[tier].name + " (a testing override, or an older version)");
          }
        }
        if (merged.complianceWarnings.shown) {
          out("\ncompliance warnings shown: " + merged.complianceWarnings.shown);
          for (const w of merged.complianceWarnings.byRule) out("  " + w.id.padEnd(30) + String(w.count).padStart(6));
        }
        const csvFile = one(args.flags, "csv");
        if (csvFile) {
          fs.writeFileSync(csvFile, report.toCsv(merged), "utf8");
          out("\nCSV written to " + csvFile);
        }
        return merged.desks ? 0 : 1;
      }
      case "suggestions": {
        if (!rest.length) throw new Error("suggestions needs at least one suggestions file");
        const files = rest.map((file) => {
          try {
            return JSON.parse(fs.readFileSync(file, "utf8"));
          } catch (error) {
            err("warning: " + file + ": " + error.message);
            return null;
          }
        });
        const policyFile = one(args.flags, "policy");
        const policy = policyFile ? orgPolicy.parse(policyFrom(policyFile).policy, { groups: "*" }) : null;
        const minDesks = one(args.flags, "min-desks");
        if (minDesks !== undefined && !(Number(minDesks) >= 1)) throw new Error("--min-desks must be 1 or more");
        const ranked = suggestions.rank(files, { library: policy ? policy.library : [], minDesks });
        for (const warning of ranked.warnings) err("warning: " + warning);
        out("desks: " + ranked.desks + ", suggestions: " + ranked.suggestions.length + (policy ? " (already in the policy library left out)" : ""));
        for (const row of ranked.suggestions) {
          out("\n  " + row.desks + " desk(s), " + row.sessions + " message(s), " + row.kind + (row.teams.length ? ", " + row.teams.join(", ") : "") + ", trigger " + row.suggestedTrigger);
          out("    " + row.text.replace(/\n/g, "\\n").slice(0, 200));
        }
        const target = one(args.flags, "out");
        if (target) {
          fs.writeFileSync(target, JSON.stringify(suggestions.toLibrary(ranked.suggestions), null, 2) + "\n", "utf8");
          out("\nlibrary written to " + target + "; review it, then add it to the policy's library and sign");
        }
        return ranked.desks ? 0 : 1;
      }
      case "license": {
        const sub = rest[0];
        if (sub === "issue") {
          const keyFile = one(args.flags, "key");
          const org = one(args.flags, "org");
          const seats = Number(one(args.flags, "seats"));
          const expires = one(args.flags, "expires");
          if (!keyFile || !org || !expires || !(seats >= 1)) throw new Error("license issue needs --key, --org, --seats and --expires");
          const graceFlag = one(args.flags, "grace");
          const tierFlag = one(args.flags, "tier");
          if (tierFlag !== undefined && !license.LICENSED_TIERS.includes(tierFlag)) throw new Error("--tier must be one of " + license.LICENSED_TIERS.join(", "));
          const token = license.issueLicence({
            id: one(args.flags, "id") || "LIC-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
            organization: org,
            tier: tierFlag === undefined ? "business" : tierFlag,
            seats: Math.floor(seats),
            issuedAt: new Date().toISOString().slice(0, 10),
            expiresAt: expires,
            graceDays: graceFlag === undefined ? 30 : Number(graceFlag),
          }, fs.readFileSync(keyFile, "utf8"));
          const target = one(args.flags, "out");
          if (target) {
            fs.writeFileSync(target, token + "\n", "utf8");
            out("licence written to " + target + "; put the token in the policy as \"licence\" and sign the policy");
          } else {
            out(token);
          }
          return 0;
        }
        if (sub === "show") {
          const source = rest[1];
          if (!source) throw new Error("license show needs a token, a file holding one, or a policy file");
          let token = source;
          if (fs.existsSync(source)) {
            const text = fs.readFileSync(source, "utf8").trim();
            try {
              const parsed = JSON.parse(text);
              token = parsed && parsed.format === signing.FORMAT ? JSON.parse(parsed.payload).licence : parsed && parsed.licence;
            } catch (error) {
              token = text;
            }
          }
          const parts = String(token || "").split(".");
          if (parts.length !== 3 || parts[0] !== license.PREFIX) throw new Error("no business licence token found");
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
          const tier = license.tierOfLicence(payload);
          const caps = license.TIERS[tier].limits;
          const cap = (v) => (v == null ? "no limit" : String(v));
          out("tier:".padEnd(14) + license.TIERS[tier].name + (payload.version === 2 ? "" : " (version 1 licence: no tier field, counts as Business)"));
          out("caps:".padEnd(14) + cap(caps.seats) + " seats, " + cap(caps.shortcuts) + " organisation shortcuts, " + cap(caps.layers) + " policy layers");
          for (const key of ["id", "organization", "seats", "issuedAt", "expiresAt", "graceDays"]) out((key + ":").padEnd(14) + payload[key]);
          const pubs = (args.flags.pub || []).map((file) => fs.readFileSync(file, "utf8"));
          if (pubs.length) {
            const result = license.verifyLicence(token, pubs);
            out("signature:    " + (result.ok ? "valid (key " + result.keyId + ")" : "NOT VALID: " + result.error));
            return result.ok ? 0 : 1;
          }
          out("signature:    not checked (pass --pub <vendor.pub>)");
          return 0;
        }
        throw new Error("license needs issue or show");
      }
      case "deployment": {
        const pubs = (args.flags.pub || []).map((file) => fs.readFileSync(file, "utf8"));
        const sources = (args.flags.source || []).map(parseSource);
        const target = one(args.flags, "out");
        if (!pubs.length || !sources.length || !target) throw new Error("deployment needs --pub, --source and --out");
        const deployment = { policySources: sources, publicKeys: pubs };
        if (args.flags.group) deployment.groups = orgPolicy.groupNames(args.flags.group).names;
        const refresh = one(args.flags, "refresh");
        if (refresh !== undefined) deployment.refreshMinutes = Number(refresh);
        const checked = normalizeDeployment(Object.assign({}, deployment, { groups: args.flags.group || [] }));
        for (const warning of checked.warnings) err("warning: " + warning);
        if (checked.warnings.length) throw new Error("not written: fix the warnings above");
        fs.writeFileSync(target, JSON.stringify(deployment, null, 2) + "\n", "utf8");
        out("deployment written to " + target + ": " + checked.sources.length + " source(s), " + checked.publicKeys.length + " key(s), " + (checked.groups.length ? "groups " + checked.groups.join(", ") : "no groups") + ", refresh every " + checked.refreshMinutes + " minutes");
        out("install it as deployment.json in each desk's data folder");
        return 0;
      }
      case "rotate": {
        const oldDir = one(args.flags, "old");
        const newDir = one(args.flags, "new");
        const deploymentFile = one(args.flags, "deployment");
        const layerFiles = args.flags.layer || [];
        const outDir = one(args.flags, "out-dir");
        if (!oldDir || !newDir || !deploymentFile || !layerFiles.length || !outDir) throw new Error("rotate needs --old, --new, --deployment, --layer and --out-dir");
        const oldPub = fs.readFileSync(path.join(oldDir, "policy-signing.pub"), "utf8");
        const deployment = readJsonFile(deploymentFile).value;
        const pinned = (Array.isArray(deployment.publicKeys) ? deployment.publicKeys : []).map((pem) => signing.keyId(pem));
        if (!pinned.includes(signing.keyId(oldPub))) throw new Error("the old key is not pinned in " + deploymentFile + "; nothing to rotate from");
        const { pair } = writeKeyPair(newDir);
        deployment.publicKeys = (deployment.publicKeys || []).concat([pair.publicKey]);
        const checked = normalizeDeployment(deployment);
        for (const warning of checked.warnings) err("warning: " + warning);
        fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2) + "\n", "utf8");
        fs.mkdirSync(outDir, { recursive: true });
        for (const file of layerFiles) {
          const value = policyFrom(file).policy;
          if (!value.layer || !value.serial) throw new Error(file + " needs layer and serial before it can be signed");
          const envelope = signing.signPolicy(value, pair.privateKey);
          const target = path.join(outDir, path.basename(file).replace(/(\.signed)?\.json$/, "") + ".signed.json");
          fs.writeFileSync(target, JSON.stringify(envelope, null, 2) + "\n", "utf8");
          out("re-signed " + file + " (layer " + value.layer + ", serial " + value.serial + ") -> " + target);
        }
        out("new key id " + pair.keyId + " in " + newDir + "; " + deploymentFile + " now pins both keys");
        out("next: 1) roll out " + deploymentFile + " to every desk; 2) publish the re-signed layers from " + outDir
          + "; 3) after refreshMinutes plus the longest time a desk may be offline, run `deployment` with only " + path.join(newDir, "policy-signing.pub") + (Array.isArray(deployment.groups) && deployment.groups.length ? " and --group " + deployment.groups.join(" --group ") : "") + " and roll it out; 4) delete " + path.join(oldDir, "policy-signing.key"));
        return 0;
      }
      case undefined:
      case "help":
      case "--help":
        out(USAGE);
        return command ? 0 : 2;
      default:
        err("unknown command " + JSON.stringify(command));
        err(USAGE);
        return 2;
    }
  } catch (error) {
    err("error: " + error.message);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run, parseArgs };
