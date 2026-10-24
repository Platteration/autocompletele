const test = require("node:test");
const assert = require("node:assert/strict");
const capture = require("../core/capture-policy.js");

test("rules are normalised and unusable ones skipped with a warning", () => {
  const policy = capture.createPolicy({
    defaultMode: "learn",
    apps: [
      { process: "C:\\Program Files\\OUTLOOK.EXE", mode: "learn" },
      { id: "bad-regex", match: { title: "(" }, mode: "learn" },
      { id: "empty", mode: "learn" },
      "nope",
      { id: "mail", match: { title: "Gmail", bundleId: "Com.Apple.Mail" }, mode: "off" },
    ],
  });
  assert.equal(policy.defaultMode, "learn");
  assert.deepEqual(policy.apps.map((a) => a.id), ["app-0", "mail"]);
  assert.deepEqual(policy.apps[0].processes, ["outlook"]);
  assert.deepEqual(policy.apps[1].bundleIds, ["com.apple.mail"]);
  assert.equal(policy.warnings.length, 3);
  assert.equal(capture.createPolicy(null).defaultMode, "triggers");
  assert.equal(capture.createPolicy({ defaultMode: "weird" }).defaultMode, "triggers");
});

test("decide matches by process, bundle id or title, first rule wins", () => {
  const policy = capture.createPolicy({ apps: [
    { id: "a", match: { process: ["outlook.exe", "thunderbird"] }, mode: "learn" },
    { id: "b", match: { title: "gmail" }, mode: "learn" },
    { id: "c", match: { title: "." }, mode: "off" },
  ] });
  assert.equal(capture.decide({ process: "/Applications/Thunderbird.app" }, policy).mode, "learn");
  assert.equal(capture.decide({ process: "chrome", title: "Inbox - Gmail" }, policy).rule.id, "b");
  assert.equal(capture.decide({ process: "chrome", title: "Anything" }, policy).mode, "off");
  assert.equal(capture.decide({}, policy).mode, "triggers");
  assert.equal(capture.decide({}, policy).reason, "default");
  assert.equal(capture.decide({ process: "x" }, { defaultMode: "learn" }).mode, "learn");
});

test("learn mode is downgraded for credential prompts, password managers and terminals", () => {
  const policy = capture.createPolicy({ defaultMode: "learn", apps: [{ match: { process: "keepassxc" }, mode: "learn" }] });
  assert.equal(capture.decide({ process: "keepassxc.exe" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "chrome", title: "Sign in - Google Accounts" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "WindowsTerminal" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "notepad", title: "Enter your two-factor code" }, policy).mode, "triggers");
  assert.equal(capture.decide({ process: "notepad", title: "Draft" }, policy).mode, "learn");
  assert.equal(capture.decide({ process: "notepad", secureInput: true }, policy).mode, "off");
  assert.equal(capture.decide({ process: "notepad", passwordField: true }, policy).mode, "off");
  assert.equal(capture.isSensitiveContext({ title: "My passwords.txt - Notepad" }), true);
  assert.equal(capture.isSensitiveContext({ title: "Weekly report" }), false);
});

