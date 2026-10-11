# Google Play submission – Shorthand Expander

Everything the Play Console asks for when the Android app is first published, with the
answers that match what the code actually does. Items marked **you** need the developer
account or a device and cannot be done from the repository.

## Store listing

**App name:** Shorthand Expander (30 characters max)

**Short description (80 characters max):**
Type a shorthand like cool/ in any app and it expands to your full text.

**Full description:**

Define a shorthand once, type it anywhere. When you type a trigger such as cool/ in any
app's text field (messages, email, notes, browsers), Shorthand Expander instantly replaces
it with the text you defined, for example "That is really cool, thanks for sharing!".

No custom keyboard is needed. You keep the keyboard you already use; the app watches for
your triggers through Android's accessibility service and does the replacement in place.

• Triggers fire the moment you finish typing them, at the start of a line or after a space
  or punctuation, so school/ never trips cool/.
• End triggers with a symbol such as / and they never get in the way of normal words.
• Press Backspace right after an expansion to get the trigger back.
• Placeholders: {date}, {time} and {datetime} insert the current date and time; {cursor}
  decides where the caret lands.
• Pause expansion with one switch without turning the service off.
• Import and export your list as a JSON file. The same file works with the actle browser
  extension (Chrome and Firefox) and the Windows app, so one list can follow you across
  devices.
• Password fields are always ignored.

Privacy: everything happens on your phone. The app has no network access, no analytics and
no accounts. The text you type is only checked for your triggers, as you type it, and is
never stored or sent anywhere. The accessibility service is used solely to see when a
trigger has been typed and to replace it. A few apps do not let accessibility services
edit their text fields (some terminals and games); expansion simply does nothing there.

**Category:** Productivity. **Tags:** text expander, shortcuts, snippets, autofill.

**Contact details (you):** e-mail address is required; website optional.

**Privacy policy URL (required, you):** publish `android/store/PRIVACY.md` at a public
address and paste it. The file on the default branch is public at
https://github.com/Platteration/autocompletele/blob/claude/shorthand-autofill-extension-yd5l0v/android/store/PRIVACY.md
and works, but a GitHub Pages or plain web address is tidier and survives a branch rename.

## Graphics

| Asset | Requirement | Status |
| --- | --- | --- |
| App icon | 512 × 512 PNG, 32-bit, no rounded corners (Play adds them) | `store/icon-512.png` |
| Feature graphic | 1024 × 500 PNG or JPEG | `store/feature-1024x500.png` |
| Phone screenshots | 2 to 8, 16:9 to 9:16, each side 320 to 3840 px | **you**: take them on a device or emulator (see below) |
| 7" and 10" tablet screenshots | optional for phones-only, needed if tablets are targeted | **you** |

Suggested screenshots: (1) the main screen with the service on and a few shorthands;
(2) the "Add shorthand" dialog with a placeholder expansion; (3) a messaging app just
after `cool/` expanded; (4) the accessibility disclosure dialog. The app has no
orientation lock, so take them in portrait.

## App content declarations (Policy → App content)

**Privacy policy:** the URL above.

**Ads:** no, the app contains no ads.

**App access:** all functionality is available without special access (no login).

**Content rating questionnaire:** Utility / Productivity. Answer "no" to every content
question; the result is "Everyone" / PEGI 3.

**Target audience:** 18 and over is the simplest answer. The app is not designed for
children and this avoids the Families policy.

**News app:** no. **COVID-19 app:** no. **Government app:** no.

**Data safety:**

* Does your app collect or share any of the required user data types? **No.**
  Rationale: Play's definition of "collection" is data transmitted off the device. The
  accessibility service processes typed text in memory on the device only; nothing is
  transmitted, logged or stored beyond the user's own shorthand list in app-private
  storage, which is user-entered configuration, not collected data.
* Is all user data encrypted in transit? Not applicable (no transmission). Choose "No data
  collected" and the question disappears.
* Do you provide a way for users to request deletion? Not applicable; uninstalling removes
  everything.

**Advertising ID:** no, the app does not use it.

**Financial features:** none.

**Health:** none.

### Accessibility API declaration (required)

The app declares `android:isAccessibilityTool="false"` because it is not designed to help
people with disabilities, so the Play Console will ask for an AccessibilityService API
declaration and the app must meet the prominent disclosure requirement. The in-app
disclosure is the dialog shown by "Turn on in Accessibility settings" before the user is
sent to the settings; it names the data (text typed in other apps' fields), the use
(finding and replacing triggers), says nothing is stored or sent, and needs an explicit
"Agree". Suggested declaration text:

> Core feature: text expansion. The app replaces short triggers the user has defined (for
> example "cool/") with longer text in the text fields of other apps, as the user types.
> The AccessibilityService API is the only Android mechanism that lets an app that is not
> a keyboard observe and edit the text of another app's editable field. The service
> subscribes to TYPE_VIEW_TEXT_CHANGED only, inspects the changed field's text on the
> device to check whether it ends with a user-defined trigger, and if so performs
> ACTION_SET_TEXT on that field. No text is stored, logged or transmitted. Password fields
> are ignored. The user is shown a disclosure in the app and must tap Agree before being
> sent to Accessibility settings. No alternative API (input method, autofill) can perform
> replacement in arbitrary apps while the user keeps their own keyboard.

Attach a short screen recording showing the disclosure dialog, the accessibility settings
toggle and an expansion in another app; Play reviewers ask for one.

## Technical requirements (done in the repository)

* Target API level 36 (Android 16), required for new apps since 31 August 2026;
  compileSdk 36, Android Gradle plugin 8.9.3.
* Release output is an Android App Bundle: `./gradlew bundleRelease` →
  `app/build/outputs/bundle/release/app-release.aab`. CI uploads it on every push.
* Signing: the release build type reads an upload key from `keystore.properties` or the
  environment (README, "Release build"). Enrol in Play App Signing at first upload and keep
  the upload key out of git (`.gitignore` covers `android/keystore.properties` and
  `android/*.jks`).
* Adaptive launcher icon (`mipmap-anydpi-v26`) with a monochrome layer for themed icons;
  legacy PNGs remain for Android 7.
* Edge-to-edge layout for Android 15 and 16: the toolbar and content are padded by the
  system bar insets.
* No permissions beyond BIND_ACCESSIBILITY_SERVICE on the service itself; no INTERNET.

## Release checklist

1. **you:** create the upload keystore once (README) and either put `keystore.properties`
   next to `build.gradle.kts` or add the four `ANDROID_*` secrets to the GitHub repository.
2. Bump `versionCode` (must increase on every upload) and `versionName` in
   `app/build.gradle.kts`.
3. Push; take `ShorthandExpander-android-release-bundle` from the CI run, or run
   `./gradlew bundleRelease` locally.
4. **you:** Play Console → Testing → Internal testing → upload the `.aab`, add yourself as a
   tester, install from the Play link and check: disclosure dialog → settings → service on;
   expansion in a messaging app; Backspace undo; import and export; dark mode; the toolbar
   sits below the status bar on an Android 15 or 16 device.
5. **you:** read the pre-launch report (crashes, accessibility, security warnings).
6. **you:** complete every App content declaration above, then promote to Production.

## Not done in the repository

* Screenshots and the review screen recording need a device.
* Nothing here was run on a device or emulator: this container cannot download the Android
  SDK, so the build and lint are verified by CI only. The visual result of the toolbar and
  inset changes must be checked on a device before release.
