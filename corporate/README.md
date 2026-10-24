# actle Corporate – the business edition

A desktop assistant for organisations that expands the same shortcut library
as the personal apps in **every** application on Windows, macOS and Linux, and
adds what a business asks for:

- **Statistics**: keystrokes saved and estimated time saved, overall and per
  day, week and month, and per application.
- **Learning where a person allows it**: for applications the person or the
  organisation opts in (mail clients, typically), the text typed there is kept
  locally so recurring sentences, paragraphs and phrases can be proposed as
  shortcuts.
- **Variable detection**: messages that differ only in a name, a date, an
  order reference or an amount are shown as a diff overlay (unchanged text in
  one colour, each changing part in another, with the values seen so far) and
  can be saved as one `[[name]]` fill-in template, the same syntax the browser
  extension already uses.
- **Keyword offers**: when certain words are written ("refund", "customs" and
  "shipment" together, "office hours"), the assistant offers to insert
  predetermined text, a saved shortcut or a document set.
- **Document shortcuts**: typing `/sld` lists the files the organisation marked
  as the standard hand-outs for "shipping logistics department", so they can be
  attached in one step.
- **Document filing (factle)**: new files in watched folders (downloads,
  scanner output) are read on the desk, named from the organisation's naming
  rule (`[[date]]_[[client]]_invoice_[[ref]]`) and moved to the folder the rule
  says, after the person confirms. Filed documents are indexed by name, folder
  and the values found, never by their text, so the search palette finds them
  from any application. Plain text, Word and Excel are read without any
  dependency; PDFs and scans are judged by their file name for now.
- **Compliance warnings**: a rule can warn instead of offer, for example when
  "contract" is written without the legal disclaimer or a card number is typed
  into a message, with an optional one-click fix.
- **Central management**: signed policy files fetched from an intranet URL or
  a file share, layered organisation, department and team; rollback
  protection; an administrator kill switch; and a change log on every desk.
- **Search palette**: Ctrl+Shift+Space (Cmd+Shift+Space on macOS) opens a
  search over every shortcut and document set in any application; Enter
  inserts the choice where the person was typing.
- **Phrase suggestions**: a person can suggest learned proposals to the
  organisation; the administrator ranks suggestions across desks and turns
  the best into shared shortcuts.
- **Usage reports**: a counts-only report a person previews and exports, and
  an administrator roll-up with hours saved per team, estimated value,
  shortcuts by use and shortcuts nobody uses.
- **One organisation policy file** drives all of it:
  [`shared/ORG-POLICY.md`](shared/ORG-POLICY.md), with a complete example in
  [`shared/org-policy.example.json`](shared/org-policy.example.json).

This folder is the corporate side of the repository. `AGENTS.md` at the root
says which edition a task touches: a task that names the corporate side changes
only this folder; any other task changes both editions.

## Assessment of the repository it builds on (2026-10-20)

| Area | State found | Reused here |
| ---- | ----------- | ----------- |
| `chrome-extension/` | The primary product. Manifest V3, no runtime dependencies, 260 unit tests and Chrome/Firefox end-to-end suites, all green on this machine. `src/expander.js` (matching, placeholders, sanitising) and `src/template.js` (`[[name]]` blanks, pronoun and weekday variables) are DOM-free UMD modules. | Both modules are required directly from `core/personal.js`, so a rule change in the personal edition reaches this one without a copy. |
| `windows/` | .NET 8 tray app with a low-level keyboard hook, a 200-character typing buffer, Backspace undo and `SendInput` typing. Windows only; could not be built here (no .NET SDK). | Its engine design (buffer, reset on focus change, undo window, swallowed trigger key) is the model for `core/engine.js`, generalised to adapters that cannot swallow keys. |
| `android/` | Accessibility-service app. Not relevant to a desktop product. | Nothing. |
| `shared/` | `SPEC.md` and `conformance.json`, run by three suites. | Runs here as a fourth suite, twice: against the shared modules and key by key through the engine. |
| Premium / licensing | A preview with a local daily counter and signed Forever licences; purchases are not open. | Not wired in. A business licence model is a product decision for the owner (see follow-ups). |

