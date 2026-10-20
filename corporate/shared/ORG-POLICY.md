# Organisation policy format (business edition)

One JSON file that an administrator distributes to every desk. The desktop
app reads it from `policy.json` in its data folder (or from the path given by
the `ACTLE_POLICY` environment variable) and re-reads it on start. Everything
in it is optional; an empty object is a valid policy. Invalid entries are
skipped with a warning shown on the dashboard, never a refusal.

`org-policy.example.json` in this folder is a complete example.

| Field | Meaning |
| ----- | ------- |
| `version` | `1`. A newer number is accepted with a warning; unknown fields are ignored. |
| `serial` | Positive integer, required for a signed policy. Raise it every time the policy changes; desks refuse a signed policy whose serial is lower than the one they already accepted for that source, or the same serial with different content. |
| `layer` | Required for a signed policy: the name of the layer it is for, matching the `layer` of the deployment source it is published at. A desk refuses a policy signed for another layer, so an old organisation policy cannot be replayed at a team's location. |
| `licence` | The business licence token issued by the vendor (`actle-admin license issue`): organisation, tier, seats, expiry. The desk verifies it offline; see "Licensing" below. Later layers override earlier ones. |
| `licensing.allowTierOverride` | `true` lets a person try a lower tier on the Policy tab while licensing is enforced (default `false`); never a higher one. See "Trying another tier". |
| `paused` | Kill switch. `true` or `{ "message": "…" }` pauses every desk that receives the policy: nothing is expanded, offered or learned, and the dashboard and tray offer no way to resume it. Nothing is deleted. Remove it (or set `{ "active": false }`) to resume. It is an administrative control, not a security boundary: `deployment.json` lives in the person's own data folder, so someone who edits that file can leave central management. |
| `organization` | Name shown on the dashboard. |
| `typing.charsPerMinute` | Typing-speed assumption behind "time saved" (default 200, which is 40 words per minute). Changing it re-estimates history. |
| `typing.secondsPerAttachment` | Time credited for each document attached through a shortcut (default 20). |
| `capture.defaultMode` | `off`, `triggers` (default) or `learn` for applications no rule names. |
| `capture.apps[]` | Per-application rules, first match wins. `match.process` (one name or a list; `.exe` and paths are ignored), `match.bundleId` (macOS) and `match.title` (regular expression, case-insensitive) identify the window. `mode` is as above. |
| `library` | The shared shortcut library in the personal `shorthands.json` format (`shared/SPEC.md` at the repository root). A person's own shortcut with the same trigger wins. |
| `keywordRules[]` | `keywords` (list), `match` (`any` default, or `all`), `caseSensitive` (default false) and `insert`: `{ "kind": "text", "text": ... }`, `{ "kind": "shorthand", "trigger": ... }` (must exist in `library`) or `{ "kind": "document", "shortcut": ... }` (must exist in `documents`). Each rule fires once per field. |
| `keywordRules[].action` | `offer` (default) shows the insert. `warn` shows `message` (required) and offers `insert` as an optional fix: a compliance warning. |
| `keywordRules[].detect` | Built-in detectors that must also fire; a rule may have `detect` instead of `keywords`. `card-number`: a card number passing the Luhn check. `iban`: an IBAN (compact or in groups of four) passing the mod-97 check. `uk-ni`: a UK National Insurance number with a valid prefix and suffix. `us-ssn`: a US Social Security number written as 123-45-6789 outside the never-issued ranges. `se-personnummer`: a Swedish personnummer with a valid date and Luhn digit. `nl-bsn`: a Dutch BSN passing the 11-proof. `external-email-domain`: an e-mail address whose domain is not in `params.allowedDomains` or under one of them. `missing-attachment`: nothing has been attached through a document shortcut in this field (pair it with keywords such as "attached"; attachments made by hand are not seen). |
| `keywordRules[].params` | Detector parameters. `allowedDomains` (list) is required by `external-email-domain`; a rule without it is skipped with a warning. |
| `keywordRules[].apps` | Restrict a rule to these applications (process names, as in capture rules, for example `["outlook.exe", "thunderbird"]`). A rule with `apps` stays quiet when the application is unknown. |
| `keywordRules[].unless` | Phrases that stop the rule when any of them appears in the field (case and spacing ignored), for example the disclaimer itself. What is seen is the text typed in the field, or inserted by actle, since the field last got the focus, up to the last 4,000 characters. Opening actle's search palette or dashboard counts as leaving the field. A mail client's automatic signature, pasted text and text further back are not seen, so the warning can appear although the phrase is there. |
| `documents.shortcuts[]` | `trigger` (for example `/sld`), `label`, and `documents[]` with `title`, `path` (file path or URL), optional `tags` and `description`. Triggers follow the same boundary rule as text shortcuts and lose to a text shortcut with the same trigger. Attach puts the files into the message being written (Outlook through COM, Thunderbird's compose window, otherwise pasted as files); an attachment is counted only when that worked. |
| `lookups[]` | Data-backed shortcuts: `trigger` (one word, for example `/cust`), `label`, `source` (`kind` `csv` or `json`; `path` on a share or an `https://` `url`; `key`, the column to match; `refreshMinutes`, 5 to 1440, default 60) and `template` with `[[field]]` blanks named after columns. See "Lookups" below. |
| `collections[]` | Named bundles shared with groups of desks: `id` (lower-case letters, digits and dashes), `label`, `audience` and the same `library`, `keywordRules`, `documents` and `lookups` fields as the top level. See "Sharing with groups" below. |
| `collections[].audience` | Group names (lower-case letters, digits and dashes) the collection is shared with; absent or empty means every desk. A desk's groups are set by IT in its `deployment.json`. |
| `learning.minCount` | Distinct messages a text must recur in before it is proposed (default 3, minimum 2). |
| `learning.minLength`, `learning.minWords` | Smallest text worth proposing (defaults 20 characters, 4 words). |
| `reporting.team` | Team name written into each desk's usage report. |
| `reporting.hourlyRate`, `reporting.currency` | Used to turn hours saved into an estimated value in the roll-up. |
| `reporting.period`, `reporting.periods` | Buckets in a usage report: `day`, `week` (default) or `month`, and how many (default 12). |
| `reporting.includeApps` | `true` adds per-application totals to usage reports (default `false`). |
| `reporting.endpoint` | `https://` address that collects usage reports. Absent: nothing is ever sent. Plain `http://` is refused with a warning. |
| `reporting.uploadEvery` | `day` or `week` (default): how often a desk sends its report once the endpoint is set. |
| `updates.url` | `https://` folder that holds the installers and the `latest*.yml` files electron-builder writes. Absent: the desk never checks for updates. Plain `http://` is refused with a warning. |
| `updates.channel` | Lower-case name, default `latest`: the desk reads `<channel>.yml` (`<channel>-mac.yml`, `<channel>-linux.yml`) from `updates.url`. |
| `reporting.uploadToken` | Optional shared secret. The body is signed with HMAC-SHA256 (`X-Actle-Signature: sha256=…`) so the collector can drop posts from anyone who merely knows the URL. |
| `retention.metricsDays` | Days of statistics kept on disk (default 365). |
| `retention.corpusDays` | Days of learning text kept on disk (default 90). Answers remembered per email conversation are kept for 90 days or this, whichever is shorter. |
| `threadMemory.enabled` | `false` stops desks remembering template answers per email conversation (default `true`; see "Capture modes"). What a desk already remembered stays until it expires or the person deletes it. |

## Central distribution (signed policies)

On a managed desk, IT installs `deployment.json` in the app's data folder:

```json
{
  "policySources": [
    { "layer": "organisation", "label": "Organisation", "url": "https://intranet.example/actle/org.signed.json" },
    { "layer": "shipping", "label": "Shipping team", "path": "S:/IT/actle/shipping.signed.json" }
  ],
  "publicKeys": ["-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"],
  "groups": ["shipping"],
  "refreshMinutes": 60
}
```

* Sources are layers, most general first. Later layers win field by field;
  shortcuts merge by trigger, keyword rules by `id`, document sets and
  lookups by trigger, collections by `id` (a later layer replaces the whole
  collection), and a later layer's capture rules are tried before an earlier
  one's. A pause in any layer pauses the desk.
* `groups` names the groups this desk belongs to; they decide which
  collections it receives (see "Sharing with groups"). They are read whenever
  the file exists, with or without policy sources.
* Every source names its `layer` and must be signed with a key listed in
  `publicKeys`, for that layer. Only `https://` URLs and file paths are
  accepted; plain `http://` sources are refused, and so is an https source
  that redirects to plain http.
* The desk fetches at start and every `refreshMinutes` (5 to 1440, default
  60). A source that cannot be fetched, fails its signature or carries an
  older serial keeps its last good copy, with a warning on the dashboard. A
  source with no good copy yet is left out; the other layers still apply.
* On a managed desk, a local unsigned `policy.json` is ignored.
* Policy changes, failing or recovering sources, and changes to the person's
  own capture rules are written to `audit.jsonl` in the data folder and shown
  on the dashboard's Policy tab. Typed text is never written there.

Sign with the admin tool (no dependencies):

```
cd corporate
node admin/actle-admin.js keygen ./keys          # once; keep policy-signing.key private
node admin/actle-admin.js validate org.json
node admin/actle-admin.js layers org.json shipping.json
node admin/actle-admin.js sign org.json --key keys/policy-signing.key --layer organisation --serial 2 --out org.signed.json
node admin/actle-admin.js verify org.signed.json --pub keys/policy-signing.pub
```

`sign` refuses a policy that has warnings unless `--allow-warnings` is
given, warns when `--deployment <file>` is passed and the signing key or the
layer is not in that deployment, and `keygen` refuses to overwrite an
existing key. `deployment` writes a validated `deployment.json`:

```
node admin/actle-admin.js deployment --pub keys/policy-signing.pub \
  --source layer=organisation,label=Organisation,url=https://intranet.example/actle/org.signed.json \
  --source layer=shipping,label="Shipping team",path=S:/IT/actle/shipping.signed.json \
  --refresh 60 --out deployment.json
```

### Rotating the signing key

Desks accept a policy signed by any key in their `deployment.json`, and a
policy re-signed with a new key replaces the cached copy even when its
content is unchanged. So a rotation is: both keys pinned for a while, then
only the new one.

1. `node admin/actle-admin.js rotate --old keys --new keys-2027 --deployment deployment.json --layer org.json --layer shipping.json --out-dir signed/`
   creates the new keypair (it refuses to overwrite one), rewrites
   `deployment.json` with both public keys, and re-signs every layer with
   the new key, keeping each layer's serial and layer name.
2. Roll out the two-key `deployment.json` to every desk.
3. Publish the re-signed layers from `signed/` at their usual locations.
4. Wait at least `refreshMinutes` plus the longest time a desk may be
   offline, so every desk has fetched a copy signed by the new key.
5. `node admin/actle-admin.js deployment --pub keys-2027/policy-signing.pub …`
   with the new key only, and roll it out.
6. Delete the old private key. From then on, sign with `keys-2027`.

A desk that missed step 3 before step 5 keeps its old-key copy, which no
longer verifies: it shows the source as failed, applies the other layers,
and recovers at its next successful fetch.

## Sharing with groups (collections)

Not everything belongs on every desk: engineering may need the shipping
desk's contact details but not the whole shipping catalogue. A policy can
bundle content into **collections**, each shared with an audience of
groups, and IT names each desk's groups in its `deployment.json`:

```json
"collections": [
  { "id": "shipping-catalogue", "label": "Shipping catalogue", "audience": ["shipping"],
    "library": [{ "trigger": "eta/", "expansion": "Estimated arrival is [[date]]." }],
    "documents": { "shortcuts": [{ "trigger": "/ship", "label": "Shipping forms", "documents": [{ "path": "S:/Shared/Logistics/forms/customs.pdf" }] }] } },
  { "id": "shipping-contacts", "label": "Shipping contacts", "audience": ["engineering", "shipping"],
    "library": [{ "trigger": "shipdesk/", "expansion": "shipping-desk@example.com" }] }
]
```

A desk receives the collections whose audience names one of its groups,
and every collection without an audience; a desk with no groups receives
only what is shared with everyone. What everyone gets comes first, then the
collections in policy order; a shortcut, rule, document set or lookup that
is already present wins over a newcomer, which is dropped with a warning
naming the collection. Unnamed keyword rules in a collection get the id
`<collection>/keyword-<n>`. The tier's shortcut cap counts what the desk
receives, and trims collection entries before shared ones. The Policy tab
lists the desk's groups, the collections it received and the names of
those it did not; the Library, Keywords and Documents tabs tag items from
a collection with its label.

Collections decide what a desk **shows and expands**, not what it can read:
every desk downloads the whole signed policy and keeps it in its cache.
Content that must not reach other desks at all belongs in its own policy
source, listed only in those desks' deployment files.

The admin tool checks every collection before signing (`validate`, `layers`
and `sign` parse as a desk in every group unless `--groups a,b` names one
kind of desk), checks the tier's caps per kind of desk and reports the
worst case (`desks in group shipping: …`), and shows what each kind of
desk receives:

```
node admin/actle-admin.js audience org.json dept.json
node admin/actle-admin.js audience org.json --groups engineering --tier team
node admin/actle-admin.js deployment --pub keys/policy-signing.pub --source layer=organisation,url=https://… --group shipping --out deployment.json
```

## Licensing

A business licence is a signed token (`actlebiz1.…`) issued by the vendor,
never by the organisation: it is signed with the vendor's key, whose public
part is built into the desktop app (`core/license.js`), so a policy signer
cannot grant itself seats or a higher tier. It states the organisation, the
**tier**, the number of seats, an expiry date and a grace period. Put the
token in the policy as `licence` and sign the policy as usual.

### Tiers

| Tier | Seats | Organisation shortcuts | Policy layers | Learning | Keyword rules and warnings | Documents and attach | Lookups | Report upload |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Free (no licence) | 1 | 25 | 1 | – | – | – | – | – |
| Team | 25 | 1,000 | 2 | yes | yes | yes | – | – |
| Business | 500 | 10,000 | 3 | yes | yes | yes | yes | yes |
| Enterprise | no limit | no limit | no limit | yes | yes | yes | yes | yes |

Never gated or counted in any tier: a person's own shortcuts, templates, the
palette, statistics, the local usage report, the update server
(`updates.url`), signing-key rotation and the pause switch. The table lives
in `core/license.js` (`TIERS`); the numbers are a product decision, not a
technical one.

What the desk checks, every time a policy is applied: the signature, that
the licence names the policy's organisation, and the dates. Valid, or
expired but within the grace period: the desk runs the licence's tier.
Expired past the grace period, missing, invalid or issued to another
organisation: the desk runs **Free**. Features the tier lacks are switched
off, including the person's own learn rules on Free. Over the shortcut cap
the desk keeps the first N organisation shortcuts in policy order (the
organisation layer first, then department, then team, so an entry added at
the end is the one left out) and shows one warning with the counts; a
keyword rule that pointed at a shortcut left out is dropped with its own
warning. Over the layer cap the desk applies every layer anyway and only
warns, because a dropped layer could remove an `off` capture rule or a
pause. Typing is never blocked. The Policy tab shows the tier, what the
policy uses against each cap, and the features on and off; the change log
records licence changes (id, status and tier only).

Seats are a contract term. Desks cannot see each other, so the desk never
refuses on seat count; the administrator's roll-up (`actle-admin report
--policy org.json`) counts desks per licence id and tier and warns when a
licence is over its seats or when desks report another tier than the
licence's.

Version 1 tokens (issued before tiers existed) still verify and count as
Business. A desk from before this version marks a version 2 token invalid,
so pin a vendor key only in a release that understands version 2. While no
vendor key is built into a version, licences cannot be checked: the desk
reports licensing as not enforced and runs as Enterprise.

### Checking a policy against the caps

`actle-admin sign`, `validate` and `layers` check the policy against the
tier named by `--tier`, or by the licence token found in the file (decoded,
not verified; the output says so). A policy over a cap prints the same
warning the desk would show; `sign` then refuses unless `--allow-warnings`,
and `validate` and `layers` exit 1. `layers` counts its files against the
layer cap. With no licence in the file and no `--tier`, the caps are not
checked and the output says so.

### Trying another tier (internal testing)

The Policy tab has **Testing: run this desk as**, which stores
`tierOverride` in the desk's settings. While no vendor key is built in, any
tier can be chosen. Once licensing is enforced, the choice is honoured only
when the policy sets `licensing.allowTierOverride: true`, and only for
tiers at or below the licensed one: a hand-edited settings file can never
unlock more than the licence grants. An honoured override is announced in
the dashboard banner and written to the change log
(`tier-override-changed`); the licence status itself is unchanged, and a
desk's usage report names the tier it ran.

```
node admin/actle-admin.js license issue --key vendor.key --org "Example Logistics Ltd" --tier business --seats 50 --expires 2027-12-31 --grace 30 --out licence.txt
node admin/actle-admin.js license show licence.txt --pub vendor.pub
node admin/actle-admin.js validate org.json --tier team
node admin/actle-admin.js layers org.json dept.json team.json
```

## Usage reports

A person exports a report from the dashboard (Overview, **Usage report…**),
after a preview of everything in it, and hands it to the administrator. A
report holds totals per period, the use of shortcuts, keyword rules and
document sets the organisation defined, and one total for the person's own
shortcuts. It never contains typed or inserted text, the names of a person's
own shortcuts, or individual timestamps. Compliance warnings are counted per
rule id (the ids the policy defines), never with the message or the text that
triggered them. A random desk id lets the roll-up
count a desk once.

```
node admin/actle-admin.js report reports/*.json --policy org.json --rate 38 --currency EUR --csv team.csv
```

prints desks, hours saved, estimated value, totals per team, organisation
shortcuts by use and the ones nobody used, and writes the same as CSV. An
unreadable report is skipped with a warning.

### Automatic upload

With `reporting.endpoint` set, each desk posts the same counts-only report
(JSON, `Content-Type: application/json`, header `X-Actle-Install` with the
desk id) at start and then every `uploadEvery`, retrying an hour after a
failure. The Policy tab shows the endpoint, the last upload, its outcome and
the full body that was sent, with a "Send now" button. A failed upload is
recorded in the change log; the desk keeps working. With `uploadToken` the
body is also signed with HMAC-SHA256 of the token. Desks hold no private key
and the token sits in every desk's policy cache, so the signature proves
only "sent by a desk holding this policy". The collector is yours to run:
anything that accepts an https POST.

## Software updates

A packaged desk (an installer built with `cd corporate/desktop && npm run
dist`) checks `updates.url` ninety seconds after start and every six hours,
and only when the policy names such a server; a desk without one never
contacts anything. The server is any static https host holding what
electron-builder leaves in `dist/`: the installers (`.exe`, `.dmg` and
`.zip`, `.AppImage`) and `latest.yml`, `latest-mac.yml`, `latest-linux.yml`
(or `<channel>.yml` for another channel). Copy a new build's files there and
every desk picks it up at its next check; downloads are verified against the
hash in the `.yml`. The update installs when the app next quits, or at once
with **Restart and install** on the Policy tab. A person can tick **Defer
updates** there: the desk then only announces a new version and downloads
it when they press **Download now**. Available, downloaded and failed
updates go to the change log; a failed check never stops the assistant. Linux
`.deb` installs do not self-update (electron-updater supports AppImage only);
a `.deb` desk is updated by the package manager.

```json
"updates": { "url": "https://intranet.example/actle/updates", "channel": "latest" }
```

Installers from CI are unsigned. For a signed build set `CSC_LINK` and
`CSC_KEY_PASSWORD` (Windows and macOS) and `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarisation when
running `npm run dist`; on Windows an update only installs over a build
signed by the same certificate, so sign from the first release onward. The
Windows installer accepts `/S` for a silent per-machine install.

## Lookups

A lookup inserts a block built from one row of a data file the organisation
keeps: `/cust 1001 ` (trigger, space, key, space) becomes the customer block
for id 1001, rendered from the lookup's template. The trigger follows the
same boundary rule as shortcuts; the key is one word of up to 64
characters; typing the space after it completes the lookup (Enter does
not, so a chat message is not sent by accident). On a hit the typed text is
replaced; on a miss a notice says so and nothing is deleted. Keys are
matched after trimming, ignoring case. `[[field]]` blanks take the row's
columns of the same name; `{date}` and the other placeholders render as
usual; a field the row lacks stays visible as `[[field]]`.

The data is fetched at start and then every `refreshMinutes` (CSV or JSON,
a file path on a share or an https address, up to 5 MB and 50,000 rows;
https-to-http redirects are refused) and cached as plain JSON under
`lookup-cache/` in the data folder. It is organisation reference data the
desk already receives in the clear; sealing it with the learning key would
stop lookups on desks without a keychain and protect nothing the source
file does not. A source that cannot be fetched keeps its last good copy
with a warning on the Documents tab, where "Refresh data now" fetches all
sources. Lookups appear in the search palette (`/cust 1001` resolves
directly) and count as organisation inserts in usage reports (trigger and
count only, never the row).

```json
"lookups": [
  { "trigger": "/cust", "label": "Customer block",
    "source": { "kind": "csv", "path": "S:/Shared/Logistics/customers.csv", "key": "id", "refreshMinutes": 60 },
    "template": "[[name]] ([[id]])\n[[address]]\nAccount manager: [[manager]]" }
]
```

## Phrase suggestions from desks

On the Learning tab a person can mark a proposal **Suggest to organisation**
and later export the list (after seeing exactly what it holds). A template
suggestion carries the template with its blanks, never the values seen in
them. The administrator ranks the files:

```
node admin/actle-admin.js suggestions incoming/*.json --policy org.json --min-desks 2 --out proposed-library.json
```

Each text counts once per desk (newest file wins); texts already in the
policy library are left out; the trigger most desks chose is kept unless the
library already uses it. `--out` writes a `shorthands.json`-format file to
review and then add to the policy's `library` before signing.

## Capture modes

* **off**: the assistant ignores the application entirely, including triggers.
* **triggers**: a rolling buffer of the last 200 characters is matched against
  triggers and document shortcuts and is never written anywhere. This is what
  the personal Windows app does in every application. While the policy has
  keyword rules, the text of the current field (up to 4,000 characters) is
  also held in memory to check them, and dropped when the focus moves.
* **learn**: in addition, the text typed in that application is kept per
  field session (until the focus moves), scrubbed, and stored under the data
  folder so the phrase miner can propose shortcuts and fill-in templates.

Learn mode is never applied to credential prompts, password managers,
terminals or secure-input fields, even when a rule asks for it, and card
numbers, labelled secrets ("password: …") and long token-like strings are
masked before a session is stored. The person can see, pause and delete the
learning corpus from the dashboard at any time.

### Answers remembered per email conversation

When a person fills in a template's `[[blanks]]` while writing in a mail
client, the answers are kept for that conversation and offered as defaults
the next time a template in the same conversation asks for the same blank
(editable; nothing is inserted unseen). A conversation is the subject of
the focused window, per mail application: reply and forward prefixes
(`RE:`, `FW:`, `AW:`, …), the client's and the browser's suffixes and the
account name are stripped, and folder or view titles (Inbox, Sent, Drafts…)
never count. Recognised: Outlook, Thunderbird, Apple Mail and Evolution by
their process, Gmail and Outlook on the web by the tab title. In Outlook
the title of the main window is the folder, so only pop-out message windows
are recognised; macOS without the Accessibility permission and Linux on
Wayland give no window titles, so nothing is remembered there.

Nothing is remembered in a window whose capture mode is `off`, in
credential prompts, or while the policy is paused; blanks whose name says
they hold a secret (password, PIN, token, CVV…) and values that scrubbing
would change (card numbers, labelled secrets, tokens) are never stored.
Records are sealed with the same key as learned text (without a keychain
they live for the session only), expire after 90 days or
`retention.corpusDays` if that is shorter, are never part of usage reports
or the change log, and are listed on the Learning tab with Remove and
Forget all. `threadMemory.enabled: false` switches the feature off for
every desk; the person can switch it off for their own desk.
