# Shorthand Autofill – Chrome and Firefox extension

Expands shorthands such as `cool/` into full text in supported webpage text
fields, textareas, and rich-text editors (contenteditable), as you type.
Password fields are excluded. Browser-protected pages and some custom editors
do not allow expansion.

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

## Toolbar command palette

The library, toolbar, and search overlay share a blue palette and follow the
browser's light or dark appearance. The library opens first, with Settings and
Backup links at the top. Narrow windows display each saved shorthand as a
stacked row with its editing controls in view. Keyboard focus, selected results,
and disabled import controls have distinct visual states.

Open the extension from the browser's toolbar to get a compact searchable view of
your shorthand library. Search matches triggers first and then expansion text;
press Enter to copy the top result, or use the arrow keys to move through the
results. The same popup also shows whether expansion is active globally and on
the current site, with quick toggles for both.

This makes the toolbar useful even when you only half remember a trigger, and
lets you grab an expansion for places where automatic insertion is not wanted.

## Search overlay

Typing `;;` in a supported field opens a search overlay listing every shorthand: type
to filter, arrow keys to choose, Enter to insert, Esc to cancel. It is there
for the snippets you cannot remember the trigger for.

Focus deliberately stays in the page's own field the whole time. The overlay
never calls `focus()`, and instead intercepts keys at the document level, so
sites that close menus or save drafts on blur are not disturbed. It renders in
a closed shadow root so page styles cannot reach it and its own cannot leak.

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
plus `dist/shorthand-autofill-chrome-1.0.0.zip` and
`dist/shorthand-autofill-firefox-1.0.0.zip` for the current manifest version.
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
captures of the running Chrome and Firefox libraries, the in-field picker, and
a small promotional tile. To refresh them after rebuilding, run
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
npm test                  # matching, placeholders, storage, imports and packaging
npm run build             # generate both browser packages
npm run lint:firefox      # validate the generated Firefox extension with web-ext
npm run test:e2e          # Chromium extension behavior
npm run test:e2e:firefox   # Firefox extension behavior
```

The end-to-end suite in `e2e/` loads the unpacked extension into Chromium and
types into a fixture page, covering what unit tests cannot: text insertion,
caret placement, the undo window, and the overlay swallowing keystrokes without
taking focus. The separate `e2e-firefox/` suite exercises the generated Firefox
package. Install browser OS dependencies if Playwright reports them missing;
on a supported Linux development machine, use `npx playwright install-deps`.
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