What the personal edition lacks for a business, and this folder adds: a place
to run outside the browser on every operating system; any statistics; any
learning; variables detected from real messages rather than written by hand;
keyword and document features; a shared, administrator-controlled library.

## Layout

```
corporate/
  package.json                dependency-free core; `npm test`, `npm run check`, `npm run simulate`
  core/
    personal.js               bridge to the personal edition's expander and template modules
    metrics.js                ledger: keystrokes saved, time saved, day/week/month/all, per app
    capture-policy.js         per-application modes (off / triggers / learn), sensitive-context rules, secret scrubbing
    diff.js                   word-level diff and similarity
    variable-detector.js      slots across similar messages -> [[name]] template + overlay segments
    phrase-miner.js           recurring sentences, paragraphs and phrases across messages
    keyword-rules.js          keyword offers and compliance warnings, once per field
    documents.js              document shortcuts (/sld) and search
    extract.js                local text extraction: plain text, .docx, .xlsx (zip + XML, no dependency)
    filer.js                  filing rules, field detection, safe names, the index of filed documents, and the no-overwrite move and folder resolution the desk and the admin tool share
    palette-search.js         search palette items, scored by the extension's palette module
    org-policy.js             the organisation policy parser and layer merge (skips bad parts, never refuses)
    policy-signing.js         Ed25519 signing and verification of policy files
    policy-source.js          fetch signed layers, verify, refuse replays, keep the last good copy
    report.js                 counts-only usage reports, team roll-up, CSV
    suggestions.js            phrase suggestions a person shares, ranked across desks
    crypto-box.js             AES-256-GCM records for the learning corpus
    engine.js                 headless assistant: keys + focus in, actions out
    store.js                  app-data files: library, policy, settings, metrics log, learning corpus, audit log
  admin/
    actle-admin.js            keygen, sign, verify, validate, layers, report, suggestions, file
  test/                       node --test suites for every module, plus the shared conformance suite
  shared/
    ORG-POLICY.md             policy file format
    org-policy.example.json   complete example used by the simulator and the tests
  desktop/                    Electron shell, input and typing adapters, folder watcher, dashboard, headless simulator
    apps/                     the suite's apps (reply, sheets, forms, guard, notes): shell logic, simulate steps
    renderer/apps/            their dashboard tabs and popovers
  sheets-addin/               Excel task pane and Google Sheets sidebar for extle (build.js bundles the core and writes the package; INSTALL.md)
```

The core has no dependencies beyond Node's standard library and the two
personal modules. Everything a reviewer needs to reason about lives there;
the desktop shell only carries actions out.

## How it works

1. The input adapter reports the focused window (process name, title) and
   every key press. The engine asks the capture policy for the window's mode.
