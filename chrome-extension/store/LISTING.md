# Chrome Web Store and Firefox Add-ons submission

Use the copy below for the extension's store listings. Finish the account
declarations and release checks before submission.
Creating a ZIP does not publish or sign the extension.

## Listing copy

**Name:** actle

**Short description / summary:** Expand shortcuts into reusable text and fill-in templates in supported webpage fields.

**Category:** Productivity in Chrome; select the closest productivity category in Firefox.

**Language:** English

**Single purpose:** Save reusable text and fill-in templates, then insert them using short triggers in supported webpage text fields.

**Full description:**

With actle, turn phrases you type again and again into shortcuts you can remember. Create a
trigger such as `cool/`, give it an expansion, and type the trigger in a supported
webpage field to insert your saved text.

- Build and search a personal library of text snippets.
- Turn one script into a fill-in template with `[[name]]`, `[[company]]`, or
  other named blanks. Answer each blank, check the live preview, and confirm
  insertion. Repeated names share one answer; answers are not saved.
- Add `{date}`, `{time}`, and `{datetime}` placeholders, or use `{cursor}` to
  choose where typing continues after insertion.
- Type `;;` to search snippets from the field and select one to insert or fill
  in. Change the search trigger in settings or turn it off.
- Press Backspace immediately after an expansion to restore the trigger while
  the text and caret remain in place.
- Search snippets from the toolbar, fill in templates, and copy finished text
  to your clipboard.
- Pause expansion everywhere or on individual hostnames.
- Preview JSON imports, merge them with your library, and export a backup to
  transfer to another browser or the companion Windows and Android apps.

Keep saved scripts and their editor side by side, with clear previews, a blank
builder, and light and dark themes. Each template is one saved script with
details you fill in each time. For example, `Hi [[name]], thanks for asking
about [[topic]]!` asks for two answers before inserting your message. Cancel
without changing the field if you are not ready to insert.

The logo completes actle into autocompletele once when you open the library or
toolbar. Replay it by selecting the logo, with reduced-motion preferences
respected.

Fill-in templates work in the Chrome and Firefox extensions. Windows and
Android preserve their text during JSON transfer but do not show fill-in forms.

In Chrome, snippets and settings use browser extension sync storage and can
follow your Chrome profile when sync is enabled. In Firefox, they stay in your
local Firefox profile and do not automatically sync. Move your library between
browsers or devices using JSON export and import.

Text matching happens in your browser. The extension has no publisher-operated
data server, analytics, or advertising. Chrome's browser sync may transfer your
snippets and settings through Google's sync service.

Expansion works in supported text inputs, textareas, and rich-text fields.
Password fields are excluded. Browser-protected pages and some custom editors
do not support extensions or text expansion. File-page access, where supported,
depends on the browser's extension permissions.

## Permission and privacy answers

**Storage:** Saves snippet triggers, expansion text, ordering, and settings so
the library remains available between sessions. Chrome uses extension sync
storage and can sync when the user's browser profile permits it. Firefox uses
extension local storage without automatic synchronization.
Template answers are used temporarily to preview and fill the chosen script;
they are not saved to extension storage or included in library exports.

**Access to websites (`<all_urls>`):** Detects configured triggers and inserts
snippets in editable fields on the websites the user chooses to use. The popup
uses the active tab's hostname for the per-site expansion toggle. Restricting
browser-granted site access limits where expansion can run. An exclusion in the
extension's own settings pauses expansion but does not revoke that permission.

**Remote code:** All executable extension code is included in the package. The
extension does not load executable code from a remote service.

**Privacy policy:** Use the public URL in the publisher details below for
[PRIVACY.md](PRIVACY.md). Disclose Chrome
sync and local processing of editable field text consistently in the dashboards
and policy; do not describe Chrome data as necessarily staying on one device.

**Dashboard declarations:** Review the final package against each store's
current data definitions before certifying the privacy answers. The extension
does not send data to its publisher. Chrome stores snippet content and excluded
hostnames in browser sync. Firefox's manifest declares no data collection: that
package stores snippets and settings locally and does not transmit them to a
service. Template answers are processed in the browser without being saved to
the library. Clipboard copies and webpage insertion happen at the user's direction.

