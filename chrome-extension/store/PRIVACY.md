# actle privacy policy

**Publisher:** Platteration

**Privacy contact:** https://github.com/Platteration/autocompletele/issues

**Effective date:** October 12, 2026

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
locally. They do not learn from your typing history or request suggestions from
a remote service. Suggestions are enabled by default and can be turned off.

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

The extension has no publisher-operated data server, analytics, or advertising.
It does not send your snippets, typed field text, or browsing activity to the
publisher. The publisher does not sell extension data or use it for advertising.

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
answers you supplied to a fill-in template.

## Your controls

You can edit or delete snippets, export your library, change settings, pause
expansion globally, and exclude individual hostnames. A hostname exclusion
pauses expansion there; it does not remove the browser's site-access permission.
Use your browser's extension settings to change site permissions or uninstall
the extension, and Chrome's sync settings to control Chrome synchronization.

Deleting a snippet removes it from the extension's active storage. In Chrome,
propagation to other devices and retention by the sync service are controlled
by the browser provider. Deletion does not remove JSON files you exported or
copies you placed in webpages or on the clipboard.

## Contact and changes

For privacy questions, contact the privacy contact listed above. This policy
will be updated if the extension's data practices change.
