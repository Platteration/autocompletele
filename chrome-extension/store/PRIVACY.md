# actle privacy policy

**Publisher:** Platteration

**Privacy contact:** https://github.com/Platteration/autocompletele/issues

**Effective date:** October 20, 2026

This policy covers the actle browser extension. The contact page is
public; do not include snippets, credentials, or other private information when
opening an issue.

## Text and settings the extension uses

actle reads text in supported editable webpage fields to find your
configured triggers and insert their expansions. This processing happens in your
browser. The extension does not record a history of the text you type and does
not expand triggers in password input fields. It also skips fields identified
as usernames, sign-in codes, or payment details using field types, autocomplete
attributes, labels, and related form metadata. A page that does not identify
these fields may not be recognized; you can exclude its hostname.

Optional suggestions match the prefix you type against your saved shortcuts
locally, and compare the words you type with the openings of your saved
snippets to offer finishing one. They do not learn from your typing history or
request suggestions from a remote service. Suggestions are enabled by default
and can be turned off; paragraph completion can also be turned off on its own.

The extension's **Writing pad** page saves what you write there as drafts. Its
optional writing suggestions are computed in your browser from your pad
drafts only, never from text you type on websites. While they are turned off,
the pad does not analyze your drafts for ideas; your shortcuts, the
suggestion list and paragraph completion still work in the pad, as on any
page, and follow their own settings. Drafts are stored as described below.

The extension saves the triggers and expansion text you create, their ordering,
and your settings. Settings include whether expansion is enabled, the search
overlay trigger, suggestions, text animation, and the hostnames you exclude. When you open the toolbar popup,
the extension reads the active tab's URL to identify its hostname for the site
toggle. It does not keep a browsing-history log.

Fill-in templates ask you for temporary answers to named blanks. The extension
processes these answers in your browser to preview and fill the script. It does
not save them to extension storage, synchronize them as library content, or
include them in library exports. The saved script retains its blanks. Confirming
**Insert text** places the completed text in the webpage; **Copy text** places
it on your clipboard. Cancelling the form does neither.

## Storage and browser synchronization

In Chrome, snippets and settings use the browser's extension `storage.sync`
service. When sync is enabled for your Chrome profile, Chrome may transfer this
data through its sync service to your other signed-in Chrome instances. Google's
policies and your browser settings govern this service. Chrome data is therefore
not necessarily confined to one device.

In Firefox, snippets and settings use extension `storage.local` and remain in
that Firefox profile. The extension does not transmit them to a sync service.
Moving your library between browsers or devices requires JSON export and import.

In both browsers, daily autocomplete usage and license data use extension
`storage.local`. They do not sync through Chrome or appear in snippet exports.
Accounting saves the most recent local calendar day, its insertion count, and
any unfinished insertion receipts. These random receipts are associated with
browser tab/frame identifiers and, where available, a document identifier;
completed receipts are removed. Old daily accounting is replaced when the next
day's usage is saved. No field text, snippet content, template answers, webpage
URLs, or payment details are included in these accounting messages or records.

The extension also keeps cumulative per-snippet use counts in
`storage.local`, keyed by snippet identifier with no text or timestamps, only
to order suggestions and search results. They do not sync, are not exported,
and are separate from the daily allowance above. If you choose **Save
selection as actle shorthand** from the right-click menu, the selected text
is held in `storage.local` as a one-time draft until the library page shows
it in the editor; it becomes a saved snippet, with the storage and sync
behavior above, only if you give it a trigger and save it.

In both browsers, Writing pad drafts (their title, text, and when they were
created and last edited), copies of up to 20 recently deleted drafts with the
time each was deleted, the pad's preferences (whether writing suggestions are
on, and which draft was open last), and up to 200 phrases you chose not to have
suggested again use extension `storage.local` on this device. So does the text
of a pad tab that closes before its last save finishes, until the pad next
opens and stores it as a draft. They do not sync, are not included in snippet
exports, and are never sent anywhere. The extension's own scripts that run in
the pages you open can read extension `storage.local` and are notified when it
changes, so a draft's text can reach them inside your browser as it saves;
websites cannot read it. If you choose **Make shortcut** or **Save as
template** on a writing suggestion, that phrase, or the draft's text with the
blanks you chose, becomes a saved snippet in your library, with the storage
and sync behavior above; the suggestion says so beside its button.

When you delete a snippet, the extension keeps a copy of it on this device
under **Recently deleted** so that you can restore it: its trigger, expansion
text, position in your list, and the time you deleted it. In both browsers
these copies use `storage.local`. They do not sync, are not exported, and are
never sent anywhere. Up to 50 are kept; deleting another snippet removes the
oldest copy. **Delete for good** removes one copy, and **Empty Recently
deleted** removes them all.

If you activate a Forever license, the extension saves its signed token in
this browser profile and verifies it locally. A token contains a license
identifier, issue time, product, and plan. Activation does not ask for your
name or email address; the issuer uses an opaque license identifier.
Removing the license from **Plans & support** deletes that saved token while
preserving daily usage. There is no activation server or remote license check.

The extension has no publisher-operated data server, analytics, or advertising.
It does not send your snippets, typed field text, or browsing activity to the
publisher. The publisher does not sell extension data or use it for advertising.

## Purchases

Purchasing is unavailable in this release, which is an unlimited free preview.
No payment provider, checkout address, or production verification key is
configured, and the extension does not collect payments.

The prepared checkout action opens a configured HTTPS page in a new browser
tab only when you choose it. It does not append your snippets, usage, or license
token to that address. Before enabling purchases, the publisher must identify
the payment provider and its privacy terms. Information you submit on that
external checkout page will be governed by that provider's and the publisher's
published purchase terms; the extension itself does not process payment details.

## Webpages, clipboard, and files

When you insert a snippet into a webpage, the site can access that text just as
it can access text you enter yourself. That site's own data practices apply.

Choosing a snippet's copy action writes its expansion to your clipboard. The
extension does not read the clipboard in the background; when you paste into a
supported field, it uses the pasted text supplied by the browser's paste event
to verify that the edit came from you. Export creates a JSON file containing
your snippets; the extension does not encrypt that file. Import reads the JSON
file you select to preview and import its snippets. Exported files may contain
information you saved in your snippets. Text you copy or insert may also contain
answers you supplied to a fill-in template. In the Writing pad, **Copy text**
writes the open draft's text to your clipboard, and **Download .txt** creates
an unencrypted text file with its title and text.

## Your controls

You can edit or delete snippets, restore or permanently remove recently deleted
ones, export your library, change settings, pause expansion globally, and
exclude individual hostnames. A hostname exclusion
pauses expansion there; it does not remove the browser's site-access permission.
Use your browser's extension settings to change site permissions or uninstall
the extension, and Chrome's sync settings to control Chrome synchronization.

Deleting a snippet removes it from your library; its local copy in **Recently
deleted**, described above, stays until you restore it, delete it for good,
empty Recently deleted, or 50 newer deletions replace it. In Chrome,
propagation to other devices and retention by the sync service are controlled
by the browser provider. Deletion does not remove JSON files you exported or
copies you placed in webpages or on the clipboard.

Deleting a Writing pad draft works the same way with **Recently deleted
drafts**, which keeps the 20 most recent. When that copy cannot be kept, for
example because storage is full, the pad asks before deleting the draft
without a copy and downloads it as a text file first. **Clear**, under the
pad's Suggestions panel, removes the phrases you chose not to have suggested
again. Removing the extension deletes its local storage, drafts included; it
does not remove text files you downloaded.

## Contact and changes

For privacy questions, contact the privacy contact listed above. This policy
will be updated if the extension's data practices change.