2. In **triggers** mode (the default), a rolling buffer of the last 200
   characters is matched against the merged library (the person's own
   shortcuts win over the organisation's) and the document shortcuts. A match
   returns an `expand` action (how many characters to delete, what to type,
   where the caret goes), a `template` action (the shell opens a form), or a
   `documents` action (the shell lists the files). Backspace right after an
   expansion returns the trigger, and an undone expansion is not counted. An
   expansion with a character made of several code points (an emoji with a
   skin tone, a flag, a family, a keycap, an accent typed as a combining mark)
   is not undone this way, because applications differ in how many Backspaces
   remove such a character: the Backspace deletes as usual, the expansion is
   counted, and the application's own undo (Ctrl+Z) can remove it.
3. In **learn** mode, the text of the current field session is also kept.
   When the focus moves, the session is scrubbed (card numbers, labelled
   secrets and token-like strings are masked) and stored. The phrase miner
   proposes texts that recur in at least three distinct messages; the variable
   detector clusters similar messages and proposes templates.
4. Keyword rules are checked each time a word ends; each rule is offered once
   per field. A word ended by Enter, Tab, a shortcut key or a caret key raises
   warnings only, without an insert or a fix, since the key may have sent the
   message; offers wait for the next word typed in the field. Nothing is
   checked, and no field text is held, in the credential prompts, password
   managers and terminals actle recognises.
5. The folder watcher reports a new document once it has stopped growing. The
   assistant reads it, proposes a name and folder from the filing rules, and
   the shell asks the person to confirm. See "factle: document filing" in
   `shared/ORG-POLICY.md`.
6. Every insertion is recorded in the metrics log with the keystrokes it
   saved (graphemes inserted minus graphemes typed). Time saved is estimated
   from a typing-speed assumption in the policy (default 200 characters a
   minute, which is 40 words a minute); attachments count a fixed number of
   seconds each. Changing the assumption re-estimates history.

### What learn mode stores, and what it never stores

Learn mode is the "almost a key logger" behaviour the business asked for, and
it is bounded on purpose:

- Only applications listed with `mode: "learn"` in the policy or by the
  person; everything else stays in triggers mode (nothing stored).
- Never for credential prompts, password managers, terminals or secure-input
  fields, even when a rule says `learn`. actle recognises the first three by
  process name or window title; in them no field text is held and no keyword
  rule or check of gactle (the compliance warnings app) runs, but shortcuts
  still expand. In a secure-input field nothing is read at all.
- Only text typed into fields, per session, after scrubbing; window titles are
  not stored.
- Locally, under the app-data folder, encrypted with a key held in the
  operating system keychain, for `retention.corpusDays` (default 90). Without
  a secure keychain nothing is written. Proposals a person explicitly marks
  "Suggest to organisation" are the one readable copy, kept until exported.
  The Learning tab shows how much is stored and deletes all of it, those
  suggestions included; switching an application to triggers mode stops
  learning there.
- Nothing typed is ever sent anywhere. The only network access is fetching
  signed policy files on a managed desk; usage reports are files the person
  saves and hands over.

## The suite

factle, the document filing app above, is the first of six dedicated business
apps that share one engine, one policy file and one desk. The desktop
assistant that runs them is actle; each app has its own name, while its
policy section keeps the id (`filing`, `reply`, `sheets`, `forms`, `guard`,
`notes`). The other five are built on the app registry in `desktop/apps/`
(one folder per app: its shell logic, a dashboard
tab under `renderer/apps/`, popovers, a headless `simulate.js` and tests), with
their rules in `core/<app>.js` and their policy sections documented in
`shared/ORG-POLICY.md`. Like everything else here, nothing leaves the desk:
the inputs are typed keys, the clipboard and the popover forms, and what is
stored is ids and counts.

| App | Where | What works today |
| --- | --- | --- |
| mactle (replies to mail) | `core/reply.js`, `desktop/apps/reply/` | Tray entry and palette item rank the organisation's replies against the copied message (quoted history and Outlook header blocks dropped), fill blanks from it (sender name from the sign-off, greeted name, order and ticket references, date, amount, policy extractors), ask for the rest in a popover, close it and paste the text; per-reply counts, library warnings and a "Try it" box on the mactle tab; kind `reply` in metrics and usage reports. Cannot read the compose window or the recipients (the message must be copied first), cannot tell whether a reply was edited before sending, and the popover and tab have not been seen in Electron. |
| extle (Excel and Google Sheets) | `core/sheets.js`, `desktop/apps/sheets/`, `sheets-addin/` | Works: the extle tab shows vocabularies, column rules and blocks, tries completions against pasted column values and exports the section for the add-in (a failed write is reported, not thrown); `sheets-addin/build.js` bundles the core for the browser reproducibly, and in package mode (`--package extle.config.json`) writes what an organisation installs: the folder an HTTPS host serves for Excel, with a manifest made from `manifest.template.xml` and the organisation's GUID, address, name and version (each checked; a placeholder GUID or `localhost` only with `--dev`) and ribbon icons drawn by the build, and the Apps Script files; `sheets-addin/INSTALL.md` takes it from there to Excel and Google Sheets, step by step. The shared pane plus the Excel (Office.js) and Google (Apps Script) bridges are driven headlessly against fake hosts in `sheets-addin/test/`. A strict column (`strict: true`) completes only to its list, and the pane checks it against the list (writing nothing), and after a confirmation replaces aliases with the list's spelling or turns the host's list validation on and off. Values a cell could read as a formula (starting with `=`, `+`, `-`, `@`, tab or CR, unless a plain signed number; or with a full-width `＝`, `＋`, `－`, `＠`, with no number exception) never come from a list or a column; the replacement never writes into a cell that holds a formula, and list validation refuses values typed into the column, not a plain paste in Excel or values already there. The pane counts each completion and block it writes, per day and counts only (`core/sheets-usage.js`), keeps the counts in the browser (Excel) or the person's Apps Script user properties (Google), and hands them over as a text the person copies; the extle tab imports it (channel `sheets:importUsage`), each new use becoming a metrics entry of kind `sheets` (application `extle`) that usage reports name when the policy defines its vocabulary or trigger. Not verified: the task pane, the sidebar and the manifest were never run against a real Excel or Google Sheets (list validation, storage of the counts and the clipboard included), and no package was sideloaded, uploaded to the Microsoft 365 admin center or published to Google Workspace Marketplace. |
| cactle (CRM and ticket forms) | `core/forms.js`, `desktop/apps/forms/` | With the caret in a form's first field, typing a record's trigger (or picking the record in the palette) opens a plan popover for the form matched to the focused window: a copied or typed reference fills the customer fields from a lookup list, open blanks are asked, and Fill closes the popover and pastes the values in Tab order with a Tab per form field in between, counting one `form` insert; a key that fails stops the fill with a notification and counts nothing. Fills on matched forms are stored for learning with only the values that came from the record and the lookup row (nothing typed into the popover, no value of a field whose name has one of the listed secret words, no value the scrubber masks or in which gactle detects an IBAN or a national ID). They are removed once older than `retention.corpusDays` (at start and at every fill) and deleted by "Clear stored fills" or "Delete learned text". Field sets filled together three times become proposals, labelled "Learned record N on <form>", that the person can name and accept as own records. Fill is refused while the organisation has paused actle, also when the pause arrives during the 150 ms focus wait. Not working: selectors are shown but not used (Tab order from the form's first field only), nothing is read from the form, fills without a matched form are not stored, no tray entry; the popover and tab have not been seen in Electron. |
| gactle (compliance warnings) | `core/guard.js`, `desktop/apps/guard/` | Works: word-end checks of the typed field (a word ended by Enter, Tab or a shortcut key included) against the policy's rule packs (card numbers, IBANs, e-mail addresses, phone numbers, national IDs US/GB/ES/FR, forbidden phrases, internal codes, secrets), a warning window that never takes the focus with masked findings (one at a time; a later warning replaces it), text and shortcut fixes typed at the caret, remove fixes through the clipboard with a note that the copy covers only what was typed in the field, a fix refused after the focus moved or while actle is paused, a clipboard fix refused when the field holds 4,000 characters or more, Dismiss, counts-only audit and metrics, a dashboard tab with packs, counts per rule and a "Try it" box with recipients and application; channels `guard:info`, `guard:summary`, `guard:check`; headless simulation. Does not: read recipients (external rules need `assumeExternal` or the Try-it box), edit text already in the field, fill a shortcut's blanks, keep its window open after one fix, hold back a message sent with Enter or Ctrl+Enter (the warning for that last word appears as it goes out, without a fix), see pasted text, check the last word before a mouse click on Send, run in the credential prompts, password managers or terminals actle recognises, or block anything (`block` is a label). The popover and tab have not been seen in Electron. |
| dactle (minutes, handovers and logs) | `core/notes.js`, `desktop/apps/notes/` | A document trigger or a palette item opens a fill popover (blanks, author remembered, comma-separated lists, short lists of a repeated section named with their counts), closes it and pastes minutes, handovers and logs with date, weekday and caret placed; a tray or palette entry rebuilds the action block of a copied note on the clipboard (owners, due dates resolved, hand-typed lines kept, idempotent); dactle tab with documents, author setting and a "Try it" box; metrics kind `notes`, usage reports name documents. Does not read the editor: action items come only from the clipboard and a note's document is guessed from its block heading; on macOS the app cannot hide actle's windows before the paste; phrasing suggestions from earlier notes are not offered. |

Each app's popover closes before the paste and refuses to paste while a
blank is unfilled. The Electron windows have not been run here (see Status);
the headless simulator walks through every app.

## Run

```
cd corporate && npm test             # core, admin and assistant tests, including the shared conformance suite
cd corporate && npm run check        # node --check on every file
cd corporate && npm run simulate     # whole pipeline headlessly, no Electron needed
cd corporate/desktop && npm install  # downloads Electron and builds the keyboard listener
cd corporate/desktop && npm start    # tray icon + dashboard
cd corporate/sheets-addin && node build.js --package extle.config.json   # the extle package (sheets-addin/INSTALL.md)
```

See [`desktop/README.md`](desktop/README.md) for platform permissions
(macOS Accessibility and Input Monitoring, Linux X11 and `xdotool`) and the
data folder location.

## Status

Built and verified on this machine (Linux, Node 22): the whole core, its
tests, and the headless simulator.

Not verified here: the Electron shell, the global keyboard listener
(`uiohook-napi`) and the per-platform typing commands. There is no display, no
Electron runtime and no Windows or macOS machine in this environment. The
shell is written against the tested core and guarded so that a missing
listener still starts the dashboard with a visible warning, but it has not
been run. The first thing to do on a real desk is `npm install && npm start`
in `desktop/` and the checklist at the end of `desktop/README.md`.

## Follow-ups

- Licensing and installer packaging for organisations (per-seat, signed
  installers, silent install). Nothing from the personal premium preview is
  wired in. Policy signing and distribution exist (see ORG-POLICY.md).
- Dead keys and input methods: the listener maps a US layout; other layouts
  need a per-platform translation (the personal Windows app has the same
  limit).
- Attaching files directly into a mail client's compose window is
  platform-specific; the shell copies the paths and reveals the files, and
  counts an attachment only when the person confirms it.
- Usage reports travel as files the person saves; an upload to a collection
  point is not built, deliberately, so nothing leaves a desk without the
  person's action.
- The suite apps were not run in Electron, Excel, Google Sheets, Word or
  Google Docs here (no
  display, no Office, no Google account); each is exercised headlessly by its
  tests and the simulator. cactle fills fields in Tab order only (selectors
  from the policy are shown, not used); gactle cannot change text already in a
  field (a corrected copy goes to the clipboard); mactle and dactle read the
  message or note from the clipboard because the desk cannot read a window's
  text; the extle add-in's counts reach the desk only as a text the person
  copies from the pane and pastes into the extle tab.
- The extle package has been built and read here, never installed: Microsoft's
  manifest validator was not run (it needs a Microsoft service this
  environment cannot reach), and the build makes no icon for a Google
  Workspace Marketplace listing, whose required sizes were not confirmed.
- Document filing reads PDFs and scanned images by file name only. Reading
  their text needs a PDF library and OCR in `desktop/` (the core stays
  dependency-free); that is the owner's call. Filing by sender or source
  folder, and attaching a filed document straight into a mail compose window,
  are not built.
