# actle Corporate – desktop shell

Tray application that runs the business edition in every program on Windows,
macOS and Linux. It listens for keys globally, expands shortcuts through the
clipboard, learns recurring text in the applications a person allowed, offers
keyword inserts and document sets, and shows keystrokes and time saved.

The logic lives in [`../core`](../core) and is tested there with plain Node.
This folder adds the Electron shell and the two platform adapters.

## Install and run

```
cd corporate/desktop
npm install          # downloads Electron and builds the uiohook-napi listener
npm start            # starts the tray app and opens the dashboard
npm run simulate     # headless walk-through, no Electron needed (see below)
```

An organisation policy is read from `policy.json` in the data folder, or from
the file named by the `ACTLE_POLICY_FILE` environment variable on first start.
A centrally managed desk instead has a `deployment.json` naming signed policy
sources and the public keys that sign them; it then ignores any local
`policy.json`. See [`../shared/ORG-POLICY.md`](../shared/ORG-POLICY.md) and the
example in `../shared/org-policy.example.json`.

## Installers and updates

```
npm run dist                       # installers into dist/: NSIS .exe, .dmg + .zip, .AppImage + .deb
npm run check:package -- dist/linux-unpacked   # confirms the packaged layout loads the core
```

`electron-builder` does not rebuild `uiohook-napi` (`npmRebuild: false`):
the module ships N-API prebuilds for every platform, which Electron loads
as they are, and compiling it from source would need the X11 headers on
Linux. It packs this folder into `app.asar` and copies `../core`
and the three personal modules (`chrome-extension/src/{expander,template,
palette}.js`) next to it as extra resources, so the `../core` requires in
this folder and `core/personal.js`'s second search path resolve inside the
package. The Windows installer is per machine, asks for the folder, and
accepts `/S` for a silent install. The CI job `corporate-desktop` builds all
three platforms unsigned and keeps the installers as artifacts; signing and
notarisation need the certificate variables listed in
[`../shared/ORG-POLICY.md`](../shared/ORG-POLICY.md), "Software updates".

Updates (`updater.js`) run only in a packaged build and only when the
policy names `updates.url`; `electron-updater` downloads from that server
and installs on quit. The Policy tab shows the server, the last check and
the state, with **Check now**, **Download now** (while updates are deferred)
and **Restart and install**. The setting `deferUpdates` stops automatic
downloads.

## Search palette

Ctrl+Shift+Space (Cmd+Shift+Space on macOS) opens a search over the merged
library and the organisation's document sets; the tray menu has the same
entry. Type a trigger or any words from the text, choose with ↑ and ↓, and
press Enter: the window closes and the text is pasted where you were typing
(fill-in templates open their form first, document sets their list). Esc or
clicking elsewhere closes it. Typing in the palette is never expanded or
learned. If another application already owns the hotkey, the dashboard says
so and the tray entry still works. Statistics count a palette insert as its
length minus the query and the Enter key.

## Where data lives

Everything is in Electron's `userData` folder for the app
(`%APPDATA%\actle-corporate-desktop` on Windows,
`~/Library/Application Support/actle-corporate-desktop` on macOS,
`~/.config/actle-corporate-desktop` on Linux):

| File              | Contents                                                        |
| ----------------- | --------------------------------------------------------------- |
| `library.json`    | Own shortcuts, in the shared `shorthands.json` format (version 1) |
| `policy.json`     | The organisation policy, if one was installed                   |
| `settings.json`   | Enabled flag, own capture rules, typing-speed override, palette hotkey (`paletteShortcut`, an Electron accelerator; `""` turns it off), `keyboardLayout` (`auto` or a layout id), `deferUpdates` |
| `metrics.jsonl`   | One line per insert: time, kind, application, keystrokes saved, whether the shortcut was the organisation's or the person's |
| `corpus.jsonl`    | Scrubbed text from learn-mode applications, each record encrypted (AES-256-GCM), pruned by retention |
| `corpus.key`      | The corpus key, itself encrypted by the operating system keychain (Electron `safeStorage`) |
| `learned.json`    | SHA-256 digests of proposals the person dismissed (no readable text) |
| `lookup-cache/`   | Last good copy of each lookup's data source, plain JSON (organisation reference data, not typed text) |
| `upload-state.json` | When the policy sets `reporting.endpoint`: time and outcome of the last usage-report upload and the exact body sent |
| `suggestions.json` | Proposals the person chose to suggest to the organisation, readable, until exported, removed or deleted with the learned text |
| `deployment.json` | Managed desks only: signed policy sources and pinned public keys, written by IT |
| `policy-cache/`   | Last good copy of each signed policy layer                     |
| `policy-state.json` | Hash of the policy last applied and each source's status     |
| `audit.jsonl`     | Policy changes, failing or recovering sources, capture-rule changes, corpus key and deletion events; never typed text |

Learned text is only written encrypted, with one exception the person
chooses: proposals they mark "Suggest to organisation" are kept readable in
`suggestions.json` so they can be reviewed and exported. When the system has no secure
keychain (for example Linux without GNOME Keyring or KWallet, where Electron
would fall back to a fixed password), learning sessions are not written at
all and the dashboard says so. Text written by an earlier version without
encryption is encrypted on the next start. Records the current key cannot
open are kept untouched, never dropped, and the key file is never replaced
while such records exist. The Learning tab shows how much text is stored;
"Delete learned text" removes it together with the dismissed-proposal
digests and any suggestions not yet exported.

