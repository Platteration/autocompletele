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

### Release build

Google Play takes an Android App Bundle signed with an upload key. Create the key once
and keep it out of git (`.gitignore` already excludes it):

```
keytool -genkeypair -v -keystore upload-key.jks -alias upload \
        -keyalg RSA -keysize 2048 -validity 10000
```

Then either write `android/keystore.properties`:

```
KEYSTORE_FILE=upload-key.jks
KEYSTORE_PASSWORD=...
KEY_ALIAS=upload
KEY_PASSWORD=...
```

or export the same four names as environment variables. `./gradlew bundleRelease` then
writes a signed `app/build/outputs/bundle/release/app-release.aab`. Without a key the
bundle is still built, unsigned, so CI can check the release configuration. CI signs it
when the repository secrets `ANDROID_KEYSTORE_BASE64` (the `.jks` as base64),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` exist.

Bump `versionCode` in `app/build.gradle.kts` before every upload. The listing copy, the
Play Console declarations (data safety, accessibility API) and the release checklist are
in [`store/LISTING.md`](store/LISTING.md); the privacy policy the listing links to is
[`store/PRIVACY.md`](store/PRIVACY.md).

## Use

1. Open **Shorthand Expander** and tap **Turn on in Accessibility settings**.
   A dialog explains what the service reads and why; tap **Agree**, then find
   *Shorthand Expander* in the list, enable it and confirm the prompt.
2. Back in the app, add your shorthands with **Add shorthand**. Tap one to
   edit or delete it.
3. Type a trigger in any other app. It is replaced as soon as you type its
   last character. Press Backspace right after an expansion to put the
   trigger back.

On Android 13 and newer, an app installed from an APK (rather than an app
store) is blocked from the accessibility toggle with a "Restricted setting"
message. To allow it: open **Settings → Apps → Shorthand Expander**, tap the
**⋮** menu in the top-right corner, choose **Allow restricted settings**, then
try the accessibility toggle again.

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
  requires Android 7.0 (API 24) or newer and targets Android 16 (API 36).
* The service is declared with `isAccessibilityTool="false"`, so Google Play
  requires the in-app disclosure dialog and an AccessibilityService API
  declaration in the Play Console; `store/LISTING.md` has the text for it.

## Project layout

| File                                   | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `ShorthandAccessibilityService.kt`     | Watches text changes and performs the replacement    |
| `MainActivity.kt`                      | Manage shorthands, toggle, import/export, open settings |
| `Expander.kt`                          | Pure matching / placeholder logic (same rules as the extension) |
| `ShorthandJson.kt`                     | Shared JSON file format                              |
| `ShorthandStore.kt`                    | Persistence in SharedPreferences                     |
| `res/xml/accessibility_service_config.xml` | Service declaration (text-changed events only)   |
| `store/`                               | Play listing copy, declarations, privacy policy, icon and feature graphic |
| `src/test/.../ExpanderTest.kt`         | JUnit tests                                          |
