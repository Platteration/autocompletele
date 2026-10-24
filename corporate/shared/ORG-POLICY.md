# Organisation policy format (business edition)

One JSON file that an administrator distributes to every desk. The desktop
app reads it from `policy.json` in its data folder (or from the path given by
the `ACTLE_POLICY` environment variable) and re-reads it on start. Everything
in it is optional; an empty object is a valid policy. Invalid entries are
skipped with a warning shown on the dashboard, never a refusal.

`org-policy.example.json` in this folder is a complete example.

The suite's apps each read their own section of the policy: factle, the
document filing app (`filing`); mactle, the replies to mail app (`reply`);
extle, the Excel and Google Sheets app (`sheets`); cactle, the CRM and ticket
forms app (`forms`); gactle, the compliance warnings app (`guard`); and
dactle, the minutes, handovers and logs app (`notes`). See **The suite**
below.

| Field | Meaning |
| ----- | ------- |
| `version` | `1`. A newer number is accepted with a warning; unknown fields are ignored. |
| `serial` | Positive integer, required for a signed policy. Raise it every time the policy changes; desks refuse a signed policy whose serial is lower than the one they already accepted for that source, or the same serial with different content. |
| `layer` | Required for a signed policy: the name of the layer it is for, matching the `layer` of the deployment source it is published at. A desk refuses a policy signed for another layer, so an old organisation policy cannot be replayed at a team's location. |
| `paused` | Kill switch. `true` or `{ "message": "…" }` pauses every desk that receives the policy: nothing is expanded, offered or learned, and the dashboard and tray offer no way to resume it. Nothing is deleted. When the pause reaches a running desk, an open popover and the search palette close (what was typed into a fill-in popover is discarded); documents waiting to be filed stay queued and are proposed again after the resume (the queue is kept in memory, so a restart empties it). Remove it (or set `{ "active": false }`) to resume. It is an administrative control, not a security boundary: `deployment.json` lives in the person's own data folder, so someone who edits that file can leave central management. |
| `organization` | Name shown on the dashboard. |
| `typing.charsPerMinute` | Typing-speed assumption behind "time saved" (default 200, which is 40 words per minute). Changing it re-estimates history. |
| `typing.secondsPerAttachment` | Time credited for each document attached through a shortcut (default 20). |
| `typing.secondsPerFiling` | Time credited for each document named and filed by a filing rule (default 45). |
| `capture.defaultMode` | `off`, `triggers` (default) or `learn` for applications no rule names. |
| `capture.apps[]` | Per-application rules, first match wins. `match.process` (one name or a list; `.exe` and paths are ignored), `match.bundleId` (macOS) and `match.title` (regular expression, case-insensitive) identify the window. `mode` is as above. |
| `library` | The shared shortcut library in the personal `shorthands.json` format (`shared/SPEC.md` at the repository root). A person's own shortcut with the same trigger wins. |
| `keywordRules[]` | `keywords` (list), `match` (`any` default, or `all`), `caseSensitive` (default false) and `insert`: `{ "kind": "text", "text": ... }`, `{ "kind": "shorthand", "trigger": ... }` (must exist in `library`) or `{ "kind": "document", "shortcut": ... }` (must exist in `documents`). Each rule fires once per field. |
| `keywordRules[].action` | `offer` (default) shows the insert. `warn` shows `message` (required) and offers `insert` as an optional fix: a compliance warning. |
| `keywordRules[].detect` | Built-in detectors that must also fire. `card-number` finds a card number that passes the Luhn check. A rule may have `detect` instead of `keywords`. |
| `keywordRules[].unless` | Phrases that stop the rule when any of them appears in the field (case and spacing ignored), for example the disclaimer itself. What is seen is the text typed in the field, or inserted by actle, since the field last got the focus, up to the last 4,000 characters. Opening actle's search palette or dashboard counts as leaving the field. A mail client's automatic signature, pasted text and text further back are not seen, so the warning can appear although the phrase is there. |
| `documents.shortcuts[]` | `trigger` (for example `/sld`), `label`, and `documents[]` with `title`, `path` (file path or URL), optional `tags` and `description`. Triggers follow the same boundary rule as text shortcuts and lose to a text shortcut with the same trigger. |
| `filing.watch[]` | Folders where new documents land: `path` (a leading `~` is the person's home folder), optional `label`, `recursive` (default false). A person can turn a policy folder off on their desk and add folders of their own. |
| `filing.fields` | Values a naming rule can use, by blank name: `values` (the organisation's spellings, matched as whole words, case-insensitive), `aliases` (`{ "ACME": "Acme Logistics GmbH" }`), `pattern` (regular expression, first match; `group` picks a capture group). The built-in blanks `date`, `year`, `month`, `day`, `original` (the old name without extension) and `ext` cannot be redefined. |
| `filing.rules[]` | In order, first match wins: `id`, `label`, `when` (`keywords` with `match` `any` (default) or `all`, matched in the document's text and its file name; `extensions` to limit the rule to some file types; one of the two is required), `name` (a `[[blank]]` template; no path separators) and `folder` (a template too; empty renames in place; a leading `~` is the home folder of the person, or of the account running `actle-admin file`; a relative folder is relative to the document's own folder, on the desk and in `actle-admin file` alike). |
| `filing.fallback` | `name`, `folder`, `label` for documents no rule matches. Without it, such documents are left alone. |
| `filing.dateOrder` | `dmy` (default) or `mdy`: how `21/10/2026`-style dates are read. ISO dates and written months are unambiguous. |
| `learning.minCount` | Distinct messages a text must recur in before it is proposed (default 3, minimum 2). |
| `learning.minLength`, `learning.minWords` | Smallest text worth proposing (defaults 20 characters, 4 words). |
| `reporting.team` | Team name written into each desk's usage report. |
| `reporting.hourlyRate`, `reporting.currency` | Used to turn hours saved into an estimated value in the roll-up. |
| `reporting.period`, `reporting.periods` | Buckets in a usage report: `day`, `week` (default) or `month`, and how many (default 12). |
| `reporting.includeApps` | `true` adds per-application totals to usage reports (default `false`). |
| `retention.metricsDays` | Days of statistics kept on disk (default 365). |
| `retention.corpusDays` | Days of learning text kept on disk (default 90). |
| `reply.replies[]` | One prewritten reply: `id` (defaults to its position; a duplicate gets `-dup`), `label` (defaults to the id), `keywords` (list, required; whole words in the copied message, case-insensitive unless `caseSensitive` is true), `match` (`any` default, or `all`), and exactly one of `text` (may carry `[[blanks]]`, `{cursor}` and the other placeholders) or `shorthand` (a trigger from the merged library; a reply whose shorthand is not in the library is never offered and is listed as a warning on the mactle tab). |
| `reply.replies[].extract` | Extractors for this reply only, same shape as `reply.extract`, layered on top of the section's values: one with the same name wins over the section extractor or the built-in blank when it finds a value. The built-ins and the section extractors are not run again for the reply, so a section extractor's override of a built-in stays. |
| `reply.extract` | How blanks are filled from the message, by blank name: `{ "pattern": "regex", "group": n }` (first match, case-insensitive; `group` defaults to 0, the whole match) or `{ "after": "Label" }` (what follows the label on the same line, without the separator, at the first occurrence where something follows it; a value on the line below the label is not found); a bare string is a pattern. A policy extractor wins over the built-in blank of the same name when it finds a value. Built-in blanks: `name` and `firstName` (from the last sign-off line, such as "Kind regards," followed by the name), `greeted` (from a greeting in the first three lines), `order`, `reference` (ticket, case, ref, invoice; at least three digits, never a date), `date` (first date, ISO), `amount` (first amount with a currency). |
| `reply.max` | How many replies the popover lists (default 3, 1 to 10). |
| `reply.dateOrder` | `dmy` (default) or `mdy`: how `3/4/2026`-style dates in the message are read. |
| `sheets.vocabularies` | Object of name → `{ values: [...], aliases: { alias: value } }`, or a plain list of values. A vocabulary without a usable values list, or with no usable value, is skipped with a warning. |
| `sheets.vocabularies.<name>.values` | The organisation's one spelling of each value. Compared case-insensitively: the first spelling is kept and a different one is warned about; empty values and values a cell would read as a formula (leading `=`, `+`, `-`, `@`, tab or CR, unless a plain signed number; or leading full-width `＝`, `＋`, `－`, `＠`, with no number exception) are skipped. |
| `sheets.vocabularies.<name>.aliases` | alias → value. The value must be in the vocabulary; an alias that is itself another value, or already means another value, is skipped. Typing an alias completes to the value. |
| `sheets.columns` | List of rules tried in policy order; the first whose patterns hold decides how a column completes. Each needs a `match` object and exactly one of `vocabulary` or `kind`. |
| `sheets.columns[].match.header`, `.sheet` | Case-insensitive regular expressions tested against the column header (row 1) and the sheet name; at least one is required, an omitted one matches anything; an invalid pattern skips the rule. |
| `sheets.columns[].vocabulary` | Name of a vocabulary above (unknown names skip the rule). The column offers the vocabulary's values first, then its own values; column spellings and aliases of a vocabulary value count towards it and are not offered themselves. A vocabulary column whose values look like numbers or dates still completes from the vocabulary. |
| `sheets.columns[].strict` | Optional, `true` or `false` (the default). `true` makes a vocabulary column strict: it completes only to the vocabulary's values (an alias completes to its value), always for the whole cell, never to the column's own values. In the add-in a strict column also offers "Check this column" (the cells that hold an alias, or a value in other capitals or spacing, and the cells whose value is not in the list, with their rows; it writes nothing), "Replace N aliases with the list's spelling" (unknown values and cells that hold a formula are never changed) and the spreadsheet's own list validation on and off; each of those writes waits for a confirmation. Any value other than `true`, `false` or `null`, or `strict: true` on a rule with a `kind`, is ignored with a warning and the rule is kept. |
| `sheets.columns[].kind` | `label`, `notes`, `number` or `date`. `label` or `notes` override what the column's values suggest (`notes` completes only the sentence being typed, from sentences that recur in at least 2 cells); `number` or `date` switch completion off for the column, since a rule with a kind has no vocabulary. |
| `sheets.blocks` | List of `{ trigger, label, rows }` or `{ trigger, label, formula }`. The trigger starts with `/`, has no spaces and is unique; it fires only when it ends at the caret after a word boundary. `label` defaults to the trigger. |
| `sheets.blocks[].rows` | Rows of text, numbers or booleans written as a rectangle from the selected cell (ragged rows are padded with `""`; text cells get the text format, numbers and booleans the general one); at most 10,000 cells. A text cell that a cell would read as a formula (leading `=`, `+`, `-`, `@`, tab or CR, unless a plain signed number; or leading full-width `＝`, `＋`, `－`, `＠`) skips the whole block with a warning naming its row and column; use `formula` to write a formula. The add-in lists the rows under the Insert button before writing them; rows from a configuration a document carries are written only after a confirmation naming the range they replace. |
| `sheets.blocks[].formula` | Starts with `=`; written into the selected cell as a formula. A block with both `rows` and `formula` is skipped. |
| `forms.records[]` | Named field sets. `id` (a repeated id is renamed with `-dup` and warned), `label` (default: the id), `trigger` (optional; typed to open the record; a trigger another record already has is dropped with a warning and the record stays palette-only; at typing time a library shortcut or document set with the same trigger wins), `fields` (field name → text; numbers and booleans are written as text, other values are dropped with a warning; a record without fields is dropped). Values may hold `[[blank]]` templates, filled from a lookup row or the person's answers. |
| `forms.lookups[]` | Local lists that fill fields from a key. `id`, `key` (required: the column that holds the key), `keyPattern` (optional regular expression; a key is also found inside longer text, such as a copied subject line, where it stands as a whole word; an invalid pattern is dropped with a warning and exact matching stays), `rows[]` (objects; a row without the key column, or repeating a key case-insensitively, is dropped with a warning; non-text values are dropped). A lookup without usable rows is dropped. The row's columns fill form fields and record blanks of the same name. |
| `forms.forms[]` | Windows that are forms. `id`, `label`, `match.process` (one name or a list; paths and `.exe` are ignored) and/or `match.title` (regular expression, case-insensitive): a form needs at least one of them, and the first form whose conditions all hold is used. `fields[]`: `name`, `label` (default: the name), `selector` (required), listed in the application's Tab order. The form decides which fields are filled and in which order; a repeated field name and a field without name or selector are dropped with a warning; a form without fields is dropped. The desktop shell shows selectors but does not use them: the caret has to be in the form's first field, and the values are typed in Tab order with a Tab pressed for every field in between that has no value. |
| `guard.assumeExternal` | `true` treats a message whose recipients are unknown as going outside the organisation, so rules with `recipients: "external"` fire while typing (the desktop shell cannot read recipients). Default `false`: those rules then fire only in the dashboard's "Try it" box, where recipients are typed in. Known recipients always decide. Anything but `true` or `false` warns and uses `false`. |
| `guard.internalDomains[]` | Domain names whose addresses count as inside the organisation (a leading `@`, `*` or `.` is dropped, case ignored, subdomains included). A recipient without a readable `@domain` counts as external. An entry that is not a domain name is skipped with a warning. Without any, every known recipient counts as external, warned when a rule needs it. |
| `guard.internalCodes[]` | Regular expressions for internal project codes, used by the `internal-code` detector. An invalid pattern is skipped with a warning; a rule with `detect: ["internal-code"]` is skipped when the list is empty. |
| `guard.packs[]` | Rule packs: `id` (default `pack-<n>`, a duplicate gets `-dup`), `label`, `rules[]`. A pack without a usable rule, or that is not an object, is skipped with a warning. |
| `guard.packs[].rules[]` | `id` (default `<pack>-<n>`, a duplicate gets `-dup`), `label`, `message` (required), `keywords` with `match` `any` (default) or `all` and `caseSensitive` (default false), `detect` (detectors below), `unless` phrases that silence the rule when one appears anywhere in the field text (case and spacing ignored), `apps` (process names the rule is limited to; the "Try it" box needs the application typed in to try them), `severity` `warn` (default), `info` or `block` (a label: nothing is blocked), `recipients` `any` (default) or `external`. A rule needs keywords or detectors and a message, else it is skipped with a warning; an unreadable severity or recipients value warns and uses the default. Each rule fires once per field until the focus moves. |
| `guard.packs[].rules[].detect` | `card-number` (Luhn check), `iban` (mod 97), `email`, `phone`, `national-id` (with `countries` from US, GB, ES, FR; all four by default; unknown countries warned, a rule with none supported skipped), `forbidden-phrase` (needs `phrases`), `internal-code` (needs `internalCodes`), `secret` (labelled passwords and tokens, long tokens). Findings are shown masked; a secret shows only its label and stars. |
| `guard.packs[].rules[].fix` | `{ "kind": "text", "text": "…", "position": "end" (default) or "start" }`, `{ "kind": "shorthand", "trigger": "…" }` or `{ "kind": "remove", "with": "…" }` (a plain string is a text fix). Text at the end and a shortcut are typed at the caret and counted as a `guard` insert; a `remove` fix and a text fix at the start put a corrected copy of what was typed in the field on the clipboard, and are refused when the field holds 4,000 characters or more (the engine keeps only the last 4,000); such a fix is reported only once the copy is on the clipboard, and a copy that fails is reported with the warning left open. Every fix is refused once the focus moved since the warning was raised, while the organisation has paused actle, and for a warning raised by a key that may have sent the message (Enter, Tab or a shortcut). A shorthand fix uses the policy library's shortcut (the person's own only when the policy has none with that trigger) and refuses a shortcut with `[[blanks]]`. An unusable fix is dropped with a warning; the rule stays, without a Fix button. |
| `notes.author` | Name of the blank that is prefilled with the person's name and remembered after each insert (default `author`). Must be a blank name (`author` or `[[author]]`, no brackets or line breaks inside), else it is ignored with a warning. |
| `notes.dateOrder` | `dmy` (default) or `mdy`: how `3/11/2026`-style dates in due phrases are read. ISO dates and written months are unambiguous. Anything else is ignored with a warning. |
| `notes.actions` | The action block: `heading` (default `Action items`), `patterns` (words that make a sentence an action item, default `TODO`, `ACTION`; empty entries are dropped with a warning), `empty` (the line written when there are no items, default `None`). `false` switches the block off by default; a document with its own `actions` object switches it back on for that document. A value that is not an object or `false` is ignored with a warning. |
| `notes.documents[]` | `id` (defaults to `notes-<index>`; a duplicate gets `-dup`), `trigger` (required and unique; the same boundary rule as shortcuts; a library shortcut or a document set with the same trigger wins), `label` (defaults to the id), `title` (a template written as `# title`), `sections[]` and optional `actions` (the document's own `heading`/`patterns`/`empty`, or `false` to switch the block off for this document; an invalid value inherits the policy's). A document without a trigger, with a duplicate trigger or without a usable section is dropped with a warning. |
| `notes.documents[].sections[]` | A string (a heading) or `{ "heading", "body", "repeat" }`; `body` is a string or a list of lines. Text may hold `[[blank]]`, `{date}`, `{time}`, `{datetime}`, `{weekday}` and `{cursor}`. A list line holding one blank alone (`- [[attendees]]`) is written once per value; `repeat: true` writes the section once per value of its list blanks, and a list blank with fewer values than copies stays open in the later copies (the popover says how many values it needs; one plain value is written into every copy). A section with neither heading nor body is dropped with a warning. |

## The suite

factle (document filing, above) and the five apps below share one engine,
one policy file and one desk: each reads its own section of the policy
(invalid parts are warnings, never a refusal; layers merge lists by id),
registers its tab, popovers, tray and palette entries through
`desktop/apps/`, and counts what it inserts in the same statistics and usage
reports (metric kinds `reply`, `form`, `guard`, `notes`, and `sheets` for the uses
the extle add-in hands back). A typed trigger is
one namespace across the library, document sets, forms records and notes
documents; a shared trigger is a warning and only the first owner (in that
order) can be typed.

## mactle: replies to mail

mactle reads the policy's `reply` section. The desk cannot read the compose
window, so the person copies the message they are answering and chooses
"mactle: Reply to the copied message…" in the tray menu or "mactle: Reply to
copied message" in the search palette. Quoted lines and
everything below "On … wrote:" (one line or wrapped onto two), "-----Original
Message-----" or a From:/Sent:/To:/Subject: header block are dropped; the
first 20,000 characters of the rest are used. The replies whose keywords
appear are listed best fit first, at most `reply.max`, with their blanks
filled from the message. Blanks the message does not answer are asked in the
popover; a reply is never pasted while one is open, and typed answers and
found values are inserted literally. Enter closes the popover, then pastes
the text through the clipboard where the person was writing; a paste the
desk cannot perform is reported by actle's own notification and counts
nothing. Nothing is offered when the clipboard is empty, no reply fits, the
policy has no replies, or actle is paused. Insert in a popover opened before
a pause is refused ("Paused by your organisation."); a pause that arrives
while the focus goes back to the compose window stops the paste, with a
notification.

Stored on the desk: `apps/reply.json` with offered and inserted counts per
reply id; one metrics line per paste (kind `reply`, the reply id, keystrokes
saved = the reply's length minus the palette query and what was typed into
the blanks); one audit line per paste or counts reset with the reply id, how
many candidates were listed and how many blanks were answered. Never stored:
the copied message, the values found in it, the answers typed or the pasted
text. The "Try it" box ranks a pasted message without counting or storing
anything. Usage reports name reply ids as organisation items (kind `reply`).

## extle: Excel and Google Sheets

Column-aware completion in Excel and Google Sheets: extle reads the policy's
`sheets` section. The desk cannot see cells: its **extle** tab shows the section (vocabularies, column
rules, blocks), tries a completion against pasted column values and exports the
section as `apps/sheets-config.json` for the add-in in `corporate/sheets-addin/`,
whose Settings take that file. An export that cannot be written is reported, never thrown.

In a spreadsheet, the selected cell's displayed text, its header (row 1) and the
column's displayed values (first 5,000 rows, minus the cell's own row) are read;
vocabulary values come first (an alias or another spelling completes to the
organisation's one spelling), then the column's own values by frequency, prefix
before substring matches, 8 at most, never the text typed. A completion is written
as text (number format `@`); a notes cell whose typed start looks like a formula
(leading `=`, `+`, `-`, `@`, tab or CR, unless a plain signed number; or a full-width
`＝`, `＋`, `－`, `＠`) is left alone with a message. A `/` trigger typed in the pane inserts the block's rows or formula at the
selected cell.

A strict column (`strict: true`) completes only to its vocabulary's values. The pane
says so ("Only values from the "costCentres" list.") and offers a check, which writes
nothing, and three writes, each only after a confirmation that names what changes.
"Check this column" compares the values already read (header excluded, the selected
cell included) with the list, case-insensitively, and lists aliases and other
spellings, and values not in the list, with their rows (ten of each, the rest
counted). "Replace N aliases with the list's spelling" ("Replace N cells ..." when
some are other spellings rather than aliases) reads those cells again and writes the
list's value as text into each one that still holds what the check read, never into
a cell that holds a formula, and reports the others and where a failed write stopped.
"Turn on list validation for this column" writes the host's own list rule on the
column from row 2 down, so a value typed into those cells that is not in the list is
refused (whether the host ignores capitals was not checked); values already in the
column are not changed or checked, and in Excel a plain paste is not checked either
(Excel with ExcelApi 1.8 and a list of at most 255
characters with its commas and no comma inside a value; for Google no limit was found
in its documentation). "Remove list validation" clears every rule on those cells. A
list rule stays in the file like any other cell setting. On the desk, the
extle tab marks the strict rules and its "Try it" box completes them the same way.

Stored: the configuration pasted into the add-in's Settings, in the browser's
localStorage (the copy that applies in every document) and in the workbook's
document settings (Excel) or the spreadsheet's document properties (Google, pieces
of at most 8,192 UTF-8 bytes, count written last); on the desk,
`apps/sheets-config.json` and the last export's time and counts (`apps/sheets.json`);
the audit gets `sheets-config-exported` with counts only. A configuration a document
carries in its own settings is only offered, with what it would change; it applies
only when the person chooses it, for that session, and is never copied into the
browser or erased by saving an empty Settings box. A formula or rows from it are
written only after a confirmation that shows the formula, or the rows and the range
they replace. Never stored or sent: cell
contents, what is typed in the pane or in "Try it". Nothing read from cells or typed
in the pane is sent anywhere (the Excel pane loads Office.js from Microsoft's CDN;
nothing else is fetched; the Google sidebar calls only its own script). The usage
counts below are kept outside the spreadsheet, in the host's own store.

