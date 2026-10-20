#!/usr/bin/env node
// Administrator tool for the business edition. No dependencies.
//
//   node admin/actle-admin.js keygen <dir>
//   node admin/actle-admin.js sign <policy.json> --key <private.pem> [--serial N] [--out <file>] [--allow-warnings]
//   node admin/actle-admin.js verify <signed.json> --pub <public.pem> [--pub <other.pem>]
//   node admin/actle-admin.js validate <policy.json | signed.json>
//   node admin/actle-admin.js layers <org.json> [<team.json> ...]
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const signing = require("../core/policy-signing.js");
const orgPolicy = require("../core/org-policy.js");

const USAGE = `actle Corporate admin tool

  keygen <dir>                    create policy-signing.key (keep secret) and policy-signing.pub
  sign <policy.json> --key <file> [--serial N] [--out <file>] [--allow-warnings]
                                  sign a policy for distribution
  verify <signed.json> --pub <file> [--pub <file>]
                                  check a signed policy against public keys
  validate <file>                 parse a plain or signed policy and list problems
  layers <file> [<file> ...]      show the result of layering policies, most general first`;

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
