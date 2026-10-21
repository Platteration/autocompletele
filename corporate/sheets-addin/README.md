# actle Sheets add-in (Excel and Google Sheets)

Column-aware completion inside the spreadsheet. The actle desktop assistant
cannot see cells, so this folder holds the other half of actle Sheets: a
task pane for Excel and a sidebar for Google Sheets that read the selected
cell, its column header (row 1) and the column's existing values, and offer
completions from the organisation's vocabularies and from the column itself.
Clicking a completion writes it into the cell **as text**, so a code such as
`CC-100` or a value that looks like a date is not reinterpreted. A `/` trigger
typed into the pane's input inserts the policy's block of rows or formula at
the selected cell.

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
    Code.gs                Google Sheets server side: menu, sidebar, read the selection, write a cell
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
(`core/personal.js`, `core/phrase-miner.js`, the personal edition's
`expander.js`, `template.js` and `palette.js`), wraps each module in a tiny
CommonJS shim and writes one script that sets `window.ActleSheets` to the
core's exports (`normalizeSheets`, `columnFor`, `createColumnProfile`,
`complete`, `blockFor`, `importCsv`, `formulaLike`, `suggest`, `exportConfig`,
`parseConfig`, `organizationItems`). The script starts with a two-line
`Object.hasOwn` polyfill, the one ES2022 call the core makes, so an older
Office webview (WebKit before Safari 15.4) can run it; everything else the
bundle uses is ES2020 or older. It touches no network and is deterministic:
the same sources give the same bytes. A module that requires a Node builtin
stops the build with its name, since a browser could not load it. The
generated files are ignored by git (`.gitignore` here); rebuild them after any
change to the core.

## Configuration

The pane needs the `sheets` section of the organisation policy. On the
desktop assistant's **Sheets** tab, **Export add-in configuration** writes it
to `apps/sheets-config.json` in the data folder and shows the path. Open the
pane's **Settings**, paste the file's contents and save. The pane accepts the
exported section, a whole policy file (its `sheets` section is used) or the
JSON text of either; unusable parts are listed under the text box and
skipped, never refused.

Where it is kept:

- Excel: `Office.context.document.settings` (travels with the workbook).
- Google Sheets: the spreadsheet's document properties, cut into pieces of
  at most 8,192 UTF-8 bytes (one property holds 9 KB, measured in bytes, so
  a vocabulary in Cyrillic or Greek takes twice the pieces of one in
  English). The piece count is set to 0 before the pieces are written and
  to the real number after, so a save that fails halfway leaves no
  configuration in the document rather than a mix of old and new pieces;
  the sidebar then uses the browser's copy.
- Both: a copy in the browser's `localStorage`, used when the document has
  no configuration yet or its settings could not be saved. The pane says
  where the configuration was saved ("with this document", "in this browser
  only", or "nowhere" when both failed; it still applies for the session).

No data leaves the spreadsheet: the bundle makes no network request, and
nothing typed in the pane or read from cells is sent anywhere. The Excel page
loads Office.js from Microsoft's CDN; nothing else is fetched.

## What is written

- A completion replaces the cell's text, or in a notes column the sentence
  being typed; the text before it stays. The cell gets the text number format
  (`@`) before the value, in both hosts.
- Values a cell would evaluate as a formula (`=`, `+`, `-`, `@`, tab, CR, unless
  a plain signed number) never come from a vocabulary or a column. The typed
  start of a notes cell is not filtered by the core, so the pane checks the
  final text: when it would start like a formula (`+49 reached. Promised a
  call back.`), nothing is written and the pane says to change the first
  character. Whether the `@` format alone would keep such text as text in
  either host is unconfirmed, so the pane does not rely on it.
- A block's rows are written as a rectangle from the selected cell, text
  cells as text, numbers and booleans in the general format; a formula goes
  into the selected cell as a formula.

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
   the web, Insert → Add-ins → Upload My Add-in.
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
3. Reload the spreadsheet: the **actle Sheets** menu opens the sidebar.
4. For every sheet in the organisation, publish the script as a Workspace
   add-on or editor add-on from the Apps Script project (Deploy → New
   deployment) and install it for the domain.

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
bridge. `hosts.test.js` evaluates `taskpane.js` against a fake Excel workbook
behind the Office.js objects it touches (used range at row 1 and lower,
header-only and empty sheets, the 5,000-row clip, the order of number format
and value), `Code.gs` against fake `SpreadsheetApp` and `PropertiesService`
(row arithmetic, the byte-sized pieces, a shrink that deletes stale pieces, a
write that fails halfway, a missing piece) and the inline script of
`Sidebar.html` against a deferred `google.script.run` (the poll guard, a
failure handler becoming an error). `corporate/test/sheets-app.test.js`
covers the build, the bundle in a sandbox with and without `Object.hasOwn`,
the desktop channels and the dashboard tab.

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
  a date-like string as text is unconfirmed. When a host is available, check
  by hand: a completion `21.10.2026` in a text column stays `21.10.2026`;
  `CC-100` stays text; a notes cell `+49 reached. Prom` is refused by the
  pane with the message above.
- `manifest.xml` has not been validated by Office or sideloaded; the icons it
  references are not shipped.
- The pane's layout (`pane.css`) was not seen in any browser, theme or
  webview; which Office hosts still lack `Object.hasOwn` was not checked.
- The 5,000-row read limit's effect on large real sheets and the 2-second
  polling of the sidebar were not measured.