Usage: the pane counts each completion and block it writes into a cell (nothing for
a write that was refused, failed or only proposed, nor for a column check, a
replacement or list validation), per day: how many and the keystrokes saved, with
the vocabulary's name or the trigger when it comes from the organisation's copy in
the browser; while a document's own configuration is in use, without a name. It
keeps 120 days, 12 names a day and names of up to 40 characters (a longer one, or one
with a control character or a character outside the Basic Multilingual Plane, which
rules out most emoji but not all, is counted without it). The counts are kept
in the browser (Excel) or in the person's own Apps Script user properties (Google),
never with the document. The add-in cannot reach the desk, so its Usage section
gives a text the person copies and pastes into the desk's extle tab; each use not
imported before becomes a metrics entry of kind `sheets` (application `extle`) at
noon of its day. The entry is named, as an organisation item, only when this policy's
`sheets` section defines the vocabulary or trigger; otherwise it counts in the
person's own total. Days after today, days older than `retention.metricsDays` and
uses past 20,000 in one import are not imported. The audit gets
`sheets-usage-imported` with counts only.

## cactle: CRM and ticket forms

Fill a whole form at once from a named record. cactle reads section `forms` (`records`, `lookups`, `forms`), parsed by `core/forms.js` and run by `desktop/apps/forms/`.

