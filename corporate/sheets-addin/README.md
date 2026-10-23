# extle add-in (Excel and Google Sheets)

Column-aware completion inside the spreadsheet. The actle desktop assistant
cannot see cells, so this folder holds the other half of extle, the Excel and
Google Sheets app: a task pane for Excel and a sidebar for Google Sheets that
read the selected cell, its column header (row 1) and the column's existing
values, and offer completions from the organisation's vocabularies and from
the column itself.
Clicking a completion writes it into the cell **as text**, so a code such as
`CC-100` or a value that looks like a date is not reinterpreted. A `/` trigger
typed into the pane's input inserts the policy's block of rows or formula at
the selected cell. In a strict column (a column rule with `strict: true`) only
the list's values are offered, and the pane can check the column against the
list, replace aliases with the list's spelling and turn the spreadsheet's own
list validation on or off (see "A strict column" below). The pane counts what
it writes and hands the counts to the desk as a text the person copies (see
"Usage counts for the desk" below).

Both hosts run the same logic: `core/sheets.js` bundled into one browser
script, and `pane.js`, the shared pane, which talks to the host only through a
small bridge (`taskpane.js` for Office.js, the inline script in
`apps-script/Sidebar.html` for Apps Script).

```
sheets-addin/
  build.js                 bundles ../core/sheets.js and its requires (plain Node, no dependencies, no network)
  dist/sheets-core.js      generated: the bundle, defines window.ActleSheets
  pane.js, pane.css        the shared pane and its styles
  taskpane.html, .js       Excel task pane (Office.js from Microsoft's CDN is the only external script)
  manifest.xml             Office add-in manifest with placeholders (see below)
  apps-script/
    Code.gs                Google Sheets server side: menu, sidebar, read the selection, write a cell, replace aliases, list validation, keep the usage counts
    Sidebar.html           the sidebar page; includes the two generated files
    sheets-core.html       generated: the bundle in a <script> tag
    pane.html              generated: pane.css and pane.js in <style> and <script> tags
    appsscript.json        Apps Script manifest (V8 runtime, current-spreadsheet scope)
  test/
    fakes.js               a fake document, Excel workbook, Apps Script services and google.script.run
    pane.test.js           the shared pane driven headlessly
    hosts.test.js          taskpane.js, Code.gs and the sidebar script driven against the fakes
```

## Build

```
cd corporate/sheets-addin
node build.js              # writes dist/sheets-core.js and apps-script/{sheets-core,pane}.html
node build.js --out /tmp/x # the same files under another folder
```

The build reads `../core/sheets.js`, follows its relative `require` calls
(`core/personal.js`, `core/phrase-miner.js`, `core/policy-pattern.js`,
`core/sheets-usage.js` and the `core/metrics.js` it counts graphemes with, the personal edition's
`expander.js`, `template.js` and `palette.js`), wraps each module in a tiny
CommonJS shim and writes one script that sets `window.ActleSheets` to the
core's exports (`normalizeSheets`, `columnFor`, `createColumnProfile`,
`complete`, `blockFor`, `importCsv`, `formulaLike`, `suggest`, `checkColumn`,
`exportConfig`, `parseConfig`, `organizationItems`, and `usage`, the usage model). The script starts with a two-line
`Object.hasOwn` polyfill, the one ES2022 call the core makes, so an older
Office webview (WebKit before Safari 15.4) can run it; everything else the
bundle uses is ES2020 or older. It touches no network and is deterministic:
the same sources give the same bytes. A module that requires a Node builtin
stops the build with its name, since a browser could not load it. The
generated files are ignored by git (`.gitignore` here); rebuild them after any
change to the core.

## Configuration

The pane needs the `sheets` section of the organisation policy. On the
desktop assistant's **extle** tab, **Export add-in configuration** writes it
to `apps/sheets-config.json` in the data folder and shows the path. Open the
pane's **Settings**, paste the file's contents and save. The pane accepts the
exported section, a whole policy file (its `sheets` section is used) or the
JSON text of either; unusable parts are listed under the text box and
skipped, never refused.

Where it is kept, and which copy applies:

- This browser: Save keeps the text in the Settings box in the browser's
  `localStorage`. That copy is the organisation's configuration as far as
  the pane can tell (the person pasted it), and it is the one that applies,
  in every document opened in this browser.
- Excel: also in `Office.context.document.settings` (travels with the workbook).
- Google Sheets: also in the spreadsheet's document properties, cut into
  pieces of at most 8,192 UTF-8 bytes (one property holds 9 KB, measured in
  bytes, so a vocabulary in Cyrillic or Greek takes twice the pieces of one
  in English). The piece count is set to 0 before the pieces are written and
  to the real number after, so a save that fails halfway leaves no
  configuration in the document rather than a mix of old and new pieces.
