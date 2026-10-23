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

## factle: document filing

factle, the document filing app, watches the folders named in the policy's
`filing.watch` (and any the person adds on the factle tab). A new file is
read once it has stopped growing, and
a popover proposes its name and folder. A file can land while you are typing
in another application, so the popover appears without taking the keyboard
focus, nothing in it is selected, and it files nothing until you click its
name, a blank or a button; after that Enter files it and Esc skips it (Skip
needs no click). A click in its first 0.7 seconds on screen does not count
and leaves no caret in the Name field (it was probably aimed at the window
underneath), and once the popover loses the focus it needs a new click, so
keys typed for another application are never filed. "Never for this
folder" turns off every watch still on that the document came from: its
own folder, or a watched folder above it that includes sub-folders (a
notification names the folder then), and documents already waiting from
there are not shown; when no watch that is on covers the document any more
(for example it was turned off on the factle tab meanwhile), the popover
says so and stays open. The factle tab lists watched folders (a policy
folder can be turned off on this desk; turning one off or removing your own
also drops the documents still waiting from it), the rules, and filed
documents with Undo (refused, with the file left where it is, when the filed
document has changed since it was filed) and Reveal. "File existing
documents…" proposes a filing for each document already in a folder, one at
a time. When the
organisation pauses the desk, an open popover and the search palette close
(what was typed into a fill-in popover is discarded); documents waiting to
be filed stay in the queue, the one whose popover closed first, and are
proposed again when the organisation resumes the desk.

## Windows and the bridge