On a desk: with the caret in the form's first field, typing a record's trigger, or picking the record in the search palette (a record without a trigger is listed as `form:<id>`), opens the plan popover. It names the form matched to the window that had the focus; with no match the record's fields are filled in record order. The Reference box runs the lookups (exact key, or a key pattern inside longer text); when the popover opens the clipboard is tried once and a key found there pre-fills the reference. The row's columns fill form fields of the same name and the record's `[[blanks]]`; blanks still open are asked in the popover, which also lists the fields Tab will pass over. Fill is refused, with the popover kept open, while a blank is open or the form has none of the record's fields. Otherwise the popover closes first, so the keys reach the form and not actle's own window; the Electron shell then waits 150 ms for the focus to return, each value is pasted in Tab order with one Tab per form field between two values, and the first paste deletes the typed trigger (on its own when the first value belongs to a later field). Selectors are shown, not used. A key that fails stops the fill: a notification names the field it stopped at, nothing is counted or stored, and there is no retry from the popover. A complete fill is one `form` insert named by the record id (an own record's fill: `own-record`), with the typed trigger, a typed reference and typed answers subtracted. A paused policy offers no record, and Fill in a popover opened before the pause is refused ("Paused by your organisation."). A pause that arrives during the 150 ms wait stops the fill before its first key, with a notification; a fill that has started typing finishes.