- The pane says where the configuration was saved ("with this document",
  "in this browser only", "with this document only" when the browser could
  not keep a copy, or "nowhere" when neither kept it; it still applies for
  the session), and adds "in place of the different configuration it
  carried" when Save replaced one the document brought with it. Saving an
  empty box never erases a configuration the document carries, since the
  box never showed it: the document is left as it is and the pane says so.
  Without a browser copy, a document's configuration is offered again each
  time the document opens, as below.

### A configuration that comes with a document

A workbook's settings and a spreadsheet's document properties travel with
the file, so whoever saved the file last chose what they hold: a file from
outside the organisation can carry its own vocabularies, column rules and
`/` triggers, formulas included. The pane never lets a document's
configuration replace the organisation's without asking:

- When the document carries a configuration that differs from the browser
  copy, the browser copy stays in use and an offer appears above the cell
  text. They are compared after reading, so formatting and the order of
  vocabularies, of their values and aliases, and of blocks do not count;
  the order of column rules does, since the first rule that matches
  applies. The offer says that the configuration comes from the document's
  own settings, not from the organisation's copy, and what using it would
  change: blocks added or changed, formula blocks first with each formula
  written out in full, then vocabularies added, replaced or removed, the
  column rules, and blocks removed. Vocabulary names and triggers are the
  document author's text, so they are quoted and cut at 40 characters; ten
  changes are listed, the rest counted ("… and 297 more changes"). A
  document carrying the same configuration, or nothing usable, offers
  nothing.
- **Use the document's configuration** applies it for this session only; a
  line above the cell text says so until **Stop using it**. **Keep the
  organisation's** (**Not now** when the browser has no usable copy yet)
  hides the offer.
- While the document's configuration is in use, **Insert** writes nothing,
  for a formula block and for rows alike. A formula is shown on its own
  line with "Write it into A3?"; rows are listed with "Write them into
  A4:CV103, replacing what those 10000 cells hold now?". Only **Write the
  formula** or **Write the rows** writes. The status line says that nothing
  was written yet, the focus moves to **Cancel** (so a second Enter does
  not confirm), and both buttons are described by the question and what it
  writes. **Cancel**, **Stop using it** or another cell drops the question;
  a button left from a dropped question writes nothing.
- The document's text is never put into the Settings box and never written
  into the browser copy. The box holds the browser copy or what the person
  pasted; Save writes the box to the browser and to the document, replacing
  what the document carried.

The pane treats an Excel workbook's settings and a Google spreadsheet's
document properties the same way.

### A strict column

A column rule with `strict: true` (`corporate/shared/ORG-POLICY.md`) makes a
vocabulary column take only the list's values. The pane says so under the
cell text ("Only values from the "costCentres" list.") and:

- Completes only to the list's values, for the whole cell. A typed alias
  leads to its value; the column's own values are never offered.
