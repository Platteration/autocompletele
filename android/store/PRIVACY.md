# Privacy policy – Shorthand Expander (Android)

Last updated: 11 October 2026

Shorthand Expander is an Android app that replaces short triggers you type (for example
`cool/`) with longer text you defined, in the text fields of other apps. This policy
describes what the app does with data. The short version: nothing leaves your device.

## Data the app collects

**None.** The app has no analytics, no crash reporting, no advertising, no accounts and no
network access. It does not collect, transmit or share any personal data with the developer
or with anyone else.

## How the accessibility service is used

To notice when you have typed a trigger, the app runs an Android **accessibility service**.
Android tells that service when the text of an editable field changes. The service then:

* reads the text of that field and checks whether the text before the cursor ends with one
  of your triggers;
* if it does, replaces the trigger with your expansion in the same field;
* otherwise does nothing.

The text is examined in memory, on the device, at the moment you type it. It is **not**
stored, logged, kept after the check, or sent anywhere. Password fields are ignored
entirely. The service does not read screen content other than the text field that changed,
and it does not run when the "Expansion enabled" switch is off.

Android shows a warning when you enable any accessibility service because such services
can read what is on the screen. That warning is generic; the app's own behaviour is limited
to what is described above.

## Data stored on your device

* **Your shorthands** (triggers and expansions) and the on/off setting are stored in the
  app's private storage on your device. Other apps cannot read them.
* If you have Android **device backup** turned on, Android may include this private storage
  in your encrypted device backup (for example to your Google account), as it does for other
  apps. This is handled by Android under your backup settings, not by the app.
* **Import and export** read or write a JSON file only when you choose one through the
  system file picker. The app has no access to other files.

## Third parties

No third-party services, SDKs or libraries are included. The app is built from the Android
framework alone.

## Children

The app does not knowingly collect any data from anyone, including children.

## Changes

If this policy changes, the new version will be published at the same address as this one
and the "last updated" date will change.

## Contact

Questions about this policy can be sent to the developer through the contact address shown
on the app's Google Play listing, or by opening an issue at
https://github.com/Platteration/autocompletele/issues.