Stored in `apps/forms.json`: own records accepted from proposals (id `own-` + 8 hex characters of the proposal digest, label, trigger, fields, the form learned on, when); fills made on a matched form as the form id and only the values that came from the policy (record text none of whose blanks the person answered, and lookup-row columns; what the person types into the popover is never written), at most 500 (oldest dropped), removed once older than `retention.corpusDays` (at start and at every fill; a fill without a time counts as expired), all deleted by "Clear stored fills" on the cactle tab and by "Delete learned text" on the Learning tab (that button is enabled only while learn-mode text is stored); dismissed proposals as `sha256:` digests. The file is plain JSON, so names and e-mail addresses from lookup rows are readable on the desk (the learning corpus, by contrast, is encrypted). The audit file gets `form-filled`, `form-record-accepted`, `form-proposal-dismissed`, `form-record-deleted` and `form-sessions-cleared` with ids and counts.

Never stored: the value of a field whose name contains, as a whole word (split at case changes, digits and punctuation), password, passwd, passcode, passphrase, pass, pwd, PIN, secret, token, OTP, API key, credential(s), CVV, CVC, IBAN, BIC, SSN, NINO, DNI or NIR (`userPin`, `api-key`, `password2` and `payeeIBAN` count; `secretary`, `tokenizer`, `pinned` and `passenger` do not, and neither do other names such as `accountNumber` or `passportNumber`); a record field whose template has a blank named that way; a value the capture scrubber would mask (card numbers, labelled secrets, long tokens) or on which gactle's `iban` or `national-id` (US, GB, ES, FR) detector fires; anything typed into the popover (answers, and every field that carries one); a fill made without a matched form; the clipboard text (only a lookup key found in it reaches the popover); a value, reference or answer in the audit file.

