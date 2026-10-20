#!/usr/bin/env node
// Headless walk-through of the business edition without Electron or a
// keyboard hook: a scripted person switches between applications and types
// several emails. Prints the actions the shell would carry out, the metrics
// and the learning candidates. Deterministic: fixed clock, temp data folder.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAssistant } = require("./assistant.js");

const POLICY_FILE = path.join(__dirname, "..", "shared", "org-policy.example.json");
const FALLBACK_POLICY = {
  version: 1,
  organization: "Inline example",
  capture: { apps: [{ id: "outlook", mode: "learn", match: { process: "outlook" } }] },
  library: [{ trigger: "sig/", expansion: "Kind regards,\n{cursor}\nExample Logistics Ltd" }],
  keywordRules: [{ id: "returns", label: "Returns policy", keywords: ["refund"], insert: { kind: "text", text: "Returns are accepted within 30 days." } }],
  documents: { shortcuts: [{ trigger: "/sld", label: "Shipping logistics department", documents: [{ title: "Packing list", path: "S:/Shared/packing-list.xlsx" }] }] },
};

let clock = new Date(2026, 9, 19, 9, 0, 0).getTime(); // Monday 19 October 2026, 09:00 local
const now = () => clock;
const tick = (ms) => { clock += ms; };

// Stand-in for Electron's safeStorage. The desktop app uses the operating
// system keychain; this only lets the headless run store encrypted sessions.
const testKeychain = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from("SIMULATED-KEYCHAIN:" + text),
  decryptString: (blob) => {
    const text = Buffer.from(blob).toString();
    if (!text.startsWith("SIMULATED-KEYCHAIN:")) throw new Error("not ours");
    return text.slice("SIMULATED-KEYCHAIN:".length);
  },
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "actle-corporate-sim-"));
const assistant = createAssistant({
  dataDir,
  now,
  keychain: testKeychain,
  policyFile: fs.existsSync(POLICY_FILE) ? POLICY_FILE : null,
  policy: FALLBACK_POLICY,
});

const out = [];
const print = (line) => out.push(line);
const brief = (text) => JSON.stringify(text).slice(0, 70);

function describe(action) {
  switch (action.type) {
    case "expand": return `expand ${action.trigger} -> ${brief(action.text)} (delete ${action.backspaces}, saves ${action.keystrokesSaved} keystrokes)`;
    case "template": return `template ${action.trigger}: ask for ${action.fields.map((f) => f.name).join(", ")}`;
    case "documents": return `documents ${action.trigger} (${action.label}): ${action.documents.map((d) => d.title).join("; ")}`;
    case "keyword": return `keyword offer: ${action.hits.map((h) => h.rule.label + " [" + h.matched.join(", ") + "]").join("; ")}`;
    case "warning": return `warning: ${action.hits.map((h) => h.rule.message + (h.rule.insert ? " (fix offered)" : "")).join("; ")}`;
    case "undo": return `undo -> put ${action.trigger} back`;
    default: return JSON.stringify(action);
  }
}

function type(text) {
  for (const ch of text) {
    const key = ch === "\n" ? { text: "\n", resetsBuffer: true } : ch === "\b" ? { isBackspace: true } : { text: ch };
    for (const action of assistant.keyTyped(key)) print("    -> " + describe(action));
    tick(120);
  }
}

function focus(context) {
  const result = assistant.focusChanged(context);
  print(`\n[focus] ${context.process} "${context.title}" -> mode ${result.mode} (${result.reason})`);
  if (result.session) print(`    learned session from ${result.session.app}: ${result.session.text.length} chars, ${result.session.redactions} redaction(s)`);
}

print("actle Corporate simulation");
print("policy: " + (assistant.policyInfo().organization || "(none)") + "; warnings: " + (assistant.warnings().join("; ") || "none"));
print("data folder: " + dataDir);

// Three near-identical order confirmations in Outlook (learn mode), then a
// password manager and a chat app (never learned), then a banking portal (off).
const customers = [["John", "A-10021", "Monday"], ["Mary Ann", "A-10034", "Wednesday"], ["Priya", "A-10040", "Friday"]];
for (const [name, order, day] of customers) {
  focus({ process: "C:\\Program Files\\Microsoft Office\\OUTLOOK.EXE", title: `Order ${order} - Message` });
  type(`Hi ${name},\n\nThanks for your order ${order}. It will ship on ${day}.\n\nThanks for reaching out to our support team. We will get back to you within one business day.\n\nsig/`);
  tick(60 * 1000);
}

focus({ process: "OUTLOOK.EXE", title: "Refund request - Message" });
type("Hello,\n\nYou asked about a refund for your shipment and customs paperwork. ");
type("Card on file: 4111 1111 1111 1111 and password: hunter2 (please do not send these).\n\n/sld");
type("hrs/");
type("\b"); // Backspace right after an expansion puts the trigger back
type("\n");
assistant.recordInsert({ kind: "document", trigger: "/sld", count: 2 });

focus({ process: "OUTLOOK.EXE", title: "Contract renewal - Message" });
type("Hello,\n\nThe renewed contract is attached. ");

focus({ process: "1Password.exe", title: "1Password" });
type("hrs/");

focus({ process: "Teams.exe", title: "Chat" });
type("ack/");
tick(2 * 60 * 1000);

focus({ process: "chrome.exe", title: "Online Banking - Personal" });
type("sig/");

// Next day: a learned session is only written when the person leaves the field.
tick(24 * 60 * 60 * 1000);
focus({ process: "OUTLOOK.EXE", title: "Follow-up - Message" });
type("Thanks for reaching out to our support team. We will get back to you within one business day.\n\n");
assistant.endSession();

