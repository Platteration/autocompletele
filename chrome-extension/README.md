# Shorthand Autofill – Chrome extension

Expands shorthands such as `cool/` into full text in any web page text field,
textarea or rich-text editor (contenteditable), as you type.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `chrome-extension` folder.
3. The options page opens automatically; add your shorthands there.

Type a trigger in the **Try it** box on the options page to see it work.
Press Backspace right after an expansion to get the trigger back.

## Search overlay

Typing `;;` in any field opens a search overlay listing every shorthand: type
to filter, arrow keys to choose, Enter to insert, Esc to cancel. It is there
for the snippets you cannot remember the trigger for.

Focus deliberately stays in the page's own field the whole time. The overlay
never calls `focus()`, and instead intercepts keys at the document level, so
sites that close menus or save drafts on blur are not disturbed. It renders in
a closed shadow root so page styles cannot reach it and its own cannot leak.

Change or disable the trigger on the options page.

The list is stored in `chrome.storage.sync`, so it follows your Chrome profile.
Use **Export JSON** / **Import JSON** on the options page to move it to the
Windows and Android apps (same file format, see `../shared/SPEC.md`).

## For site authors

Add `data-shorthand-ignore` to any element to stop the extension expanding
inside it (the attribute also applies to all descendants).

## Files

| File                 | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `manifest.json`      | Manifest V3 definition                                  |
| `src/expander.js`    | Pure matching/placeholder logic (shared with the tests) |
| `src/storage.js`     | Storage helper (one sync key per shorthand)             |
| `src/content.js`     | Watches editable fields and performs the replacement    |
| `src/picker.js`      | The `;;` search overlay (closed shadow root, key capture) |
| `src/background.js`  | Service worker: seeds examples, keeps badge in sync     |
| `src/options.*`      | Options page: manage, import, export, excluded sites    |
| `src/popup.*`        | Toolbar popup: quick on/off, per-site on/off            |
| `test/`              | Unit tests (`npm test` in `chrome-extension/`)        |

## Tests

```
npm test           # matching, placeholder and ranking logic
npm run test:e2e   # drives the real extension in Chromium (needs Playwright)
```

The end-to-end suite in `e2e/` loads the unpacked extension into Chromium and
types into a fixture page, covering what unit tests cannot: text insertion,
caret placement, the undo window, and the overlay swallowing keystrokes without
taking focus. Install its browser once with
`npm install && npx playwright install chromium`.