test("decide flags sensitive windows, whatever the mode, so the engine holds and checks nothing there", () => {
  const policy = capture.createPolicy({ apps: [{ match: { process: "powershell" }, mode: "learn" }] });
  const flagged = [
    { process: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
    { process: "/usr/bin/gnome-terminal" },
    { process: "C:\\Program Files\\KeePass Password Safe 2\\KeePass.exe", title: "Add Entry" },
    { process: "chrome.exe", title: "Sign in - Google Accounts" },
    { process: "notepad", secureInput: true },
  ];
  for (const context of flagged) assert.equal(capture.decide(context, policy).sensitive, true, JSON.stringify(context));
  assert.equal(capture.decide(flagged[0], policy).mode, "triggers", "still downgraded from learn");
  assert.equal(capture.decide({ process: "notepad", title: "Draft" }, policy).sensitive, false);
  assert.equal(capture.decide({}, policy).sensitive, false);
});

test("terminals are recognised under the 15-character process name Linux reports", () => {
  // /proc/<pid>/comm cuts names to 15 characters: gnome-terminal-server -> gnome-terminal-.
  for (const name of ["gnome-terminal-", "gnome-terminal-server", "xfce4-terminal", "mate-terminal", "tilix", "terminator", "wezterm-gui", "ptyxis"]) {
    assert.equal(capture.isSensitiveContext({ process: name }), true, name);
  }
  const learnEverywhere = capture.createPolicy({ defaultMode: "learn" });
  assert.equal(capture.decide({ process: "gnome-terminal-" }, learnEverywhere).mode, "triggers", "never learned");
  // Only a full 15-character name is read as cut: a shorter prefix is another program.
  assert.equal(capture.isSensitiveContext({ process: "gnome-term" }), false);
  assert.equal(capture.isSensitiveContext({ process: "libreoffice-wri" }), false);
});

test("SSH clients, more terminals, credential prompts and sign-in titles in other languages are sensitive", () => {
  const processes = [
    "C:\\Program Files\\PuTTY\\putty.exe", "C:\\Program Files\\Git\\usr\\bin\\mintty.exe", "C:\\Program Files (x86)\\Mobatek\\MobaXterm\\MobaXterm.exe",
    "MobaXterm_Personal_23.2.exe", "ConEmu64.exe", "OpenConsole.exe", "urxvt", "lxterminal", "Ghostty", "warp-terminal", "st",
    "polkit-gnome-au", "polkit-kde-auth", "lxpolkit", "pinentry-gnome3", "pinentry-qt", "pinentry-mac", "ssh-askpass-gnome", "ksshaskpass",
    "gcr-prompter", "SecurityAgent", "seahorse", "KeePassX", "Keeper",
  ];
  for (const process of processes) assert.equal(capture.isSensitiveContext({ process }), true, process);
  const titles = [
    "Anmelden - Microsoft-Konto - Microsoft Edge", "Kennwort ändern", "Passwort vergessen", "Connexion - Gmail", "Mot de passe oublié",
    "Iniciar sesión - Google", "CONTRASEÑA", "Entrar - Senha", "Inloggen bij DigiD", "Unlock Login Keyring", "Authentication Required",
    "[sudo] password for jane",
  ];
  for (const title of titles) assert.equal(capture.isSensitiveContext({ process: "msedge.exe", title }), true, title);
  // Names and words that only start the same way are other programs and other titles.
  for (const process of ["steam", "stellarium", "pinball", "hyperv", "notepad"]) assert.equal(capture.isSensitiveContext({ process }), false, process);
  for (const title of ["Unlocking growth - Blog", "sudoku online", "Weekly report"]) assert.equal(capture.isSensitiveContext({ title }), false, title);
  assert.equal(capture.decide({ process: "putty.exe" }, capture.createPolicy({ defaultMode: "learn" })).mode, "triggers", "never learned");
});

test("scrub masks card numbers that pass Luhn, labelled secrets and long tokens", () => {
  const input = "Card 4111 1111 1111 1111 expires soon. Password: hunter2! Token X7KQ2M9ZP4WT8NB6RH3VLC5J1Y and order 1234567890123 is fine.";
  const out = capture.scrub(input);
  assert.equal(out.redactions, 3);
  assert.match(out.text, /Card \[card\] expires/);
  assert.match(out.text, /Password: \[redacted\] Token \[token\] and order 1234567890123 is fine/);
  assert.equal(capture.scrub("Our office is at 123 Main Street").text, "Our office is at 123 Main Street");
  assert.equal(capture.scrub("see https://example.com/path and mail me@example.com").redactions, 0);
  assert.equal(capture.scrub("api_key = abcdefghijklmnopqrstuvwxyz").redactions, 1);
  assert.equal(capture.scrub(null).text, "");
});
