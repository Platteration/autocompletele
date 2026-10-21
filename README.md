# actle

actle is the Chrome and Firefox extension for reusable text and fill-in
templates. Define shorthands once and use them in supported webpage fields.
When you type a trigger such as
`cool/`, it is replaced by whatever you defined for it, for example
*"That is really cool, thanks for sharing!"*.

Its logo completes `actle` into `autocompletele` once when you open the library
or toolbar popup. Select the logo to replay it; reduced-motion preferences are
respected. The companion Windows and Android apps retain their existing names.

For shortcut text, choose Expand to fill letters around the shorthand, Casino
to settle scrambling letters, or Off for instant replacement. Continuing to type
finishes the visual effect immediately; reduced-motion preferences suppress it.

Chrome and Firefox also suggest saved shortcuts after you type at least two
characters. Choose with ↑ or ↓, then Enter; Tab keeps its normal behavior.
Suggestions are on by default and can be turned off in Settings. They come
only from your saved library, without learning from typing history or sending
field text to a service. Identified username, password, sign-in code and payment
fields are skipped; detection depends on the page's field metadata.

The browser extensions currently offer an unlimited free preview. **Plans &
support** shows local daily usage and prepares a future free allowance of 100
auto completes per browser profile per day, with a one-time Forever license for
unlimited use. Purchases are not open yet; no price or payment provider is
configured. See [plans and support](chrome-extension/README.md#plans-and-support).

Three apps share the same idea and the same JSON file format, so a list
built on one device can be exported and imported on the others:

| Folder              | Platform | How it works                                                     |
| ------------------- | -------- | ---------------------------------------------------------------- |
| `chrome-extension/` | Chrome, Firefox | Manifest V3 extension; watches supported inputs, textareas and rich editors |
| `windows/`          | Windows  | .NET 8 tray app with a global keyboard hook; works in every program |
| `android/`          | Android  | Accessibility service; works in other apps' text fields          |
| `shared/`           | –        | Format specification and an example `shorthands.json`            |
| `corporate/`        | Windows, macOS, Linux | Business edition: desktop assistant with statistics, learning, keyword offers, document shortcuts and document filing (see below) |

## Business edition

`corporate/` holds **actle Corporate**, a separate desktop assistant for
organisations. It expands the same shortcut library in every application, and
adds what a business asks for: keystrokes and estimated time saved overall and
per day, week and month; learning of recurring phrases and paragraphs in the
applications a person opts in (mail clients, typically), with a diff overlay
that shows which parts of similar messages change and turns them into
`[[name]]` fill-in templates; keyword offers that insert predetermined text
when certain words are written; document shortcuts such as `/sld` that
list the files an organisation designates for a job; and document filing,
which names new files in watched folders from the organisation's naming rule
and moves them where they belong, after the person confirms. Everything is driven by
one organisation policy file (`corporate/shared/ORG-POLICY.md`). See
[corporate/README.md](corporate/README.md) for the assessment, architecture
and current status. Rules for which edition a change touches are in
`AGENTS.md`.

## How triggers work

A trigger fires the moment the text before the caret ends with it, as long
as it is preceded by a space, punctuation or the start of the field. So
`cool/` fires, but typing `school/` does not. Triggers are case-sensitive and
the longest match wins. Ending triggers with a symbol such as `/` means they
never get in the way of normal words.

Pressing Backspace right after an expansion puts the trigger back.

Expansions may contain the placeholders `{date}`, `{time}`, `{datetime}` and
`{cursor}` (where the caret should land afterwards). See
[`shared/SPEC.md`](shared/SPEC.md) for the details.

In Chrome and Firefox, add linked `[[name]]` blanks to a script and fill them
in a table or directly in the message. The editor's **Insert variable** menu
also offers the local `{weekday}` and pronouns chosen for each use. These
browser features preserve their tokens during JSON transfer; Windows and
Android do not fill them. See the [template guide](chrome-extension/README.md#fill-in-templates).

## Quick start

* **Chrome:** `chrome://extensions` → Developer mode → *Load unpacked* →
  pick `chrome-extension/`. See [chrome-extension/README.md](chrome-extension/README.md).
* **Firefox 142+:** run `cd chrome-extension && npm run build`, then load
  `dist/firefox/manifest.json` using **Load Temporary Add-on** in
  `about:debugging#/runtime/this-firefox`. Chrome uses browser sync storage;
  Firefox stores the library locally. Use JSON export/import to transfer it.
* **Windows:** `cd windows && dotnet run --project ShorthandExpander`
  (needs the .NET 8 SDK). See [windows/README.md](windows/README.md).
* **Android:** open `android/` in Android Studio, run on your phone, then
  enable the service under *Accessibility*. See [android/README.md](android/README.md).
* **Business edition (desktop):** `cd corporate/desktop && npm install && npm start`
  (needs Node 22; downloads Electron). `cd corporate && npm run simulate` runs
  the whole pipeline headlessly without Electron. See [corporate/README.md](corporate/README.md).

## Continuous integration

`.github/workflows/ci.yml` runs the extension tests, the business edition's
core tests and headless simulation, builds the Windows app
and runs its tests on a Windows runner (uploading a single-file `.exe`), and
builds the Android APK and runs its unit tests (uploading the debug APK).

## Tests

```
cd chrome-extension && npm test                            # extension logic
cd windows && dotnet run --project ShorthandExpander.Tests # Windows logic + storage
cd android && ./gradlew testDebugUnitTest                  # Android logic + JSON
cd corporate && npm test                                   # business edition core
```

All four suites also run [`shared/conformance.json`](shared/conformance.json),
one table of matching, placeholder and validation cases. Because the same file
drives every platform, a rule change applied to only one of them fails on the
others. Add a case there before changing the rules.
