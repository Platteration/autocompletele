# actle – Chrome and Firefox extension

Expands shorthands such as `cool/` into full text in supported webpage text
fields, textareas, and rich-text editors (contenteditable), as you type.
Password fields are excluded. Browser-protected pages and some custom editors
do not allow expansion.

![The actle logo autocompletes to autocompletele](store/images/actle-autocomplete.gif)

The preview loops here; the extension plays the logo once and lets you replay it.

## Install in Chrome (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `chrome-extension` folder.
3. The options page opens automatically; add your shorthands there.

Type a trigger in the **Try it** box on the options page to see it work.
Press Backspace right after an expansion to get the trigger back.

## Install in Firefox (temporary development install)

Firefox 142 or later is required. From this directory, run `npm run build`,
open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
and select `dist/firefox/manifest.json`. Open the extension's options from
`about:addons` if the manager does not open automatically.

Temporary installations are removed when Firefox restarts. A regular Firefox
release must be signed through Firefox Add-ons. The Chrome manifest in the
source directory is not the Firefox package.

## Your shortcut library

The library has a navy sidebar linking to your library, playground, settings,
and import/export tools. Saved shorthands appear beside the script editor, with
three-line text previews and a badge showing each template's number of blanks.
The selected script is highlighted while you edit it. Narrow windows stack the
library and editor, keeping the editing controls in view. The library, toolbar,
search overlay, and fill-in form follow the browser's light or dark appearance.
Keyboard focus, selected results, and disabled controls have distinct states.

The actle logo completes `actle` into `autocompletele` once when the library or
toolbar popup opens. Select the logo to replay the completion. Reduced-motion
preferences suppress the animation. Store screenshots show the resting logo;
the promotional tile uses a static `actle → autocompletele` motif.

## Fill-in templates

Save one reusable script with named blanks, like a Mad Libs:

```text
Hi [[name]],

Thanks for reaching out about [[topic]].
I’ll follow up on {date}. Thanks again, [[name]]!
```

Give it a trigger such as `hello/`. Type that trigger, choose the script from
the `;;` picker, or select **Fill in** in the toolbar. A form asks for `name`
and `topic`, with a live preview of the finished text. Use the **Fields** table
for one row per named blank, or switch to **In message** to fill blue blanks
where they appear in the script. Repeated `[[name]]` blanks share one answer
across both views. Fill every blank, then choose **Insert text** on a
webpage or **Copy text** in the toolbar. Enter also submits a completed form;
Escape or **Cancel** dismisses it without inserting or copying text. The page's
trigger remains until you confirm. If the original field changes or becomes
unavailable while the form is open, insertion stops with a message and your
answers remain in the form.

In the editor, type `[[name]]` directly or enter a name under **Add a fill-in
blank** and choose **Insert blank** to add it at the script's caret. To insert
the same blank again, choose its blue button under **Reuse a blank**. Reusing
it links another occurrence to the same answer. The script preview highlights
blanks before you save. Names are trimmed and case-sensitive:
`[[ name ]]` and `[[name]]` share an answer; `[[Name]]` is a separate blank.
Names cannot be empty or contain brackets or line breaks. Write `\[[name]]`
in the script to insert the literal text `[[name]]` without a prompt.

The editor's **Insert variable** menu inserts `{date}`, `{time}`, `{datetime}`,
`{cursor}`, `{weekday}`, or a pronoun variable at the script's caret. `{weekday}`
uses the current local weekday in English, such as `Sunday`. A weekday-only
script expands directly, without a fill-in form. In a form, the date, time,
and weekday are fixed when it opens so the preview matches the inserted text.

Add pronoun variables when a script refers to a person. Each use asks you to
choose **she/her**, **he/him**, **they/them**, or **Custom**; that choice supplies
all pronoun occurrences in the message. It is never inferred from a name.