Learning: field sets filled together in at least 3 fills of one form with at least 2 constant fields are proposed; text that differs from fill to fill becomes a blank. A proposal whose fields equal an existing record (policy or own), or one that was dismissed, is not shown. Accepting needs a trigger of at most 40 characters without spaces that no record, library shortcut, document set or notes document uses. A proposal is labelled "Learned record N on <form label>" (the form's id when the policy no longer has the form), N being the lowest number for which no record and no earlier proposal has that label, never with a learned value; the dashboard prefills that label as the record's name, which the person may change, and an empty name keeps it. A fill of an own record notifies "Filled N fields." without its label. A policy record with an own record's id hides the own record (warned on the tab); one with its trigger takes the trigger and the own record stays palette-only.

Limits: nothing is read from the form, so the caret must be in the form's first field when the trigger is typed and a form's fields must be listed in the application's Tab order; the cactle tab shows the first 20 rows of a lookup; there is no tray entry.

## gactle: compliance warnings

gactle checks what a person types against the organisation's rule packs (policy section `guard`, parsed by `core/guard.js`, desktop app `desktop/apps/guard/`). At every word end, including a word ended by Enter, Tab or a shortcut key such as Ctrl+Enter (the usual ways a message is sent), the engine hands the text typed or inserted in the current field since it got the focus (the last 4,000 characters, held in memory only, and only while the policy has rule packs) to the core. The desk observes keys and cannot hold one back, so a warning raised by the key that sends a message appears as the message goes out, and comes without a fix (where the rule has one, the window says to check the message and correct it by hand); it is still recorded as raised. The last word before a mouse click (on Send, for example) is not checked, because a click resets what actle holds of the field. No field text is held and nothing is checked in a secure-input field or in the credential prompts, password managers and terminals actle recognises by process name or window title (see Capture modes). A rule that fires opens the "Before you send" window, which never takes the focus, with the rule's label, a severity tag, the message, the findings masked (a card number shows its last four digits, a secret only its label and stars), a Fix button when the rule has one, and Dismiss. The shell shows one such window at a time: a warning or offer that fires at a later word end replaces it, and the warnings left in it count as unanswered. Each rule fires once per field until the focus moves. A severity is a label; nothing is blocked.

Fixes: a text fix at the end and a shorthand fix are typed at the caret and counted as a `guard` insert (keystrokes saved = the inserted text). A `remove` fix and a text fix at the start cannot edit text already in the field, because the shell only types at the caret: a corrected copy of what actle saw typed in the field goes to the clipboard with a notification saying it covers only that text, to paste over it; nothing is counted. When the field holds 4,000 characters or more the copy would start mid-word, so the clipboard fix is refused with a message to correct by hand. Every fix is refused while the organisation has paused actle, and once the focus moved since the warning was raised (the window stays open across applications), so nothing is ever typed into another application; Dismiss still answers it. A shorthand fix uses the policy library's shortcut (the person's own only when the policy has none with that trigger) and refuses a shortcut with `[[blanks]]`, telling the person to type the trigger. While a fix is pasting, the window takes no other answer.

