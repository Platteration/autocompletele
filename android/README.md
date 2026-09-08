# Shorthand Expander – Android

An Android app that expands shorthands such as `cool/` into full text in
other apps' text fields (messaging, email, notes, browsers) as you type.

It is implemented as an **accessibility service**: the service is told when
the text of an editable field changes, checks whether the text before the
caret ends with one of your triggers, and if so rewrites the field with the
expansion. No custom keyboard is needed, so you keep using the keyboard you
already have.

## Build

Open the `android` folder in Android Studio (Ladybug or newer), or from the
command line with the Android SDK installed:

```
cd android
./gradlew assembleDebug        # APK in app/build/outputs/apk/debug/
./gradlew testDebugUnitTest    # runs the matching-logic tests
```

Install the APK on your phone (`adb install app/build/outputs/apk/debug/app-debug.apk`
or copy it over and open it).

## Use

1. Open **Shorthand Expander** and tap **Turn on in Accessibility settings**.
   Find *Shorthand Expander* in the list, enable it and confirm the prompt.
2. Back in the app, add your shorthands with **Add shorthand**. Tap one to
   edit or delete it.
3. Type a trigger in any other app. It is replaced as soon as you type its
   last character.

The **Expansion enabled** switch pauses expansion without turning the
service off. The overflow menu offers **Import JSON** and **Export JSON**,
using the same file format as the Chrome extension and the Windows app
(see `../shared/SPEC.md`). Placeholders `{date}`, `{time}`, `{datetime}` and
`{cursor}` are supported.

## Notes and limitations

* The service only reads text to look for your triggers; nothing is stored or
  sent anywhere. Android will still show the usual accessibility warning
  when you enable it, which is expected for this kind of app.
* A few apps do not expose their text fields to accessibility services, or
  reject text set by them (some terminal apps, some games, and password
  fields, which are deliberately ignored). Expansion simply does nothing
  there.
* The app uses only framework widgets (no AndroidX) to keep it small; it
  requires Android 7.0 (API 24) or newer.
* If you publish this on Google Play you will need to justify the use of
  the accessibility API in the Play Console declaration.

## Project layout

| File                                   | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `ShorthandAccessibilityService.kt`     | Watches text changes and performs the replacement    |
| `MainActivity.kt`                      | Manage shorthands, toggle, import/export, open settings |
| `Expander.kt`                          | Pure matching / placeholder logic (same rules as the extension) |
| `ShorthandJson.kt`                     | Shared JSON file format                              |
| `ShorthandStore.kt`                    | Persistence in SharedPreferences                     |
| `res/xml/accessibility_service_config.xml` | Service declaration (text-changed events only)   |
| `src/test/.../ExpanderTest.kt`         | JUnit tests                                          |