A file that cannot be parsed is moved aside (`*.corrupt-<timestamp>`), the
dashboard shows a warning, and the app starts with defaults. Nothing refuses
to start over a bad file.

## Platform notes

- **Windows.** No extra permission. Text is typed with PowerShell's
  `SendKeys`; the foreground window is read through a small P/Invoke shim
  kept in one PowerShell process. Programs running as administrator are not
  visible to a normal-privilege listener; run the app as administrator too.
- **macOS.** Grant the app *Accessibility* (to type and read the front
  window) and *Input Monitoring* (for the key listener) under System Settings
  → Privacy & Security. While a password field has secure input on, nothing is
  read and the engine is told so.
- **Linux.** X11 only: `xdotool` is required both to read the active window
  and to type. On Wayland the listener may start but typing is reported as
  unavailable in the dashboard banner.
- Keys are mapped with a US layout plus Shift. Dead keys, AltGr layouts and
  IME composition are not handled; keep triggers to ASCII such as `sig/`.
- The listener observes keys and cannot swallow them, so the character that
  completes a trigger lands in the field and is deleted with the rest.
  Expansions are pasted, so the previous clipboard text is restored shortly
  after each insert.

## Keyboard layouts

The listener maps key presses to characters with a layout table
(`adapters/layouts.js`): plain, Shift, AltGr and Shift+AltGr levels and
dead-key composition (´ ` ^ ¨ ~ followed by a letter; Space types the mark
itself). English (US) is exact. English (UK), German, French, Spanish,
Swedish, Norwegian, Danish, Dutch and Portuguese cover the alphanumeric
block of the usual national variants and are best effort until checked on
a real keyboard. The setting `keyboardLayout` is `auto` by default: the
system layout is read at start (Windows `Get-WinUserLanguageList`, macOS
`AppleSelectedInputSources`, Linux `setxkbmap -query`) and an unrecognised
one falls back to English (US). The Applications tab has the layout choice,
"Detect again", and a test box that shows what actle makes of each key
while the box has the focus; nothing typed there is kept. Input methods
(IME) are still not handled.

## Attaching documents

A document shortcut's popover has **Attach**. The files go into the message
being written in this order: in Outlook on Windows, straight into the open
message through COM; in Thunderbird, a new compose window with the files
attached; anywhere else, the files are put on the clipboard as files (a
Windows file drop list, macOS file references, Linux `text/uri-list` via
`xclip`) and a paste keystroke is sent, which attaches them in Outlook, Apple
Mail, Gmail in a browser, Teams and most editors. When none of that is
possible (Wayland, no `xclip`, a tool failing), the paths are copied as text
and a notification says so; such an attempt is not counted. **Copy file
paths** and **Reveal in folder** remain.

## Simulation

`npm run simulate` builds the same assistant object the tray app uses, with a
temporary data folder and a fixed clock, and drives it with a script: three
near-identical order confirmations in Outlook (learn mode), a refund email
containing a card number and a password (both scrubbed before the corpus is
written), a document shortcut, an undo, a password manager and a banking
portal (never learned / off), then a message the next day. It prints every
action the shell would carry out, the day/week/month/all-time summaries, the
per-application table and the learning candidates, including the template
proposal with its detected slots, the usage report this desk would export,
and a managed desk receiving signed policy layers from a file share, being
paused by IT, and refusing a tampered copy. A stand-in replaces the operating
system keychain so the encrypted corpus can be exercised. It exits 0 when the
pipeline works.

## Not verified

This shell was written in a Linux container without a display, without
Electron and without the native `uiohook-napi` build:

- `npm start` has not been run on any platform; the tray, windows and
  popovers are unverified by eye in any theme.
- `adapters/input.js` (uiohook events, key translation on real keyboards),
  `adapters/active-window.js` (PowerShell, osascript, xdotool),
  `adapters/sender.js` (SendKeys, System Events, xdotool paste and caret
  moves) and `adapters/attach.js` (Outlook COM, Thunderbird `-compose`, file
  drop lists, `osascript` file references, `xclip`) have not been exercised
  against real applications; their scripts are checked by tests with a
  stand-in process runner.
- The uiohook keycode table is built from the module's own `UiohookKey`
  export at run time, so it does not depend on exact codes, but the mapping
  has only been checked with a synthetic table; whether uiohook exposes the
  ISO key left of Z as `IntlBackslash` is unverified. Non-US layout tables,
  AltGr reporting (Ctrl+Alt on Windows, right Alt elsewhere) and the layout
  detection commands have not been tried on a real keyboard.
- Package installation ran with `--ignore-scripts` to produce the lockfile;
  the Electron download and the uiohook native build were not performed.
- `npm run dist` has not been run here: electron-builder, the NSIS, DMG and
  AppImage targets, the `extraResources` copy of the core, and
  `electron-updater` against a real `latest.yml` are unverified until the CI
  job `corporate-desktop` and a Windows desk confirm them. The updater's
  decisions are tested with a stand-in `autoUpdater`.
- `safeStorage` (the keychain behind corpus encryption), the policy refresh
  and upload timers, the save dialogs for usage reports, the warning popover,
  the global palette hotkey and the return of focus to the previous
  application after the palette closes have not run inside Electron; their logic is tested in
  Node with stand-ins and the pages were rendered in Chromium.