Recipients: the shell cannot read them, so rules with `recipients: "external"` fire while typing only when `guard.assumeExternal` is `true`. The gactle tab's "Try it" box runs the same check on a pasted text with recipients (comma-separated) and, optionally, an application typed in, and counts and audits nothing.

Stored: one line per outcome in `audit.jsonl` (`event: "guard"`, rule id, pack id, `raised`, `fixed` or `dismissed`, time), and for a typed fix one metrics entry (kind `guard`, rule id, source `organization`), which usage reports name per rule. Never stored: the field text, recipients, findings (not even masked), the Try-it text.

Limits: Fix closes the window, so other warnings shown with it count as unanswered; so do warnings whose window was replaced by a later one or was still open when actle quit. Pasted text, a mail client's signature and text typed before the field got the focus are not seen and are not in a clipboard copy. While the organisation pauses actle, nothing is typed into the engine and nothing is checked.

## dactle: minutes, handovers and logs

Minutes, handovers and logs in the organisation's house style, for Word, Docs or another editor. dactle reads policy section `notes`; desktop app `desktop/apps/notes/`. A note is pasted at the caret of the application that has the focus. A typed trigger works only in an application whose capture mode is not `off`; the search palette and the tray entry do not check the capture mode. dactle has not been run in Word or Google Docs.

