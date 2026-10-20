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
    actle-admin.js            keygen, sign, verify, validate, layers, report, suggestions
  test/                       node --test suites for every module, plus the shared conformance suite
  shared/
    ORG-POLICY.md             policy file format
    org-policy.example.json   complete example used by the simulator and the tests
  desktop/                    Electron shell, input and typing adapters, dashboard, headless simulator
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
   expansion returns the trigger, and an undone expansion is not counted.
3. In **learn** mode, the text of the current field session is also kept.
   When the focus moves, the session is scrubbed (card numbers, labelled
   secrets and token-like strings are masked) and stored. The phrase miner
   proposes texts that recur in at least three distinct messages; the variable
   detector clusters similar messages and proposes templates.
4. Keyword rules are checked each time a word ends; each rule is offered once
   per field.
5. Every insertion is recorded in the metrics log with the keystrokes it
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
  fields, even when a rule says `learn`.
- Only text typed into fields, per session, after scrubbing; window titles are
  not stored.
- Locally, under the app-data folder, encrypted with a key held in the
  operating system keychain, for `retention.corpusDays` (default 90). Without
  a secure keychain nothing is written. The Learning tab shows how much is
  stored and can delete all of it; switching an application to triggers mode
  stops learning there.
- Nothing typed is ever sent anywhere. The only network access is fetching
  signed policy files on a managed desk; usage reports are files the person
  saves and hands over.

## Run

```
cd corporate && npm test             # core, admin and assistant tests, including the shared conformance suite
cd corporate && npm run check        # node --check on every file
cd corporate && npm run simulate     # whole pipeline headlessly, no Electron needed
cd corporate/desktop && npm install  # downloads Electron and builds the keyboard listener
cd corporate/desktop && npm start    # tray icon + dashboard
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