print("\nMetrics");
for (const period of ["day", "week", "month", "all"]) {
  const s = assistant.summary({ period, now: clock });
  print(`  ${period.padEnd(5)} ${String(s.expansions).padStart(3)} inserts, ${String(s.keystrokesSaved).padStart(4)} keystrokes saved, ${s.secondsSaved.toFixed(1).padStart(6)} s saved${s.key ? " (" + s.key + ")" : ""}`);
}
print("  per day (last 3):");
for (const bucket of assistant.series({ period: "day", count: 3, now: clock })) {
  print(`    ${bucket.key}: ${bucket.expansions} inserts, ${bucket.keystrokesSaved} keystrokes, ${bucket.secondsSaved.toFixed(1)} s`);
}
print("  per application:");
for (const row of assistant.byApp()) {
  print(`    ${row.app.padEnd(10)} ${row.expansions} inserts, ${row.keystrokesSaved} keystrokes, ${row.secondsSaved.toFixed(1)} s`);
}

print("\nLearning candidates");
const candidates = assistant.candidates();
if (!candidates.length) print("  none");
for (const c of candidates) {
  if (c.kind === "template") {
    print(`  template (${c.sessions} messages) suggested trigger ${c.suggestedTrigger}`);
    print("    " + c.template.replace(/\n/g, "\\n"));
    for (const slot of c.slots) print(`    [[${slot.name}]] seen as: ${slot.values.join(" | ")}`);
  } else {
    print(`  ${c.kind} (${c.sessions} messages) suggested trigger ${c.suggestedTrigger}: ${brief(c.text)}`);
  }
}

const usage = assistant.usageReport();
print("\nUsage report (what this desk would send)");
print(`  ${usage.totals.inserts} inserts, ${usage.totals.keystrokesSaved} keystrokes, ${usage.totals.secondsSaved} s over ${usage.series.length} ${usage.period}s`);
print("  organisation shortcuts: " + usage.byShortcut.map((s) => s.kind + " " + s.trigger + " x" + s.inserts).join(", "));
print(`  own shortcuts: ${usage.personal.inserts} inserts, not named; typed text included: ${JSON.stringify(usage).includes("Thanks for reaching out") ? "YES" : "no"}`);

const sessions = assistant.store.loadSessions();
const rawCorpus = fs.readFileSync(path.join(dataDir, "corpus.jsonl"), "utf8");
print(`\nCorpus on disk: ${sessions.length} session(s); secrets scrubbed: ${sessions.some((s) => s.text.includes("[card]") && s.text.includes("[redacted]")) ? "yes" : "NO"}; encrypted on disk: ${!rawCorpus.includes("Thanks for") && rawCorpus.includes('"enc":"v1:') ? "yes (simulated keychain)" : "NO"}`);
print("Store warnings: " + (assistant.store.warnings().join("; ") || "none"));

// Central distribution: IT signs the example policy plus a team overlay,
// a managed desk fetches both from a file share, then IT pauses every desk.
async function managedDesk() {
  const signing = require("../core/policy-signing.js");
  const keys = signing.generateKeyPair();
  const share = new Map();
  const base = fs.existsSync(POLICY_FILE) ? JSON.parse(fs.readFileSync(POLICY_FILE, "utf8")) : FALLBACK_POLICY;
  const publish = (where, policy) => share.set(where, JSON.stringify(signing.signPolicy(policy, keys.privateKey)));
  publish("S:/IT/actle/org.signed.json", Object.assign({}, base, { serial: 1 }));
  publish("S:/IT/actle/shipping.signed.json", { serial: 1, library: [{ trigger: "eta/", expansion: "Estimated arrival is [[date]]." }] });
  const deskDir = fs.mkdtempSync(path.join(os.tmpdir(), "actle-corporate-desk-"));
  const desk = createAssistant({
    dataDir: deskDir,
    now,
    deployment: {
      policySources: [{ label: "Organisation", path: "S:/IT/actle/org.signed.json" }, { label: "Shipping team", path: "S:/IT/actle/shipping.signed.json" }],
      publicKeys: [keys.publicKey],
    },
    readFile: async (where) => {
      if (!share.has(where)) throw new Error("not found");
      return share.get(where);
    },
  });
  const report = (label, result) => print(`  ${label}: ${result.sources.map((s) => s.label + " " + s.status + (s.serial ? " #" + s.serial : "")).join(", ")}; paused: ${desk.paused ? "yes" : "no"}; shared shortcuts: ${desk.policyInfo().organizationLibrary.length}`);
  print("\nSigned policy distribution");
  report("first fetch", await desk.refreshPolicy());
  publish("S:/IT/actle/org.signed.json", Object.assign({}, base, { serial: 2, paused: { message: "Paused for review" } }));
  report("after IT pauses", await desk.refreshPolicy());
  const tampered = JSON.parse(share.get("S:/IT/actle/org.signed.json"));
  tampered.payload = tampered.payload.replace('"Paused for review"', '"Resumed"').replace('"serial": 2', '"serial": 3');
  share.set("S:/IT/actle/org.signed.json", JSON.stringify(tampered));
  report("after tampering", await desk.refreshPolicy());
  print("  audit: " + desk.audit().map((e) => e.event).join(", "));
  fs.rmSync(deskDir, { recursive: true, force: true });
}

managedDesk().then(() => {
  console.log(out.join("\n"));
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}, (error) => {
  console.log(out.join("\n"));
  console.error(error);
  process.exit(1);
});