* **Insert a document.** Type its `trigger` in any application (same boundary rule as shortcuts; a library shortcut or a document set with the same trigger wins), or pick the document in the search palette. A popover asks for the document's blanks: one input each, the `author` blank prefilled from the person's own setting, a list blank (a list line of its own such as `- [[attendees]]`, or a blank used only in `repeat` sections) as one comma-separated line. Insert renders the title, the sections, `{date}`, `{time}`, `{weekday}` and the answers, closes the popover so the editor has the focus again, deletes the typed trigger and pastes the note; the caret goes to `{cursor}`, else the first empty section, else the end of the sections. A document whose `actions` are on gets an empty action block at the end unless one of its sections already carries that heading. Nothing is inserted while a blank is empty: the popover names the missing ones, and a list blank of a `repeat` section with fewer values than the section has copies is named with its counts (`owner (2 of 3 values)`). A paste the sender could not do is reported by a notification; a fault while counting an insert that already reached the editor is logged and notified, never shown as a failed insert.
* **Action items.** The editor cannot be read, so the person copies the whole note and chooses "dactle: Update action items in the copied note" in the tray menu (or the palette entry). Sentences with an owner (`@name`, or a capitalised name followed by "will" or "to"), a due phrase ("by Friday", "tomorrow", "by 3 November 2026", "next week") or one of `actions.patterns` are collected under `actions.heading`, with due dates written as ISO where a weekday or date was given. The block is replaced where it stands or appended; lines typed into it by hand are kept; running it twice changes nothing. The result goes back to the clipboard with a notification and the person pastes over the note. A document's own `actions.heading` is used when the note holds a block under it, else the policy's. When no items are found and the note has no block, the clipboard is left alone.
* **Statistics.** An inserted note is counted under kind `notes` with the document `id` (source organisation): the pasted length minus the typed trigger, the palette query and the answers typed into the blanks (a prefilled author is not typed). Clipboard updates count nothing: actle typed nothing. Usage reports name documents by `id`.
* **Stored.** `settings.json`: `notesAuthor`, the author last inserted with or saved on the dactle tab. `apps/notes.json`: inserts per document id and the number of clipboard updates. `audit.jsonl`: `notes-inserted` (document id, via, number of blanks answered, keystrokes saved) and `notes-actions-updated` (via, number of items).
* **Never stored.** The note, its headings, the answers and the clipboard text are written nowhere by actle; the dashboard's "Try it" box works on the pasted text in memory only.
* **Limits.** The document a copied note came from is not known: only its block heading is matched. Dates in due phrases follow `dateOrder`. `paused` stops the triggers and palette items (engine and assistant) and the tray entry and Insert (the app). A document without blanks still opens the popover (Enter inserts it). Closing the popover gives the editor the focus back on Windows and Linux; on macOS only the shell can hide actle's own windows, which the app cannot do. Phrasings from earlier notes (`core/notes.js` `phrasings`) are not offered: no corpus of notes is kept.

## Patterns in the policy

Several fields take a regular expression: capture `match.title`, filing
`fields.*.pattern`, forms `lookups[].keyPattern` and `forms[].match.title`,
guard `internalCodes`, reply `extract.*.pattern`, sheets `columns[].match`.
They run on what people type, copy and file, so a pattern that backtracks
catastrophically would freeze the desk. Each is checked when the policy is
read and refused with a warning (so `actle-admin sign` refuses the policy)
when it is longer than 256 characters, uses a backreference, repeats a group
that itself repeats (`(a+)+`), repeats a group of alternatives without a bound
(`(a|b)*`; use a character class `[ab]*` instead), or has more than four
unbounded repeats. On the desk each pattern also runs with a 50 ms budget on
capped text; one that runs out is turned off until the next start, with a
dashboard warning and an audit line (`policy-pattern-disabled`). The extle
add-in has the load-time check and the caps, not the budget.

## Central distribution (signed policies)

On a managed desk, IT installs `deployment.json` in the app's data folder:

```json
{
  "policySources": [
    { "layer": "organisation", "label": "Organisation", "url": "https://intranet.example/actle/org.signed.json" },
    { "layer": "shipping", "label": "Shipping team", "path": "S:/IT/actle/shipping.signed.json" }
  ],
  "publicKeys": ["-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"],
  "refreshMinutes": 60
}
```

If IT creates that folder, it should belong to the person's account: actle
makes the folder and its own files in it private to that account (0700 and
0600) when it starts, and leaves files owned by another account, such as a
`deployment.json` installed as root, as they are. On Windows these modes do
not apply; the profile's permissions do.

* Sources are layers, most general first. Later layers win field by field;
  shortcuts merge by trigger, keyword rules by `id`, document sets by
  trigger, and a later layer's capture rules are tried before an earlier
  one's. A pause in any layer pauses the desk.
* Every source names its `layer` and must be signed with a key listed in
  `publicKeys`, for that layer. Only `https://` URLs and file paths are
  accepted; plain `http://` sources are refused, and so is an https source
  that redirects to plain http.
* The desk fetches at start and every `refreshMinutes` (5 to 1440, default
  60). A source that cannot be fetched, fails its signature or carries an
  older serial keeps its last good copy, with a warning on the dashboard. A
  source with no good copy yet is left out; the other layers still apply.
* On a managed desk, a local unsigned `policy.json` is ignored.
* Policy changes, failing or recovering sources, and changes to the person's
  own capture rules are written to `audit.jsonl` in the data folder and shown
  on the dashboard's Policy tab. Typed text is never written there.

Sign with the admin tool (no dependencies):

```
cd corporate
node admin/actle-admin.js keygen ./keys          # once; keep policy-signing.key private
node admin/actle-admin.js validate org.json
node admin/actle-admin.js layers org.json shipping.json
node admin/actle-admin.js sign org.json --key keys/policy-signing.key --layer organisation --serial 2 --out org.signed.json
node admin/actle-admin.js verify org.signed.json --pub keys/policy-signing.pub
```

`sign` refuses a policy that has warnings unless `--allow-warnings` is
given, and `keygen` refuses to overwrite an existing key.

## Usage reports

A person exports a report from the dashboard (Overview, **Usage report…**),
after a preview of everything in it, and hands it to the administrator. A
report holds totals per period, the use of shortcuts, keyword rules and
document sets the organisation defined (extle's vocabularies and triggers
included), and one total for the person's own shortcuts. It never contains typed or inserted text, the names of a person's
own shortcuts, or individual timestamps. A random desk id lets the roll-up
count a desk once.

```
node admin/actle-admin.js report reports/*.json --policy org.json --rate 38 --currency EUR --csv team.csv
```