- **Check this column** compares the column's values the pane already read
  (the first 5,000 rows, header excluded, plus the selected cell's own text)
  with the list, ignoring case and extra spaces. It lists, with their cell
  addresses, the cells that hold an alias or a list value in other capitals
  or spacing, with the list's spelling beside each, and the cells whose value
  is not in the list; ten of each are listed and the rest counted. Blank
  cells are skipped. A check writes nothing. Its result stays while the
  selection is in the same column of the same sheet; another column or
  another configuration drops it.
- **Replace N aliases with the list's spelling** (or **Replace N cells with
  the list's spelling** when some of the cells hold a list value in other
  capitals or spacing, which is not an alias) writes the list's value into
  every cell the check found, also those counted but not listed, and only
  after a confirmation that names how many cells change ("the 10 listed above
  and 2 more the check found" when there are more than ten): the status line
  says nothing was written yet, the focus moves to **Cancel**, and a button
  left from a dropped question writes nothing.
  Each cell is read again just before writing; a cell whose text is no longer
  what the check read is skipped and named in the result ("Skipped 1 cell
  that changed since the check: C5 (now "CC-300 Warehouse")"). An edit made
  between that read and the write is not caught. Values not in the list are
  never changed. The cells get the text format (`@`) before the value, like a
  completion.
- A cell that holds a formula is never replaced, even when the check lists
  it: the result says "Left 1 cell whose value comes from a formula: C3".
  Excel: the cell's `formulas` starts with `=` (Office.js gives a cell's
  value when it has no formula,
  [Range.formulas](https://learn.microsoft.com/en-us/javascript/api/excel/excel.range#excel-excel-range-formulas-member),
  so text that starts with `=` is left too), or, where Excel has ExcelApi
  1.12, `getSpillParentOrNullObject()` finds a dynamic array spilling into
  it. Google: `getFormulas()` is not empty.
- A cell filled by an array formula in another cell is not always
  recognised, and is then overwritten. In Google such a cell holds no
  formula of its own, so `getFormulas()` cannot tell it from a typed value;
  this covers `ARRAYFORMULA` and every function that returns an array into
  neighbouring cells, such as `FILTER`, `QUERY`, `SORT`, `UNIQUE`, `SPLIT` and
  `IMPORTRANGE`. In Excel without ExcelApi 1.12 a spilled cell is not told
  apart either. The confirmation says so for its host (the bridge adds the
  sentence). Writing into such a cell is reported to make the array formula
  show an error until the value is removed; that was not checked here.
- When a write fails partway, the result says how far it got: "Wrote the
  list's spelling into 2 cells of column C, then stopped at C7 (...); nothing
  after it was written." Excel runs the writes as one batch with a trace
  message after each cell; a failed batch does not run the commands after the
  failing one, and the error's trace messages name the cells written before
  it ([OfficeExtension.Error.traceMessages](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.error#office-officeextension-error-tracemessages-member),
  [trace](https://learn.microsoft.com/en-us/javascript/api/office/officeextension.clientrequestcontext#office-officeextension-clientrequestcontext-trace-member(1))).
  Google's side writes cell by cell and stops at the first write that
  throws. The check is then dropped and the column read again. When a
  bridge throws instead (the sheet is gone, an Excel error without trace
  messages, a script Google stopped), the pane shows the error and says that
  cells written before it, if any, keep the list's spelling; it keeps the
  check and reads the column again, and a retry skips the cells that changed.
- While a confirmed write is on its way, the status line says what is being
  written ("Writing the list's spelling into 2 cells of column C.") and the
  column's tools are not offered, so a redraw (the sidebar's poll, a
  selection event) cannot start a second request. When the column cannot be
  read again after a replacement, the result stays on the status line with
  "Could not read the column again: ..." after it, and the question and the
  old check are gone.
- **Turn on list validation for this column** writes the spreadsheet's own
  list rule on the column from row 2 down, after a confirmation that says
  any data validation those cells have now is replaced. A value typed into
  those cells that is not in the list is then refused, also when the pane is
  closed. The rule does not change or check the values already in the
  column (**Check this column** lists them), and in Excel a plain paste is
  not checked either: Microsoft says validation is triggered only when a
  value is entered directly or pasted with the Values option
  ([data validation in Excel add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-data-validation)).
  The rule holds the list's values only, not its aliases. Whether either
  host compares capitals when it checks a typed value was not confirmed
  (see "Not verified here"); a value in other capitals that the host lets in
  still shows up in **Check this column**.
  - Excel: `range.dataValidation.clear()`, then a `list` rule with
    `inCellDropDown: true` and the values joined by commas as `source`, and an
    `errorAlert` with `showAlert: true` and `style: "Stop"` (titled extle,
    "Only values from the "costCentres" list."), on rows 2 to 1,048,576, all
    in one batch, clearing first as Microsoft's own sample does
    ([data-validation.yaml](https://github.com/OfficeDev/office-js-snippets/blob/prod/samples/excel/22-data-validation/data-validation.yaml)).
    The reference does not say whether a rule can be set over an existing
    one without clearing it. When Excel
    refuses the rule, the commands before it have run, so the cells may be
    left with no rule at all; the pane's message then ends with "Data
    validation those cells had before may already be cleared."
  - Google: `SpreadsheetApp.newDataValidation().requireValueInList(values,
    true).setAllowInvalid(false)` set with `setDataValidation` on rows 2 to the
    sheet's last row as it is when the rule is set (`getMaxRows()`). A sheet
    with no row below the header is refused.
- **Remove list validation** clears every data validation rule on the same
  range, not only one set here, after a confirmation that says so.
- When the configuration in use is the document's own, the questions for a
  replacement and for list validation start with "This list comes from this
  document's configuration, not your organisation's." Nothing the strict
  column's tools write (the replacement, list validation and its removal) is
  written without its confirmation, whichever configuration is in use. A
  completion is written when it is clicked, as in any other column.

Limits, and where they come from:

- Excel's `Range.dataValidation` needs the ExcelApi 1.8 requirement set
  ([DataValidation](https://learn.microsoft.com/en-us/javascript/api/excel/excel.datavalidation)).
  The manifest still asks for ExcelApi 1.7; the task pane checks
  `Office.context.requirements.isSetSupported("ExcelApi", "1.8")`
  ([runtime checks](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/specify-api-requirements-runtime))
  and, where it is missing, offers no list validation and says why. The
  check and the replacement need nothing beyond the manifest's ExcelApi 1.7;
  the replacement's spill check
  ([getSpillParentOrNullObject](https://learn.microsoft.com/en-us/javascript/api/excel/excel.range#excel-excel-range-getspillparentornullobject-member(1)))
  needs ExcelApi 1.12 and is left out where Excel lacks it.
- An Excel list written into the rule is "a string that contains a
  comma-separated number, Boolean, or date"
  ([ListDataValidation](https://learn.microsoft.com/en-us/javascript/api/excel/excel.listdatavalidation)),
  so a value with a comma in it cannot be in it: the pane says so and offers
  no list validation for that list. The Office.js reference gives no length
  limit. Microsoft's VBA reference for the same list rule says its
  `Formula1`, a comma-delimited list of values, "must not exceed 255
  characters"
  ([Validation.Add](https://learn.microsoft.com/en-us/office/vba/api/excel.validation.add));
  that is VBA, not Office.js. The task pane refuses a list longer than 255
  characters with its commas, with the length in the message.
- `dataValidation.clear()` also clears validation a person added by hand
  ([data validation in Excel add-ins](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-data-validation)),
  and only the `stop` alert style prevents an invalid entry (same page).
- A worksheet has 1,048,576 rows
  ([Excel specifications and limits](https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3)).
- No limit on the number of values in a list rule was found in Google's
  documentation, and the Apps Script `requireValueInList` page could not be
  read here; a 500-item limit is reported but unconfirmed (see "Not
  verified here"). The sidebar refuses nothing for size; a rule the spreadsheet
  refuses comes back as "Could not turn on list validation for column C:
  ..." with Google's message. Builder and range calls:
  [DataValidationBuilder](https://developers.google.com/apps-script/reference/spreadsheet/data-validation-builder),
  [Range](https://developers.google.com/apps-script/reference/spreadsheet/range),
  [Sheet.getMaxRows](https://developers.google.com/apps-script/reference/spreadsheet/sheet#getMaxRows()).

Nothing typed in the pane or read from cells is sent anywhere, and the
bundle makes no network request. The Excel page loads Office.js from
Microsoft's CDN; nothing else is fetched. In Google Sheets the sidebar calls
the script's own functions in `Code.gs` (`google.script.run`), which run on
Google's servers; the add-in contacts no other server. The usage counts, which
hold no cell text, are kept in the host's own store (this browser in Excel,
the person's user properties for the script in Google Sheets, below), never
in the spreadsheet, and reach the desk only when the person copies them.

## What is written

- A completion replaces the cell's text, or in a notes column the sentence
  being typed; the text before it stays. The cell gets the text number format
  (`@`) before the value, in both hosts.
- Values a cell would evaluate as a formula (`=`, `+`, `-`, `@`, tab, CR, unless
  a plain signed number; and the full-width `＝`, `＋`, `－`, `＠`, with no number
  exception) never come from a vocabulary or a column. Whether either host
  evaluates the full-width forms is unconfirmed; they are kept out all the
  same. A leading space or other character is not checked. The typed
  start of a notes cell is not filtered by the core, so the pane checks the
  final text: when it would start like a formula (`+49 reached. Promised a
  call back.`), nothing is written and the pane says to change the first
  character. Whether the `@` format alone would keep such text as text in
  either host is unconfirmed, so the pane does not rely on it.
- A block's rows are listed under its **Insert** button before anything is
  written (the first 5 rows, text in quotes so a tab or a leading space
  shows, at most 200 characters a row), then written as a rectangle from
  the selected cell, text cells as text, numbers and booleans in the
  general format. Rows follow the vocabularies' rule: a block with a text
  cell a cell would read as a formula is dropped, with a warning naming its
  row and column, when the configuration is read, and the pane checks again
  before writing, so an older `dist/sheets-core.js` served next to this
  `pane.js` still writes nothing. The `@` format is not relied on.
- A formula block's button shows the formula, and the formula goes into the
  selected cell as a formula. A formula or rows from a document's own
  configuration wait for the confirmation described above; the
  organisation's are written on **Insert**.
- In a strict column, the list's spelling replaces an alias as text (`@`),
  cell by cell, only in the cells the confirmed check found, only where the
  text is still what the check read, and never in a cell that holds a
  formula (a cell an array formula in another cell fills, in Google, and a
  spilled cell in an Excel without ExcelApi 1.12, are not recognised and are
  overwritten, see above); list validation is a rule on the column's cells,
  not a value. Both wait for a confirmation.

## Usage counts for the desk

The pane counts what it writes, so the desk's statistics and the
organisation's usage reports include spreadsheet work. The add-in contacts no
server other than its host's own, and an Office page (HTTPS) or Apps Script
(Google's servers) cannot be assumed to reach the desk, so the counts travel
the way the configuration does, the other way round: as a text the person
copies from the pane and pastes into the desk's extle tab. The model is
`core/sheets-usage.js`.

What is counted:

- A completion written into a cell, and a block or formula written by
  **Insert** (for a document's configuration, by **Write the formula** or
  **Write the rows**). Nothing else: a completion the pane refuses (a start a
  cell could read as a formula), a write the host refuses or that fails, an
  **Insert** that only opens a confirmation, **Cancel**, **Check this
  column**, the replacement of aliases and list validation count nothing.
- Per day (the computer's local date) and per counter: the number of uses and
  the keystrokes saved, which are the graphemes written minus the graphemes in
  the pane's box before (never below 0), counted as the desk counts its own
  inserts. Rows count each cell's text plus one keystroke for each move to the
  next cell.
- The counter's name: the vocabulary's name for a vocabulary completion (a
  strict column's too), the trigger for a block or formula, and only from the
  organisation's configuration, the browser copy. A completion from the
  column's own values or a notes sentence has no name. While the document's
  own configuration is in use, every use is counted under source `document`
  with no name: that configuration's names are the document author's text.
  What counts is the configuration in use when the write started, so **Stop
  using it** while a write is on its way does not give it the document's
  names.

Limits (`LIMITS` in `core/sheets-usage.js`): the newest 120 days are kept, and
older days are dropped (a day after today, from a clock that went back or a
time zone crossed westwards, is kept until there are 120); 12 names a day, a
further name is counted without it; a name of 1 to 40 characters with no
control character and no character outside the Basic Multilingual Plane is
kept, any other is counted without it (this leaves out most emoji, not all:
a name with ✅ or ⚠ is kept); 100,000 uses a counter a day (a use past it is
not counted) and 100,000,000 keystrokes. With these the longest text the pane
can write is 279,691 bytes, with 12 names of 40 three-byte characters on each
of 120 days (`test/sheets-usage.test.js` builds it), under a Google user
property store's 500 KB.

The text is JSON: `format` `"extle-usage"`, `version` 1, `instance` (32
hexadecimal characters made once by the add-in with `crypto.getRandomValues`,
which also works in pages that are not HTTPS
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues));
`Math.random` where a host has no Web Crypto API), and `days`, each a list of
`[kind, source, name, uses, keystrokes]`:

```
{"format":"extle-usage","version":1,"instance":"9f3c…","days":{"2026-10-23":[["completion","vocabulary","customers",3,48],["block","formula","/vat",1,14],["completion","column","",2,9]]}}
```

It never holds cell text, what was typed, sheet, workbook, file or document
names, cell addresses or times of day.

Where the counts are kept:

- Excel: the task pane's `localStorage`, key `actleSheetsUsage`. Microsoft's
  page on persisting add-in state lists browser storage for data kept across
  add-in instances. For state kept across documents it recommends another
  approach, such as single sign-on and the add-in's own online database,
  which this add-in does not have. The same page says browser storage is
  partitioned: Chromium-based browsers from version 115 keep it per origin
  and top-level site, and `Office.context.partitionKey`, where it is defined,
  is a hash of the top-level window's domain and the add-in's. The page
  suggests prefixing `localStorage` keys with that key; the pane does not,
  for the configuration or the counts. The document settings travel with
  the file, and `OfficeRuntime.storage` belongs
  to the SharedRuntime 1.1 requirement set (custom functions and the shared
  runtime), which this manifest does not declare
  ([persisting add-in state](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/persisting-add-in-state-and-settings),
  [OfficeRuntime.Storage](https://learn.microsoft.com/en-us/javascript/api/office-runtime/officeruntime.storage)).
  Whether task panes in two workbooks share the counts was not checked.
  Where they do not, each store makes its own instance id, and the desk adds
  each one's uses on their own.
- Google Sheets: the person's user properties for this script
  (`PropertiesService.getUserProperties()`), not the sidebar's
  `localStorage`, which may not persist. Only that person can read them, and
  only through this script
  ([PropertiesService](https://developers.google.com/apps-script/reference/properties/properties-service)),
  so for a script added to one spreadsheet they belong to that spreadsheet's
  script, and for the published add-on to every spreadsheet it runs in. They
  are cut into pieces of at most 8,192 UTF-8 bytes with the count written
  last, like the configuration; one value holds 9 KB and one store 500 KB
  ([quotas](https://developers.google.com/apps-script/guides/services/quotas)).
  A save that fails halfway leaves no counts stored. If nothing else saves
  before this pane's next save, that save writes all the pane's counts
  again. A sidebar opened in between starts with none, and if it saves
  first, this pane's next save adds only the uses it counted since its last
  save that worked: the uses stored before the failure are lost from the
  store, and the desk never gets those it had not imported yet. They are
  lost, never counted twice. No scope was added to `appsscript.json`:
  whether the Properties service needs one of its own could not be
  confirmed, since Google's pages could not be opened here. The document
  properties use the same service under the same manifest; neither has been
  run against Google.
- In Google, a save whose reply is lost after `Code.gs` stored the text
  (the sidebar is told the call failed although it worked) is tried again
  with the same uses, so they are stored twice and the desk counts them
  twice. Whether `google.script.run` can report a failure after the
  server function finished was not confirmed. `localStorage` is not
  affected: `setItem` throws only when it did not write.
- The **Usage** section says where the counts are kept, or that they are
  kept for this session only and why: the browser cannot keep them, or the
  stored counts could not be read, and then nothing is written over them. A
  save that fails is said ("The latest counts could not be kept (...)");
  counting goes on, and the next use saves again. Stored text that is not a
  usage text is replaced, and the pane says so. One save runs at a time; uses
  counted while it is on its way go with the next, and the totals shown
  include them meanwhile.
- Several panes can share one store: a person's sidebars in two
  spreadsheets of the published add-on, and task panes in two workbooks
  when the browser gives them the same storage (not checked, see above). A
  save therefore reads what is stored first and adds only the uses this pane
  counted since its own last save, and **Copy for the desk** reads the store
  before it writes the text, so it holds what the other panes saved. Where
  nothing readable is stored (a person's first save, or after a save that
  failed halfway), the save writes what the pane held when it started, not
  uses counted while it read, which go with the next save. Within one Excel
  pane nothing runs between the read and the write; whether task panes in
  two Excel windows, which may run in separate processes, can save between
  each other's read and write was not checked. In Google they are two calls
  to Code.gs, and two sidebars that save in the same moment can still lose
  one's uses, since nothing locks the store. A read that fails keeps the uses
  for the next save.
- **Copy for the desk** saves first. When that save fails, it gives no text
  and says so: until a save works, the pane may still hold an instance id of
  its own, and once it works its uses join the stored counts under the stored
  id, so a text copied before would have the desk count them twice. Try again
  once the counts are saved. A pane that keeps its counts for this session
  only never joins a store, so it always gives its text.

Handing them over: **Usage** in the pane shows today's and the last 7 days'
uses and keystrokes saved. **Copy for the desk** puts the text into the
read-only box below it, selects it and tries `navigator.clipboard.writeText`.
An Office or Apps Script frame may refuse that. In Chromium-based browsers
the write needs the `clipboard-write` permission or a recent click (transient
user activation), and a frame needs `clipboard-write` allowed by the page
around it; Firefox and Safari need the recent click and do not support the
permission
([MDN: Clipboard API, security considerations](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API#security_considerations)).
**Copy for the desk** saves the counts before it writes, which in Google
Sheets is a call to the script, so the click may no longer count by then.
A clipboard write from an Outlook on the web task pane has been reported
blocked by the frame's permissions policy
([office-js issue 1991](https://github.com/OfficeDev/office-js/issues/1991));
nothing was found for Excel or for Apps Script sidebars. The status line then
says to copy the selected text by hand. On the desk,
paste it into **Usage from the add-in** on the extle tab and choose
**Import** (`corporate/desktop/README.md`). Importing the same text again adds
nothing and a later text adds only what is new, so the pane never needs to be
reset. The desk remembers what it imported for a day until the day is older
than both its statistics' history and 121 days, and longer while its
statistics still hold an extle use of that day.

## Excel: sideload and deploy

1. Serve this folder over HTTPS with a certificate Excel trusts, for example
   `https://localhost:3000` during development (any static file server; the
   Office tooling's dev certificate works). `taskpane.html`, `pane.js`,
   `pane.css` and `dist/sheets-core.js` must be reachable.
2. Replace the placeholders in `manifest.xml`: the `<Id>` GUID
   (`7b1f6c9a-0000-4000-8000-000000000001`), every `https://localhost:3000`
   URL, and the icon files (`assets/icon-16.png`, 32, 64, 80 are referenced
   but not shipped).
3. Sideload: on Windows, share a folder with the manifest and add it under
   File → Options → Trust Center → Trusted Add-in Catalogs, then
   Insert → My Add-ins → Shared Folder; on macOS, copy the manifest to
   `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef`; in Excel on
   the web, Insert → Add-ins → Upload My Add-in. The manifest puts an
   **Open extle** button in an **extle** group on the Home tab; it opens the
   pane.
4. Deploy: host the files on your own HTTPS origin, point the manifest at it
   and publish the manifest through the Microsoft 365 admin center
   (Integrated apps) so every desk gets it.

The pane refreshes on every selection change and reads at most the first
5,000 rows of the column (the selected cell's own row is left out); a longer
column is marked "first rows only".

## Google Sheets: Apps Script

1. `node build.js` to generate `apps-script/sheets-core.html` and
   `apps-script/pane.html`.
2. Open the spreadsheet, Extensions → Apps Script, and add the four files
   under `apps-script/` (`Code.gs`, `Sidebar.html`, `sheets-core.html`,
   `pane.html`; `appsscript.json` is the manifest, shown after enabling it in
   the project settings). With `clasp`, `clasp push` from `apps-script/` does
   the same.
3. Reload the spreadsheet: the **extle** menu opens the sidebar.
4. For every sheet in the organisation, publish the script as an editor
   add-on from the Apps Script project (Deploy → New
   deployment) and install it for the domain. Menus and HTML sidebars are a
   feature of editor add-ons; Google Workspace add-ons use cards instead. A
   published add-on does not show the **extle** caption from `Code.gs`: its
   menu appears under Extensions with the name the add-on is published
   under, so publish it as extle.

The sidebar gets no selection events from Google Sheets, so it asks the
server for the selection every 2 seconds, one request at a time (a tick that
fires while the last answer is still on its way is skipped), and has a
**Refresh** button. The pane also drops an answer that arrives after a newer
one, so a slow read never puts an earlier selection back.

## Tests

```
cd corporate
node --test sheets-addin/test/pane.test.js sheets-addin/test/hosts.test.js   # the add-in alone
npm test                                                                    # the whole business edition
```

`pane.test.js` drives the shared pane with a fake document and a fake host
bridge, including a block with a formula-like text cell (with the current
core, and with an older one that kept it), the rows list under Insert, and a
configuration the document carries: offered with what it changes (names
quoted and cut, formula blocks first, the list capped, the order of values
and aliases ignored), used only on request, its formulas and rows confirmed
(including a trigger the organisation also defines, the range rows replace,
the status line and the focus), never copied into the browser, never erased
by an empty Save; a strict column (completions from the list only, the
check's lists and their cap, the header cell, "first rows only", the
replacement with its confirmation, focus, stale buttons from another column
or a dropped question, a cell that changed, cells a formula fills, a write
that stopped, the re-read after it, the label for aliases or other
spellings, list validation on and off, a list the host cannot take, a host
without the API, a host error, a document's strict rule, and a question or
check from the document's configuration after Stop using it or Save while
the organisation's makes the same column strict) and the full-width formula
guard; and the usage counts: only writes that succeeded, with the
vocabulary's name or the trigger, none for a document's configuration (also
when **Stop using it** comes while the write is on its way), a stored text
continued, a browser that cannot keep, read or save them, a bridge store used
instead of the browser and never written after a failed read, one save at a
time, a use counted while a save reads an empty store saved once, two panes
sharing one store, a **Copy** with nothing new that writes nothing back, an
older core without the usage model, and **Copy for the desk** with and
without the clipboard and after a save that failed.
`hosts.test.js` evaluates `taskpane.js` against a fake Excel workbook behind
the Office.js objects it touches (used range at row 1 and lower, header-only
and empty sheets, the 5,000-row clip, the order of number format and value,
a workbook whose settings carry another configuration), `Code.gs` against
fake `SpreadsheetApp` and `PropertiesService` (row arithmetic, the byte-sized
pieces, a shrink that deletes stale pieces, a write that fails halfway, a
missing piece) and the inline script of
`Sidebar.html` against a deferred `google.script.run` (the spreadsheet's
configuration reaching the pane as an offer, the poll guard, a failure
handler becoming an error), and both bridges' replacement (a cell that
changed is skipped, a formula cell is left, in Excel a spilled cell is left
where ExcelApi 1.12 is there, a protected cell stops the writes with the
cells written before it), list rule, clearing, the Excel limits (255 characters,
a comma in a value), the missing ExcelApi 1.8, and a Google sheet with no row
below the header; and the usage counts: `Code.gs` keeps them in the user
properties in pieces (the longest text fits one store; the property calls a
save takes), the sidebar reads
them before the selection and saves them after a write, the Excel task pane
keeps them in `localStorage`. `corporate/test/sheets-usage.test.js` covers the
usage model (names, caps, days, the merge, the longest text, the parser's refusals), and
`corporate/test/sheets-app.test.js` the build, the bundle in a sandbox with
and without `Object.hasOwn`, the desktop channels (the import included, with
a ledger that stops partway and retention dropping old days), the pane and the
desk together (no text after a failed save), the usage reports and the
dashboard tab.

## Not verified here

This folder was written in a Linux container without Excel, Office.js, a
Google account or a browser:

- The real hosts were not run. The fakes mirror the documented Office.js and
  Apps Script calls (`getActiveCell`, `getUsedRangeOrNullObject`, `text`,
  `numberFormat`, `values`, `formulas`, document settings, the
  selection-changed event; `getDisplayValues`, `setNumberFormat`, `setValue`,
  `setValues`, `setFormula`, document properties, `google.script.run`), not
  their behaviour: whether `numberFormat = "@"` followed by
  `values = [[text]]`, or `setNumberFormat("@")` then `setValue(text)`, keeps
  a date-like string, or `=1+1`, as text is unconfirmed. When a host is
  available, check by hand: a completion `21.10.2026` in a text column stays
  `21.10.2026`; `CC-100` stays text; a notes cell `+49 reached. Prom` is
  refused by the pane with the message above; a workbook saved with another
  configuration in its settings shows the offer and leaves the
  organisation's copy in use.
- Strict columns were run against the fakes only. Not checked in a real host:
  that Excel accepts `dataValidation.clear()` and a new `rule` in one batch,
  that the inline list shows as a dropdown and the stop alert refuses other
  values, how a list over 255 characters behaves when set from Office.js,
  whether a locale whose list separator is `;` reads the comma-separated
  `source` the same way, that `isSetSupported("ExcelApi", "1.8")` answers
  as documented on each platform, and what Excel does when the rule is
  refused after `clear()` has run; in Google, that `requireValueInList` with
  `setAllowInvalid(false)` refuses other values, what it does with a pasted
  value or a value written by a script, how large a list Google accepts
  (a Google Apps Script Community thread is cited, in search summaries
  only, for an error above 500 items: "The data validation rule has more
  items than the limit of 500"; neither it nor Google's pages could be
  opened here), whether rows inserted or appended later
  take the rule, and that `clearDataValidations` leaves the cells' values.
  In both hosts: whether the list rule compares a typed value with the
  list's values case-sensitively (forum reports about Excel, seen only as
  search summaries, disagree; nothing was found for Google). If it does not, a value in other capitals gets past
  list validation, and **Check this column** still lists it. The fakes' Apps Script
  `DataValidation` getters follow the reference's names; what
  `getCriteriaValues()` returns for a list was not read from Google's page.
- The replacement's formula and failure handling ran against the fakes only.
  Not checked in a real host: that Excel's `formulas` starts with `=` for
  every formula cell and `getSpillParentOrNullObject()` finds a spilled cell
  on each platform; that a failed Excel batch carries `traceMessages` as the
  `OfficeExtension.Error` reference describes (without them the pane reports
  only the error, and cells before the failing one may have been written);
  that Apps Script's `getFormulas()` gives an empty string for a cell
  without a formula (the reference page could not be opened here; a search
  summary of `getFormula()` says so); whether a protected cell makes
  `setValue` throw at that cell or later in the script run; and what an
  array formula shows once a cell it fills has been written over (community
  posts, seen only as search summaries, report Google's "Array result was
  not expanded because it would overwrite data"; no official page saying
  what either host does could be read here).
- Whether Excel or Google Sheets evaluates a value that starts with a
  full-width `＝`, `＋`, `－` or `＠`, or with a space before `=`, was not
  checked; the first four are refused anyway, the space is not.
- Whether a host's webview keeps `localStorage` from one document to the
  next (Excel on each platform; the Apps Script sidebar's sandbox) was not
  checked. Where it does not, the organisation's copy does not carry over
  and each document's own configuration is offered instead.
- The usage counts ran against the fakes only. Not checked in a real host:
  that Excel's task pane keeps `localStorage` from one session and document
  to the next on each platform; that Apps Script's user properties need no
  scope beyond `appsscript.json` and keep the pieces as the fake does (how
  Google counts a store's 500 KB, keys included or not, was not found); the
  daily quota for property reads and writes, which search summaries of
  Google's [quotas](https://developers.google.com/apps-script/guides/services/quotas)
  page give as 50,000 for a consumer account and 500,000 for Google
  Workspace (the page itself could not be opened here, and one third-party
  page gives 50,000 for both); how long a `google.script.run` save takes;
  whether task panes in two Excel workbooks share one `localStorage`;
  whether `google.script.run` can report a failure for a save that was
  stored; and whether either frame lets `navigator.clipboard.writeText`
  through, before or after the save **Copy for the desk** waits for. The
  pane saves after each counted use (uses counted while a save is on its way
  share the next one), and a save spends 2 + n property reads and 2 + n
  writes, n being the pieces the text takes, plus a delete for each piece a
  shorter text no longer needs: 6 calls for a text of one piece, 74 for the
  longest (35 pieces). **Copy for the desk** with nothing new spends 1 + n
  reads.
- `manifest.xml` has not been validated by Office or sideloaded; the icons it
  references are not shipped.
- The pane's layout (`pane.css`), including the document configuration's
  offer, the formula and rows confirmation, the rows list, the strict
  column's panel and the **Usage** section (the totals line, the note,
  **Copy for the desk** enabled and disabled, the read-only text box filled
  and selected, and the status line), was not seen
  in any browser, theme or webview; which Office hosts still lack
  `Object.hasOwn` was not checked.
- The confirmation's focus and announcements were checked against a fake
  document only (which element `focus()` was called on, the status line's
  text, the `aria-describedby` ids), not with a screen reader or in a
  webview. The sidebar redraws the pane on every 2-second poll; focus on
  **Insert**, **Write the formula** or **Write the rows**, **Cancel** and the
  strict column's buttons is carried over to the redrawn button, focus on a
  completion button is not.
- The 5,000-row read limit's effect on large real sheets and the 2-second
  polling of the sidebar were not measured.