| Variable | she/her | he/him | they/them |
| --- | --- | --- | --- |
| `{subject}` | she | he | they |
| `{object}` | her | him | them |
| `{possessive}` (before a noun) | her | his | their |
| `{possessivepronoun}` (on its own) | hers | his | theirs |
| `{reflexive}` | herself | himself | themself |

For example, `On {weekday}, [[name]] said {subject} would bring {possessive}
notes. Thank [[name]] for helping.` combines the weekday, one linked name,
and one pronoun choice. Use `{Subject}` for a capitalized first letter or
`{SUBJECT}` for capitals throughout. Write `{{weekday}}` or `{{subject}}` to
insert the literal token without evaluating it. A named blank such as
`[[subject]]` remains a separate free-text answer.

Answers are inserted literally: entering `{date}`, `{cursor}`, or `[[other]]`
as an answer does not run another placeholder or create another blank. Answers
and chosen/custom pronouns are temporary; they are not saved to your library,
synchronized, or included in JSON exports. Your saved script keeps its blanks
and variables for the next use.

Fill-in forms are available in the Chrome and Firefox extensions. JSON transfer
preserves the script text in the Windows and Android apps, but those apps do not
prompt for answers and leave `[[name]]`, `{weekday}`, and pronoun variables in
the expanded text. The existing date/time/cursor placeholders still work there.

## Toolbar command palette

Open the extension from the browser's toolbar to get a compact searchable view of
your shorthand library. Search matches triggers first and then expansion text;
press Enter to copy the top result, or use the arrow keys to move through the
results. A template opens its fill-in form first; **Copy text** copies the
completed script with its date/time/weekday placeholders rendered and its
`{cursor}` marker removed. A script using only `{weekday}` and automatic
placeholders copies the rendered text directly. Ordinary snippets without
named blanks or the new variables still copy their saved text, including
built-in placeholders. The same popup also shows whether expansion is
active globally and on the current site, with quick toggles for both.

This makes the toolbar useful even when you only half remember a trigger, and
lets you grab an expansion for places where automatic insertion is not wanted.

## Search overlay

Typing `;;` in a supported field opens a search overlay listing every shorthand: type
to filter, arrow keys to choose, Enter to insert, Esc to cancel. It is there
for the snippets you cannot remember the trigger for.

While you search, focus stays in the page's own field. The search overlay never
calls `focus()`, and instead intercepts keys at the document level, so searching
does not disturb sites that close menus or save drafts on blur. Selecting a
template moves focus to its fill-in form until you insert or cancel. Both
overlays render in closed shadow roots to isolate their styles from the page.

Change or disable the trigger on the options page.

Chrome stores your library and settings in extension sync storage, so they can
follow your Chrome profile when its sync settings permit it. Firefox stores
them locally in your browser profile and does not automatically sync them.
Use JSON export and import to move your library between browsers or devices.
Use **Export JSON** / **Import JSON** on the options page to move it to the
Windows and Android apps (same file format, see `../shared/SPEC.md`). Imports
are previewed before applying: the manager shows how many triggers are new,
updated, or unchanged, and **Merge safely** preserves local-only shorthands.
A full replacement is still available when that is what you intend.

## For site authors

Add `data-shorthand-ignore` to any element to stop the extension expanding
inside it (the attribute also applies to all descendants).

## Files

| File                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `manifest.json`       | Manifest V3 definition                                         |
| `src/expander.js`     | Pure matching/placeholder logic (shared with the tests)        |
| `src/template.js`     | Named-blank parsing and literal-answer substitution             |
| `src/template-form.js` | Temporary fill-in form and live preview                       |
| `src/storage.js`      | Chrome sync / Firefox local storage (one key per shorthand)    |
| `src/content.js`      | Watches editable fields and performs the replacement           |
| `src/picker.js`       | The `;;` search overlay (closed shadow root, key capture)       |
| `src/palette.js`      | Pure ranking logic for the toolbar command palette             |
| `src/import-plan.js`  | Pure import preview and safe-merge planning                    |
| `src/background.js`   | Background initialization: seeds examples, updates the badge  |
| `src/options.*`       | Library manager, previewed imports, export, excluded sites     |
| `src/popup.*`         | Toolbar search/copy palette plus global and per-site controls  |
| `test/`               | Unit tests (`npm test` in `chrome-extension/`)                 |
| `scripts/build.js`    | Browser-specific manifests and reproducible release ZIPs      |