prints desks, hours saved, estimated value, totals per team, organisation
shortcuts by use and the ones nobody used (a suite app's item under the app's
name, e.g. an extle vocabulary or trigger as `extle <name>`, a mactle reply as
`mactle <id>`; the CSV keeps the kind id, as `sheets:<name>`; a vocabulary and
a trigger with the same name share one line;
a name the add-in does not keep, longer than 40 characters or with a control
character or a character outside the Basic Multilingual Plane, is never listed, since
no use can carry it), and writes the same as CSV to a
new file (`--csv` never replaces an existing file: name a new one, or delete
the old one first). An unreadable report is skipped with a warning.

## Phrase suggestions from desks

On the Learning tab a person can mark a proposal **Suggest to organisation**
and later export the list (after seeing exactly what it holds). A template
suggestion carries the template with its blanks, never the values seen in
them. The administrator ranks the files:

```
node admin/actle-admin.js suggestions incoming/*.json --policy org.json --min-desks 2 --out proposed-library.json
```

Each text counts once per desk (newest file wins); texts already in the
policy library are left out; the trigger most desks chose is kept unless the
library already uses it. `--out` writes a new `shorthands.json`-format file
(it never replaces an existing one) to review and then add to the policy's
`library` before signing.

## factle: document filing

A desk watches the folders in `filing.watch` (plus the person's own). When a
file appears and has stopped growing, the desk reads it locally (plain text,
`.docx` and `.xlsx`; a PDF or image is judged by its file name only), picks
the first rule whose keywords appear, fills the rule's `name` and `folder`
templates from the text, and shows a popover: the name (editable), any blank
the text did not fill, and the folder. The popover appears without taking the
keyboard focus, and neither files nor turns a folder off until the person
clicks its name, a blank or a button (a click in its first 0.7 seconds on
screen does not count, and once the popover loses the focus it needs a new
click). Then Enter files it, and "Never for this folder" turns off on this
desk every watch still on that proposes the document (its own folder, or a
watched folder above it with `recursive: true`), or says so and stays open
when no such watch is left. Skip, or Esc in the popover, leaves the file
untouched at any time. A document is never overwritten, even when two desks, or a desk and
`actle-admin file --apply`, file the same name into the same folder at the
same moment (a second copy gets ` (2)`); a name with an unfilled blank is
refused; and a filing can be undone from the factle tab while the filed
document is unchanged (when the file at the filed path has another size or
modification time, or is not a file, Undo leaves it and its entry where they
are). A name is cut to 150 characters as Windows counts them (most emoji count
as two) and to 200 bytes before any ` (2)` is added; an extension longer than
16 letters or digits counts as part of the name. Each folder name that the
rule's `folder` template produces is cut to 255 characters and 255 bytes. A
name whose part
before the first dot is one Windows reserves for a device (CON, NUL, COM1,
CONIN$ and the like) gets a `_` in front, on every platform.

What is kept: `filing-index.json` in the data folder holds each filed
document's new name and path, old name and path, the rule and the values
found (a client, a reference), so the search palette finds "acme invoice"
from any application. The document's text is read in memory and never
stored. `audit.jsonl` records each filing and undo with the two paths.

Test rules on sample documents without the desktop app:

```
node admin/actle-admin.js file samples/*.pdf samples/*.docx --policy org.json          # dry run
node admin/actle-admin.js file samples/*.docx --policy org.json --apply                 # rename and move
```

The output starts with DRY RUN or APPLYING. Folders, symbolic links and
anything else that is not a file are skipped with a message. Each command
takes only its own options, and `--` ends them. A wildcard such as `*` can put
a file named like an option (`--apply`) on the command line, so with options,
`file`, `report` and `suggestions` take documents only when they are named
with a folder (`samples/*`, `./*`) or come after `--`; an option that is also
the name of a file in the current folder is refused too.

## Capture modes

* **off**: the assistant ignores what is typed in the application: no trigger,
  document shortcut, keyword rule or gactle check runs, and nothing is
  learned. The search palette and the apps' tray entries do not check the
  capture mode, so they still work there.
* **triggers**: a rolling buffer of the last 200 characters is matched against
  triggers and document shortcuts and is never written anywhere. This is what
  the personal Windows app does in every application. While the policy has
  keyword rules or gactle rule packs, the text of the current field (up to 4,000
  characters) is also held in memory to check them, and dropped when the focus
  moves. A word ended by Enter, Tab, a shortcut key or a caret key raises
  warnings only (keyword warnings without their insert, gactle warnings without
  a fix), because the key may have sent the message or left the window;
  offers wait for the next word typed in the field. No field text is held,
  and no keyword rule or gactle check runs, in the credential prompts, password
  managers and terminals actle recognises.
* **learn**: in addition, the text typed in that application is kept per
  field session (until the focus moves), scrubbed, and stored under the data
  folder so the phrase miner can propose shortcuts and fill-in templates.

Learn mode is never applied to credential prompts, password managers,
terminals or secure-input fields, even when a rule asks for it. actle
recognises a secure-input field by the system's flag (macOS), and the others
by process name (password managers and keyrings; terminals and SSH clients
such as PuTTY, mintty and MobaXterm; the system's credential and elevation
prompts, polkit agents, GnuPG pinentry and ssh-askpass; on Linux also by the
15-character name the kernel reports) and by window titles with sign-in or
password words in English, German, French, Spanish, Portuguese or Dutch; a
window it does not recognise is treated like any other. Card numbers,
labelled secrets ("password: …") and long token-like strings are masked
before a session is stored. The person can see, pause and delete the
learning corpus from the dashboard at any time.