Every window keeps the page it was opened with: a navigation a page starts
is cancelled and `window.open` is denied (`shell-guards.js`). Reveal on the
factle tab sends the filed document's index id and Show file on the extle
(Excel and Google Sheets) tab the path of the last configuration export;
`filing:reveal` shows nothing
else in the file manager (the documents popover still reveals the files the
policy's document sets name). The filing popover, keyword offers and the
compliance warnings of gactle
open while you type elsewhere and are shown with `showInactive()`,
so they do not activate actle.

## mactle: replies to mail
Copy the message you are answering, then choose "mactle: Reply to the copied message…" in the tray
menu or "mactle: Reply to copied message" in the search palette.
A popover lists the organisation's replies
whose keywords appear in the message, best fit first, blanks filled from it; ↑ ↓ or a click picks
one, blanks the message did not answer are asked right there, Enter closes the popover and pastes
the text where you were writing (never with an open blank). The mactle tab shows the replies with
offered/inserted counts, the extractors and a "Try it" box that ranks a pasted message without
counting anything; counts live in `apps/reply.json`, the message is never stored.

## extle: Excel and Google Sheets

The **extle** tab shows the organisation's vocabularies, column rules and `/` blocks from the policy's `sheets` section. The assistant cannot see spreadsheet cells, so completing happens in the Excel task pane or Google Sheets sidebar from `corporate/sheets-addin/` (its README covers build, sideload, deploy and tests).
The column rules table marks a strict rule ("strict: only its values"): that column completes only to its vocabulary, and the add-in can check it, replace aliases and turn on list validation.
**Try it**: enter a column header (and sheet name), paste the column's values one per line and type what the cell would hold or a `/` trigger to see what the add-in would offer; a strict column offers only its list's values.
**Export add-in configuration** writes the section to `apps/sheets-config.json` in the data folder and shows the path (or why it could not be written); paste that file's contents into the add-in's Settings. **Show file** opens the folder.
The export is logged in the audit (counts only); nothing from the tab is typed into other applications.
**Usage from the add-in**: the add-in counts the completions and blocks it writes into cells and cannot reach the desk itself, so its Usage section gives a text (**Copy for the desk**). Paste it into this box and choose **Import** (channel `sheets:importUsage`): each use becomes one statistics entry of kind `sheets`, application `extle`, at local noon of its day, with each counter's keystrokes spread over its entries. A use is named (the vocabulary or the trigger, source organisation) only when the current policy's `sheets` section defines that name; otherwise it goes into the personal total of usage reports. The same text imported again adds nothing; a later text adds only the uses that are new, per add-in instance, day and counter; a lower count adds nothing. Days after today, days before the history the statistics keep (`retention.metricsDays`) and uses past 20,000 in one import are not imported, and the result line says how many; importing the same text again adds the uses past 20,000. A text that is not the add-in's, or breaks one of its limits, is refused with the reason and adds nothing. The text is not signed: the desk cannot tell it from one edited by hand, and the limits bound what one text can add. The audit gets `sheets-usage-imported` with counts only; the line beside **Import** shows the last import.

## cactle: CRM and ticket forms

Put the caret in the first field of a form and type a record's trigger (or pick the record in the search palette). A popover shows the form matched to the window, the values about to be typed, the fields Tab will pass over, and the blanks still open. Copy an order or customer reference first and the lookup row fills the customer fields; or type it into the Reference box. Enter closes the popover and fills the form: the trigger is deleted, each value is pasted and Tab moves on, once per field in between. Selectors from the policy are shown but not used, so the form's fields must be in Tab order. If a key fails, a notification names the field it stopped at and nothing is counted.

The cactle tab lists the organisation's records, lookups (first 20 rows) and forms, your own records (Delete), the proposals learned from your fills (Accept under a name and a trigger of your choice, or Dismiss), a box to try a reference, and Clear for the stored fills. Fills are stored only when a form matched, and only with the values that come from the record itself and the organisation's lookup lists: nothing you type into the popover, no value of a field whose name has a word such as password, PIN, credential, CVV, IBAN or SSN in it, and no card number, labelled secret, long token, IBAN or US, UK, Spanish or French national ID number found in a value. Fills older than the policy's `retention.corpusDays` go at start and at every fill; Clear deletes them all, and so does "Delete learned text" while that button is enabled.

## gactle: compliance warnings

When a compliance rule of your organisation fires on what you type, a small "Before you send" window appears beside your work without taking the focus: each warning shows the rule, its severity, the message and what was found, masked. A word ended by Enter, Tab or a shortcut such as Ctrl+Enter counts too; actle cannot hold a key back, so the warning for the word that sent a message appears just after it went out, and without a fix: the window says to check the message and correct it by hand. Nothing is checked in the terminals, password managers and sign-in windows actle recognises, and it keeps no field text there. **Add the text** or **Insert …** types the fix where the caret is. **Copy corrected text** puts a corrected copy of what you typed in this field on the clipboard, because actle cannot change what is already in the field: select that text and paste over it (refused for messages of 4,000 characters or more). **Dismiss** records that you saw the warnings. A later warning or offer replaces the window, and a fix clicked after you moved to another window, or while your organisation has paused actle, is refused: type it by hand. Rules for outside recipients only warn while typing when the policy says so (`assumeExternal`), since the recipients of a message cannot be read.

The gactle tab in the dashboard lists the rule packs, counts the warnings raised, fixed, dismissed and left unanswered per rule, and has a "Try it" box to check a text with recipients and an application typed in. Only rule ids and outcomes are recorded; what you typed never is.

## dactle: minutes, handovers and logs

Type a note document's trigger from the policy (for example `/mins`) in any application, or pick the document in the search palette: a popover asks for its blanks (your name is prefilled from the last note you inserted or saved on the dactle tab; a list such as attendees takes comma-separated values), and Enter closes the popover and pastes the note with the date and weekday filled and the caret where the document says. Nothing is pasted while a blank is empty; a list of a repeated section that needs more values is named with its counts.
To collect action items, copy the whole note, choose "dactle: Update action items in the copied note" in the tray menu (or the palette entry), then paste over the note: the action block is rebuilt on the clipboard, lines you typed into it are kept, and nothing is counted in the statistics.
The dactle tab lists the documents, keeps your author name and has a "Try it" box that shows the action items found in a pasted note and the rebuilt note.
Data: `settings.json` gains `notesAuthor`; `apps/notes.json` holds counts only (inserts per document, clipboard updates); note text and answers are never written.

## Where data lives

Everything is in Electron's `userData` folder for the app
(`%APPDATA%\actle-corporate-desktop` on Windows,
`~/Library/Application Support/actle-corporate-desktop` on macOS,
`~/.config/actle-corporate-desktop` on Linux):

| File              | Contents                                                        |
| ----------------- | --------------------------------------------------------------- |
| `library.json`    | Own shortcuts, in the shared `shorthands.json` format (version 1) |
| `policy.json`     | The organisation policy, if one was installed                   |
| `settings.json`   | Enabled flag, own capture rules, typing-speed override, `shiftEnterForNewlines` and `startWithSystem`, own watch folders and the policy folders turned off, the desk id (`installId`, generated by actle), the dactle author, palette hotkey (`paletteShortcut`, an Electron accelerator: a function key, or a chord with Command, Super or Meta, or with Control and no Alt/Option/AltGr, so it never takes a typed character away; `""` turns it off; anything else falls back to the default). Other keys are dropped. |
| `metrics.jsonl`   | One line per insert: time, kind, application, keystrokes saved, whether the shortcut was the organisation's or the person's; uses imported from the extle add-in are kind `sheets`, application `extle`, at noon of their day |
| `corpus.jsonl`    | Scrubbed text from learn-mode applications, each record encrypted (AES-256-GCM), pruned by retention |
| `corpus.key`      | The corpus key, itself encrypted by the operating system keychain (Electron `safeStorage`) |
| `learned.json`    | SHA-256 digests of proposals the person dismissed (no readable text) |
| `suggestions.json` | Proposals the person chose to suggest to the organisation, readable, until exported, removed or deleted with the learned text |
| `filing-index.json` | Documents filed by the filing rules: new and old name and path, rule, values found (a client, a reference); never document text |
| `apps/<app>.json`  | The suite's per-app data: reply counts, forms fill sessions (values from the policy only) and own records, the notes author, the last extle export and import, and the extle uses imported so far per add-in instance id, day and counter (kind, source and the vocabulary name or trigger, with use and keystroke counts; days past `retention.metricsDays` are dropped at the next import); `apps/sheets-config.json` is the exported add-in configuration |
| `deployment.json` | Managed desks only: signed policy sources and pinned public keys, written by IT |
| `policy-cache/`   | Last good copy of each signed policy layer                     |
| `policy-state.json` | Hash of the policy last applied and each source's status     |
| `audit.jsonl`     | Policy changes, failing or recovering sources, capture-rule changes, corpus key and deletion events, documents filed or unfiled (paths only); never typed text |

The files actle writes there are created readable by your account only
(0600) and its folders 0700, and older ones your account owns are tightened
when actle starts; on Windows the profile's permissions apply.

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
digests, any suggestions not yet exported and the fills cactle stored for
learning; the button is enabled only while learned text is stored, and the
cactle tab's "Clear stored fills" deletes the fills at any time.

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
  Expansions are pasted, so the previous clipboard text is restored about
  0.6 s after the last paste of an insert (or of a whole cactle fill) was
  sent, unless something else was copied in the meantime or the clipboard
  could not be read before the paste.

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

- The app has only been started on Linux under Xvfb, with Electron 44.9.0
  installed outside the repository and no uiohook listener, to check the
  filing popover, with openbox and without a window manager: it appears
  without taking the focus from another application, keys and Enter typed
  there stay in that application, a click on the Name field then files the
  document, and "Never for this folder" from a sub-folder turns the
  recursive watch off; seen in the light and the dark theme. Also there,
  with openbox: a click 0.2 seconds after the popover appeared, then typing
  and Enter, filed nothing and left the name as proposed; a click, a switch
  to another window and the focus handed back, then typing and Enter, filed
  nothing; a later click filed in both cases. Keyword offers and gactle
  warnings were not opened in Electron (no uiohook listener); a stand-in
  `focusable: false` window shown with `showInactive()` kept the focus where
  it was and took a click, as `show()` does on Linux. Nothing has run on
  macOS or Windows: `showInactive()` there (on macOS it is meant to stop
  `show()` from activating actle), and the first click into an inactive
  window (macOS uses it to activate the window, so a second click may be
  needed), are unverified. The tray, the dashboard and the other popovers
  are unverified by eye in any theme.
- `adapters/input.js` (uiohook events, key translation on real keyboards),
  `adapters/active-window.js` (PowerShell, osascript, xdotool) and
  `adapters/sender.js` (SendKeys, System Events, xdotool paste and caret
  moves) have not been exercised against real applications.
- The uiohook keycode table is built from the module's own `UiohookKey`
  export at run time, so it does not depend on exact codes, but the mapping
  has only been checked with a synthetic table.
- Package installation ran with `--ignore-scripts` to produce the lockfile;
  the Electron download and the uiohook native build were not performed.
- `safeStorage` (the keychain behind corpus encryption), the policy refresh
  timer, the save dialogs for usage reports, the warning popover, the global
  palette hotkey and the return of focus to the previous application after
  the palette closes have not run inside Electron; their logic is tested in
  Node with stand-ins and the pages were rendered in Chromium.
