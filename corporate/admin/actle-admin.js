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
//   node admin/actle-admin.js file <document> [...] --policy <file> [--apply] [-- <document> ...]
//
// The command comes first. Each command accepts only its own options; `--`
// ends the options, so everything after it is a document or file name. With
// options, file, report and suggestions take documents only with a folder
// part (./a.txt, inbox/*) or after `--`.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const signing = require("../core/policy-signing.js");
const orgPolicy = require("../core/org-policy.js");
const report = require("../core/report.js");
const suggestions = require("../core/suggestions.js");
const extract = require("../core/extract.js");
const filer = require("../core/filer.js");
// The suite apps' names; the policy keeps the section keys (desktop/apps/index.js loads no app at require time).
const { NAMES } = require("../desktop/apps/index.js");

// A report's metric kinds are internal ids; the printout names the suite's
// apps as people know them (the CSV keeps the ids).
const KIND_APPS = Object.freeze({ reply: "reply", sheets: "sheets", form: "forms", guard: "guard", notes: "notes", filed: "filing" });
function kindLabel(kind) {
  return Object.hasOwn(KIND_APPS, kind) ? NAMES[KIND_APPS[kind]].name : kind;
}

const USAGE = `actle Corporate admin tool

  keygen <dir>                    create policy-signing.key (keep secret) and policy-signing.pub
  sign <policy.json> --key <file> [--serial N] [--layer NAME] [--out <file>] [--allow-warnings]
                                  sign a policy for distribution
  verify <signed.json> --pub <file> [--pub <file>]
                                  check a signed policy against public keys
  validate <file>                 parse a plain or signed policy and list problems
  layers <file> [<file> ...]      show the result of layering policies, most general first
  report <report.json> [...] [--policy <file>] [--rate N] [--currency C] [--csv <file>]
                                  roll desks' usage reports up into a team view
  suggestions <file.json> [...] [--policy <file>] [--min-desks N] [--out <library.json>]
                                  rank phrases people suggested; write a library to review
  file <document> [...] --policy <file> [--apply]
                                  show how the policy's filing rules would name and file documents;
                                  --apply renames and moves them (blanks nothing filled are left alone)

  The command comes first; each takes only the options shown, and only --pub
  may be given more than once. "--" ends the options: everything after it is
  a document. A wildcard such as * can put a file named like an option on the
  command line, so file, report and suggestions take, alongside options, only
  documents named with a folder (folder/*, ./*) or after "--", and an option
  that is also the name of a file in the current folder is refused.
  --csv and --out never replace an existing file.`;

// The options each command accepts: "flag" stands alone, "value" takes the
// next argument once, "values" may be given more than once.
const OPTIONS = {
  keygen: {},
  sign: { key: "value", serial: "value", layer: "value", out: "value", "allow-warnings": "flag" },
  verify: { pub: "values" },
  validate: {},
  layers: { json: "flag" },
  report: { policy: "value", rate: "value", currency: "value", csv: "value" },
  suggestions: { policy: "value", "min-desks": "value", out: "value" },
  file: { policy: "value", apply: "flag" },
  help: {},
};

// The commands an administrator points at a wildcard of desk files. A * in a
// folder someone else can write to may expand to a file named --apply or
// --csv, which can be deleted again before the tool looks (so the file check
// in parseArgs can be raced). Only a wildcard without a folder in it (*,
// *.json) puts such a name on the command line as an option; inbox/* gives
// inbox/--apply, a document. So with options given, these commands refuse a
// document named without a folder before "--": the other names the same
// wildcard produced give it away, whether or not the planted file is still there.
const WILDCARD_COMMANDS = new Set(["file", "report", "suggestions"]);

function hasFolderPart(name) {
  return name.includes("/") || (path.sep === "\\" && name.includes("\\"));
}

