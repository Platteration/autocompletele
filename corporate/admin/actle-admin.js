#!/usr/bin/env node
// Administrator tool for the business edition. No dependencies.
//
//   node admin/actle-admin.js keygen <dir>
//   node admin/actle-admin.js sign <policy.json> --key <private.pem> [--serial N] [--out <file>] [--allow-warnings]
//   node admin/actle-admin.js verify <signed.json> --pub <public.pem> [--pub <other.pem>]
//   node admin/actle-admin.js validate <policy.json | signed.json>
//   node admin/actle-admin.js layers <org.json> [<team.json> ...]
//   node admin/actle-admin.js report <report.json> [...] [--policy <file>] [--rate N] [--currency C] [--csv <file>]
//   node admin/actle-admin.js suggestions <file.json> [...] [--policy <file>] [--min-desks N] [--out <library.json>]
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const signing = require("../core/policy-signing.js");
const orgPolicy = require("../core/org-policy.js");
const report = require("../core/report.js");
const suggestions = require("../core/suggestions.js");

const USAGE = `actle Corporate admin tool

  keygen <dir>                    create policy-signing.key (keep secret) and policy-signing.pub
  sign <policy.json> --key <file> [--serial N] [--out <file>] [--allow-warnings]
                                  sign a policy for distribution
  verify <signed.json> --pub <file> [--pub <file>]
                                  check a signed policy against public keys
  validate <file>                 parse a plain or signed policy and list problems
  layers <file> [<file> ...]      show the result of layering policies, most general first
  report <report.json> [...] [--policy <file>] [--rate N] [--currency C] [--csv <file>]
                                  roll desks' usage reports up into a team view
  suggestions <file.json> [...] [--policy <file>] [--min-desks N] [--out <library.json>]
                                  rank phrases people suggested; write a library to review`;

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
        fs.mkdirSync(dir, { recursive: true });
        const keyFile = path.join(dir, "policy-signing.key");
        const pubFile = path.join(dir, "policy-signing.pub");
        // Never overwrite a key: losing the private key means every desk has
        // to be re-deployed with a new public key.
        for (const file of [keyFile, pubFile]) {
          if (fs.existsSync(file)) throw new Error(file + " already exists; refusing to overwrite a signing key");
        }
        const pair = signing.generateKeyPair();
        fs.writeFileSync(keyFile, pair.privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
        fs.writeFileSync(pubFile, pair.publicKey, { encoding: "utf8", flag: "wx" });
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
        const parsed = orgPolicy.parse(value);
        for (const warning of parsed.warnings) err("warning: " + warning);
        if (parsed.warnings.length && !args.flags["allow-warnings"]) {
          throw new Error("not signed: fix the warnings above or pass --allow-warnings");
        }
        const envelope = signing.signPolicy(value, fs.readFileSync(keyFile, "utf8"));
        const text = JSON.stringify(envelope, null, 2) + "\n";
        const target = one(args.flags, "out");
        if (target) {
          fs.writeFileSync(target, text, "utf8");
          out("signed serial " + value.serial + " with key " + envelope.keyId + " -> " + target);
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
        out("valid: serial " + result.serial + ", key " + result.keyId + ", sha256 " + result.hash);
        return 0;
      }
      case "validate": {
        const file = rest[0];
        if (!file) throw new Error("validate needs a file");
        const source = policyFrom(file);
        const parsed = orgPolicy.parse(source.policy);
        out((source.signed ? "signed policy (key " + source.keyId + ", signature not checked; use verify)" : "plain policy") + "\n" + summary(parsed));
        for (const warning of parsed.warnings) err("warning: " + warning);
        return parsed.warnings.length ? 1 : 0;
      }
      case "layers": {
        if (!rest.length) throw new Error("layers needs at least one file");
        const merged = orgPolicy.merge(rest.map((file) => policyFrom(file).policy));
        if (args.flags.json) {
          out(JSON.stringify(merged, null, 2));
          return 0;
        }
        const parsed = orgPolicy.parse(merged);
        out("layered " + rest.length + " file(s), most general first\n" + summary(parsed));
        for (const warning of parsed.warnings) err("warning: " + warning);
        return parsed.warnings.length ? 1 : 0;
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
        const policy = policyFile ? orgPolicy.parse(policyFrom(policyFile).policy) : null;
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
        const policy = policyFile ? orgPolicy.parse(policyFrom(policyFile).policy) : null;
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