## Build release packages

With Node.js 22.2 or later, run from this directory:

```sh
npm run build
```

This uses Node's built-in modules and needs no dependency installation. It
creates unpacked browser directories at `dist/chrome/` and `dist/firefox/`,
plus `dist/actle-chrome-1.0.0.zip` and
`dist/actle-firefox-1.0.0.zip` for the current manifest version.
Each ZIP places its browser-specific `manifest.json` at the root and includes
only runtime scripts, styles, HTML, and icons. Tests, development dependencies,
and store documentation are not bundled. Rebuild after changing runtime files.
Keep the Firefox extension ID in `scripts/build.js` stable across releases so
Firefox can associate updates and saved data with the same extension.

## Store submission

[store/LISTING.md](store/LISTING.md) contains listing copy, permission
justifications, screenshot specifications, and a reviewer walkthrough. The
completed [privacy policy](store/PRIVACY.md) has a public URL recorded in the
listing. Registered store accounts and final dashboard declarations are required
to publish.

The [store images](store/LISTING.md#screenshots-and-artwork) include light/dark
captures of the running Chrome and Firefox libraries, fill-in forms, the
in-field picker, and a small promotional tile. To refresh them after rebuilding,
run
`node scripts/store-assets.js` and `node scripts/store-assets-firefox.js` with
the browser environment described below. These use disposable browser profiles
and fictional snippets; they do not modify your library.

## Development and validation

Install the pinned development tools and dedicated test browsers:

```sh
npm ci
npx playwright install --no-shell chromium firefox
# Linux x86_64: install the pinned Firefox driver, verifying its archive checksum.
bash scripts/install-geckodriver.sh /tmp/shorthand-geckodriver
export GECKODRIVER_PATH=/tmp/shorthand-geckodriver/geckodriver
```

Then run:

```sh
npm run check             # JavaScript syntax
npm test                  # matching, templates, placeholders, storage, imports and packaging
npm run build             # generate both browser packages
npm run lint:firefox      # validate the generated Firefox extension with web-ext
npm run test:e2e          # Chromium extension behavior
npm run test:e2e:firefox   # Firefox extension behavior
```

The end-to-end suite in `e2e/` loads the unpacked extension into Chromium and
types into a fixture page, covering what unit tests cannot: text insertion,
caret placement, the undo window, and the overlay swallowing keystrokes without
taking focus while searching, plus filling and inserting templates. The separate
`e2e-firefox/` suite exercises the generated Firefox package. Install browser OS
dependencies if Playwright reports them missing; on a supported Linux development
machine, use `npx playwright install-deps`.
On other platforms, install geckodriver 0.37.1 and set `GECKODRIVER_PATH` to
its executable. `FIREFOX_PATH` can override the dedicated Firefox executable.
The driver uses `--allow-system-access` only in its disposable test profile to
exercise extension pages. If a nested cloud sandbox prevents Firefox startup,
scope `MOZ_DISABLE_CONTENT_SANDBOX=1` to `npm run test:e2e:firefox` in that
environment; ordinary development and CI keep the browser sandbox enabled.
Managed browser policies can prevent loading unpacked extensions, so use the
dedicated test browsers instead of a policy-restricted system browser.

Set `EXTENSION_PATH=dist/chrome` when running the Chrome suite to exercise the
exact staged release package. `npm run build` must run first for both browsers.

Passing these checks does not sign a Firefox release or submit either store
listing. Before upload, test each generated package with the reviewer walkthrough
in [store/LISTING.md](store/LISTING.md).
