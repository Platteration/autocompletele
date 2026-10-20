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
| `licence` | The business licence token issued by the vendor (`actle-admin license issue`). The desk verifies it offline; see "Licensing" below. Later layers override earlier ones. |
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
| `learning.minCount` | Distinct messages a text must recur in before it is proposed (default 3, minimum 2). |
| `learning.minLength`, `learning.minWords` | Smallest text worth proposing (defaults 20 characters, 4 words). |
| `reporting.team` | Team name written into each desk's usage report. |
| `reporting.hourlyRate`, `reporting.currency` | Used to turn hours saved into an estimated value in the roll-up. |
| `reporting.period`, `reporting.periods` | Buckets in a usage report: `day`, `week` (default) or `month`, and how many (default 12). |
| `reporting.includeApps` | `true` adds per-application totals to usage reports (default `false`). |
| `reporting.endpoint` | `https://` address that collects usage reports. Absent: nothing is ever sent. Plain `http://` is refused with a warning. |
| `reporting.uploadEvery` | `day` or `week` (default): how often a desk sends its report once the endpoint is set. |
| `reporting.uploadToken` | Optional shared secret. The body is signed with HMAC-SHA256 (`X-Actle-Signature: sha256=…`) so the collector can drop posts from anyone who merely knows the URL. |
| `retention.metricsDays` | Days of statistics kept on disk (default 365). |
| `retention.corpusDays` | Days of learning text kept on disk (default 90). |

## Central distribution (signed policies)

On a managed desk, IT installs `deployment.json` in the app's data folder:

```json
{
  "policySources": [
    { "layer": "organisation", "label": "Organisation", "url": "https://intranet.example/actle/org.signed.json" },
    { "layer": "shipping", "label": "Shipping team", "path": "S:/IT/actle/shipping.signed.json" }
  ],
  "publicKeys": ["-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"],
  "refreshMinutes": 60
}
```

* Sources are layers, most general first. Later layers win field by field;
  shortcuts merge by trigger, keyword rules by `id`, document sets by
  trigger, and a later layer's capture rules are tried before an earlier
  one's. A pause in any layer pauses the desk.
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

## Licensing

A business licence is a signed token (`actlebiz1.…`) issued by the vendor,
never by the organisation: it is signed with the vendor's key, whose public
part is built into the desktop app (`core/license.js`), so a policy signer
cannot grant itself seats. It states the organisation, the number of seats,
an expiry date and a grace period. Put the token in the policy as `licence`
and sign the policy as usual.

What the desk checks, every time a policy is applied: the signature, that
the licence names the policy's organisation, and the dates. Valid, or
expired but within the grace period: every feature is on. Expired past the
grace period, missing, invalid or issued to another organisation: the desk
runs the **free tier**. Shortcuts (own and organisation), templates, the
palette, statistics and the local usage report keep working; learning,
keyword rules and warnings, document shortcuts, lookups and report upload
are off, including the person's own learn rules. Typing is never blocked.
The Policy tab shows the licence and the reason for the tier; the change
log records licence changes (id and status only).

Seats are a contract term. Desks cannot see each other, so the desk never
refuses on seat count; the administrator's roll-up (`actle-admin report
--policy org.json`) counts desks per licence id and warns when a licence
is over its seats.

While no vendor key is built into a version, licences cannot be checked:
the desk reports licensing as not enforced and keeps every feature on.

```
node admin/actle-admin.js license issue --key vendor.key --org "Example Logistics Ltd" --seats 50 --expires 2027-12-31 --grace 30 --out licence.txt
node admin/actle-admin.js license show licence.txt --pub vendor.pub
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