## Publisher details

| Field | Value |
| --- | --- |
| Publisher name | Platteration |
| Privacy/support contact | https://github.com/Platteration/autocompletele/issues |
| Public privacy-policy URL | https://raw.githubusercontent.com/Platteration/autocompletele/0282f7df7641dbf6f16aa0421b5f5ddaa8c5c55f/chrome-extension/store/PRIVACY.md |
| Support website | https://github.com/Platteration/autocompletele/issues |
| Firefox license selection | All rights reserved; this repository does not grant an open-source license |
| Developer accounts | Registered Chrome Web Store and Firefox Add-ons publisher accounts must be connected before submission |

Store credentials belong in the stores' account flows or secure environment
settings, never in this file. Store publication requires access to the owner's
registered developer accounts. The privacy-policy URL points to a fixed commit;
update store listings to a new policy URL if the extension's data practices change.

### First submission

1. Register in the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole/),
   complete Google's developer verification and any registration fee shown, and
   upload `dist/actle-chrome-1.0.0.zip` as a new item. Add the listing
   copy, privacy-policy URL, permission explanations, icon, screenshots, and
   promotional image from this directory, then complete the dashboard's
   declarations and submit for review.
2. Sign in to the [Firefox Add-ons developer hub](https://addons.mozilla.org/developers/),
   register the developer account, and submit
   `dist/actle-firefox-1.0.0.zip` for distribution on Firefox Add-ons.
   Add the Firefox screenshot, listing copy, privacy policy, and reviewer
   walkthrough. Select All rights reserved and complete the declarations.
   The package contains readable, unminified JavaScript and no downloaded
   executable code. Mozilla signs the add-on as part of its submission process.
3. Record each store's item URL and version after submission. Submission is
   distinct from approval and public availability; follow each dashboard's
   review status before announcing the extension as available in that store.

## Screenshots and artwork

The [animated logo preview](images/actle-autocomplete.gif) demonstrates the app identity; use the static PNG assets below for store uploads.

Prepared assets:

| Asset | File |
| --- | --- |
| Chrome library manager, 1280×800 | [chrome-library-1280x800.png](images/chrome-library-1280x800.png) |
| Chrome library manager, dark theme, 1280×800 | [chrome-library-dark-1280x800.png](images/chrome-library-dark-1280x800.png) |
| Chrome picker on a local demo page, 1280×800 | [chrome-picker-1280x800.png](images/chrome-picker-1280x800.png) |
| Chrome fill-in template form, 1280×800 | [chrome-template-1280x800.png](images/chrome-template-1280x800.png) |
| Firefox library manager, 1280×800 | [firefox-library-1280x800.png](images/firefox-library-1280x800.png) |
| Firefox library manager, dark theme, 1280×800 | [firefox-library-dark-1280x800.png](images/firefox-library-dark-1280x800.png) |
| Firefox fill-in template form, 1280×800 | [firefox-template-1280x800.png](images/firefox-template-1280x800.png) |
| Small promotional image, 440×280 | [promo-440x280.png](images/promo-440x280.png) |

The Chrome screenshots show the actual running extension in Chromium; the demo
page uses fictional text. Refresh these assets with `npm run build` followed by
`node scripts/store-assets.js` from `chrome-extension/`, after installing the
development dependencies and Chromium. The script renders the promotional tile
using the actle icon and creates a fresh temporary profile for UI captures.
Library captures wait until the logo animation finishes. The demo page and
promotional tile show a static `actle → autocompletele` completion motif.
Refresh the Firefox images with `node scripts/store-assets-firefox.js` and the
Firefox driver environment described in the extension README.

Capture the actual extension using synthetic snippets such as `thanks/` →
`Thanks for your help!` and `followup/` → `I will follow up on {date}.` Avoid
personal data, browser profile details, unrelated tabs, or another site's brand.

- Chrome: at least one 1280×800 or 640×400 screenshot and a 440×280 small
  promotional image. Use the included `icons/icon128.png` as the store icon.
- Firefox: use screenshots captured with the Firefox package and the included
  icon. Confirm current image requirements in the submission dashboard.
- Useful screenshots: the library manager with a few snippets, the in-field
  picker filtering a snippet, the fill-in form with its live preview, and the
  toolbar search/copy palette.
- Promotional copy can read **actle → autocompletele** and **Your repeated text,
  one shortcut away.** Use the actle icon and actual UI where shown.

## Reviewer walkthrough

No extension account or login is needed. Chrome-profile sync is optional;
Firefox stores the library locally.

1. Install the package and open its options page. Create `thanks/` with expansion
   `Thanks for your help!` and `next/` with expansion `Next step: {cursor} — {date}`.
   Check the logo's single completion animation and replay control. With the
   system's reduced-motion preference enabled, the logo should remain static.
2. In **Try it**, type `thanks/`. Confirm insertion, then immediately press
   Backspace to restore the trigger. Type `next/` and check the date and caret.
3. Type `;;`, search for `thanks`, select the result with the arrow keys, and
   press Enter. Repeat and press Escape to dismiss the picker.
4. Open the toolbar popup, search for `thanks`, and copy it. Paste into a test
   field to verify the result.
5. Create `hello/` with expansion `Hi [[name]], thanks for asking about [[topic]].
   Thanks again, [[name]]!`, using **Insert blank** in the editor to add the
   named blanks. Check the script preview. Type `hello/` in **Try it**: the fill-in
   form should ask for only `name` and `topic`. Submit with a blank answer to
   check that it is required, then enter fictional answers and check the live
   preview. Choose **Insert text** and confirm both occurrences of `name`
   use the same answer. Immediately press Backspace to restore `hello/`.
6. Open that template again and press Escape; confirm the trigger remains.
   Select it through `;;` and confirm the same form opens. Select **Fill in**
   from the toolbar, complete the form, choose **Copy text**, and paste the
   result into a test field. Reopen the form and confirm answers start empty.
   Enter `{date}`, `{cursor}`, or `[[other]]` as an answer and confirm it is
   inserted literally. In the saved script, `[[ name ]]` shares the `name`
   answer, `[[Name]]` requests a separate answer, and `\[[name]]` inserts
   literal `[[name]]` without a prompt.
7. Test on a normal webpage containing a text input, textarea, and rich editor.
   The repository includes a fixture: from `chrome-extension/`, run
   `python3 -m http.server 4173 --bind 127.0.0.1 --directory e2e/fixtures` and open
   `http://127.0.0.1:4173/page.html`. Verify expansion in all three editable types
   and no expansion in the password or opted-out fields.
8. Pause expansion globally and confirm triggers stay unchanged. Re-enable it,
   disable expansion for the fixture hostname in the popup, and confirm the
   same result. Re-enable the site afterward.
9. Export JSON. Confirm the template's saved expansion still contains its
   `[[name]]` blanks and none of the answers from the form. Import that file
   and confirm the preview shows unchanged snippets. Add one synthetic snippet
   to a copy of the file, import with
   **Merge safely**, and check that the new entry appears while existing entries
   remain. Exercise **Replace everything** only with a disposable test library.
10. Reload the browser and verify saved snippets and settings remain available.

## Release checklist

- [x] Run the documented syntax, unit, packaging, and browser checks in
  [README.md](../README.md); inspect their actual results.
- [ ] Test the exact Chrome and Firefox release packages using the walkthrough.
- [x] Confirm no personal data, credentials, development tools, or test fixtures
  are included in the upload archives.
- [x] Complete publisher/contact/license fields and publish the privacy policy.
- [x] Add actual browser screenshots and the required Chrome promotional image.
- [ ] Complete privacy, permission, source/build, and account declarations in
  each store using the final package's behavior.
- [ ] Check the chosen version is acceptable for the existing listing, if any.
- [ ] Submit through the owner's accounts after final review; retain the
  package version and digest for comparison with the reviewed release.

References: [Chrome preparation](https://developer.chrome.com/docs/webstore/prepare),
[Chrome images](https://developer.chrome.com/docs/webstore/images),
[Chrome privacy guidance](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
[Firefox submission](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[Firefox data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