function existsHere(name) {
  try {
    fs.lstatSync(name);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Split the command line into the command's documents and options. A shell
 * wildcard can expand to a file named "--apply" or "--policy", so an option
 * that is also the name of a file here is refused rather than obeyed, as are
 * options the command does not take, repeated single options and an option
 * value that is itself an option. After "--" everything is a name. That file
 * check can be raced (the planted file deleted after the shell expanded the
 * wildcard), so with options the WILDCARD_COMMANDS also refuse a document
 * named without a folder before "--", which does not depend on timing.
 */
function parseArgs(argv, options) {
  const exists = options && typeof options.exists === "function" ? options.exists : existsHere;
  const args = argv.slice();
  if (args[0] === "--help") args[0] = "help";
  const command = args[0];
  const positional = [];
  const flags = {};
  if (command === undefined) return { positional, flags };
  if (command.startsWith("--")) throw new Error("put the command first (" + command + " is an option)");
  positional.push(command);
  const accepted = Object.hasOwn(OPTIONS, command) ? OPTIONS[command] : {};
  let ended = false;
  let bare = null;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (ended || !arg.startsWith("--")) {
      if (!ended && bare === null && !hasFolderPart(arg)) bare = arg;
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      ended = true;
      continue;
    }
    if (exists(arg)) {
      throw new Error(arg + " is also the name of a file here, so a wildcard may have put it on the command line; it is not read as an option. Run the tool from another folder and name the documents as folder/*");
    }
    const name = arg.slice(2);
    const kind = Object.hasOwn(accepted, name) ? accepted[name] : null;
    if (!kind) throw new Error(command + " does not take " + arg);
    if (kind === "flag") {
      flags[name] = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined) throw new Error(arg + " needs a value");
    if (value.startsWith("--")) throw new Error(arg + " needs a value, not the option " + value);
    if (kind === "value" && flags[name]) throw new Error(arg + " is given more than once");
    (flags[name] = flags[name] || []).push(value);
  }
  if (WILDCARD_COMMANDS.has(command) && bare !== null && Object.keys(flags).length) {
    throw new Error(bare + " is named without a folder, so it may come from a wildcard such as * in this folder, which can also put a file named like an option on the command line; with options, name documents as ./" + bare + " or folder/*, or put them after --");
  }
  return { positional, flags };
}

/** Write `text` to a file that must not exist yet: an output option never replaces a desk's report or anything else. */
function writeNew(file, text) {
  try {
    fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(file + " already exists; it was not replaced (name a new file)");
    throw error;
  }
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
  lines.push("filing rules:     " + policy.filing.rules.map((r) => r.id).concat(policy.filing.fallback ? ["(fallback)"] : []).join(", ") + (policy.filing.watch.length ? "; watching " + policy.filing.watch.map((w) => w.path).join(", ") : ""));
  const suite = [["reply", (policy.reply.replies || []).length, "replies"], ["sheets", Object.keys(policy.sheets.vocabularies || {}).length, "vocabularies"],
    ["forms", (policy.forms.records || []).length, "records"], ["guard", (policy.guard.packs || []).length, "packs"], ["notes", (policy.notes.documents || []).length, "documents"]]
    .filter(([, count]) => count > 0).map(([section, count, what]) => NAMES[section].name + " (" + section + ": " + count + " " + what + ")");
  if (suite.length) lines.push("suite apps:       " + suite.join(", "));
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
        const layerFlag = one(args.flags, "layer");
        if (layerFlag !== undefined) value.layer = layerFlag;
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
        for (const s of merged.byShortcut) out("  " + (kindLabel(s.kind) + " " + s.trigger).padEnd(30) + String(s.inserts).padStart(6) + " inserts on " + s.desks + " desk(s)");
        if (merged.unused.length) out("\nnever used: " + merged.unused.map((s) => (s.kind ? kindLabel(s.kind) + " " : "") + s.trigger).join(", "));
        const csvFile = one(args.flags, "csv");
        if (csvFile) {
          writeNew(csvFile, report.toCsv(merged));
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
          writeNew(target, JSON.stringify(suggestions.toLibrary(ranked.suggestions), null, 2) + "\n");
          out("\nlibrary written to " + target + "; review it, then add it to the policy's library and sign");
        }
        return ranked.desks ? 0 : 1;
      }
      case "file": {
        if (!rest.length) throw new Error("file needs at least one document");
        const policyFile = one(args.flags, "policy");
        if (!policyFile) throw new Error("file needs --policy <file>");
        const policy = orgPolicy.parse(policyFrom(policyFile).policy);
        for (const warning of policy.warnings) err("warning: " + warning);
        if (!policy.filing.rules.length && !policy.filing.fallback) throw new Error("the policy has no filing rules");
        const apply = !!args.flags.apply;
        out(apply ? "APPLYING: documents are renamed and moved" : "DRY RUN: nothing is renamed or moved (add --apply to file them)");
        let problems = 0;
        for (const file of rest) {
          // Only regular files are documents: a folder, link or device given by a wildcard is left alone, as on the desk.
          let stat;
          try {
            stat = fs.lstatSync(file);
          } catch (error) {
            err(file + ": " + error.message);
            problems++;
            continue;
          }
          if (!stat.isFile()) {
            err(file + ": not a file (" + (stat.isDirectory() ? "a folder" : stat.isSymbolicLink() ? "a symbolic link" : "not a regular file") + "), skipped");
            problems++;
            continue;
          }
          const read = extract.extractText(file);
          if (read.error && !read.bytes) {
            err(file + ": " + read.error);
            problems++;
            continue;
          }
          const proposal = filer.propose({ name: path.basename(file), ext: read.ext, text: read.text, modified: stat.mtimeMs }, policy.filing);
          if (!proposal) {
            out(file + ": no rule applies");
            continue;
          }
          // The folder resolves as on the desk: `~` is the home folder, a relative folder sits next to the document.
          const folder = filer.resolveFolder(file, proposal);
          const why = (proposal.matched.length ? "matched " + proposal.matched.join(", ") : proposal.rule.id === "fallback" ? "no rule matched" : "by extension")
            + (read.unsupported ? "; file name only (" + (read.ext || "no extension") + " is not read)" : read.error ? "; " + read.error : "");
          out(file + "\n  rule:   " + proposal.rule.label + " (" + why + ")\n  name:   " + proposal.name + "\n  folder: " + folder
            + (proposal.missing.length ? "\n  missing: " + proposal.missing.join(", ") : ""));
          if (!apply) continue;
          if (!proposal.ready) {
            out("  not applied: blanks missing");
            problems++;
            continue;
          }
          try {
            fs.mkdirSync(folder, { recursive: true });
            // Never overwrites, even when a desk files the same name into the same folder at the same moment.
            out("  filed as " + filer.moveDocument(file, folder, proposal.name).path);
          } catch (error) {
            err("  could not file: " + error.message);
            problems++;
          }
        }
        return problems ? 1 : 0;
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
