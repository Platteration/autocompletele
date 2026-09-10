# Shorthand Autofill

Define shorthands once, type them anywhere. When you type a trigger such as
`cool/`, it is instantly replaced by whatever you defined for it, for example
*"That is really cool, thanks for sharing!"*.

Three apps share the same idea and the same JSON file format, so a list
built on one device can be exported and imported on the others:

| Folder              | Platform | How it works                                                     |
| ------------------- | -------- | ---------------------------------------------------------------- |
| `chrome-extension/` | Chrome   | Manifest V3 extension; watches inputs, textareas and rich editors |
| `windows/`          | Windows  | .NET 8 tray app with a global keyboard hook; works in every program |
| `android/`          | Android  | Accessibility service; works in other apps' text fields          |
| `shared/`           | –        | Format specification and an example `shorthands.json`            |

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

## Quick start

* **Chrome:** `chrome://extensions` → Developer mode → *Load unpacked* →
  pick `chrome-extension/`. See [chrome-extension/README.md](chrome-extension/README.md).
* **Windows:** `cd windows && dotnet run --project ShorthandExpander`
  (needs the .NET 8 SDK). See [windows/README.md](windows/README.md).
* **Android:** open `android/` in Android Studio, run on your phone, then
  enable the service under *Accessibility*. See [android/README.md](android/README.md).

## Continuous integration

`.github/workflows/ci.yml` runs the extension tests, builds the Windows app
and runs its tests on a Windows runner (uploading a single-file `.exe`), and
builds the Android APK and runs its unit tests (uploading the debug APK).

## Tests

```
cd chrome-extension && npm test                            # extension logic
cd windows && dotnet run --project ShorthandExpander.Tests # Windows logic + storage
cd android && ./gradlew testDebugUnitTest                  # Android logic + JSON
```

All three suites also run [`shared/conformance.json`](shared/conformance.json),
one table of matching, placeholder and validation cases. Because the same file
drives every platform, a rule change applied to only one of them fails on the
other two. Add a case there before changing the rules.
