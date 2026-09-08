# Shorthand Autofill – Chrome extension

Expands shorthands such as `cool/` into full text in any web page text field,
textarea or rich-text editor (contenteditable), as you type.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `chrome-extension` folder.
3. The options page opens automatically; add your shorthands there.

The list is stored in `chrome.storage.sync`, so it follows your Chrome profile.
Use **Export JSON** / **Import JSON** on the options page to move it to the
Windows and Android apps (same file format, see `../shared/SPEC.md`).

## Files

| File                 | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `manifest.json`      | Manifest V3 definition                                  |
| `src/expander.js`    | Pure matching/placeholder logic (shared with the tests) |
| `src/storage.js`     | Storage helper (one sync key per shorthand)             |
| `src/content.js`     | Watches editable fields and performs the replacement    |
| `src/background.js`  | Service worker: seeds examples, keeps badge in sync     |
| `src/options.*`      | Options page: manage, import, export, excluded sites    |
| `src/popup.*`        | Toolbar popup: quick on/off, per-site on/off            |
| `test/`              | Unit tests (`node --test chrome-extension/test`)        |

## Tests

```
node --test chrome-extension/test
```
