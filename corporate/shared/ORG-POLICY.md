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
| `serial` | Positive integer, required for a signed policy. Raise it every time the policy changes; desks refuse a signed policy whose serial is lower than the one they already accepted, or the same serial with different content. |
| `paused` | Kill switch. `true` or `{ "message": "…" }` pauses every desk that receives the policy: nothing is expanded, offered or learned, and the person cannot resume it. Nothing is deleted. Remove it (or set `{ "active": false }`) to resume. |
| `organization` | Name shown on the dashboard. |
| `typing.charsPerMinute` | Typing-speed assumption behind "time saved" (default 200, which is 40 words per minute). Changing it re-estimates history. |
| `typing.secondsPerAttachment` | Time credited for each document attached through a shortcut (default 20). |
| `capture.defaultMode` | `off`, `triggers` (default) or `learn` for applications no rule names. |
| `capture.apps[]` | Per-application rules, first match wins. `match.process` (one name or a list; `.exe` and paths are ignored), `match.bundleId` (macOS) and `match.title` (regular expression, case-insensitive) identify the window. `mode` is as above. |
| `library` | The shared shortcut library in the personal `shorthands.json` format (`shared/SPEC.md` at the repository root). A person's own shortcut with the same trigger wins. |
| `keywordRules[]` | `keywords` (list), `match` (`any` default, or `all`), `caseSensitive` (default false) and `insert`: `{ "kind": "text", "text": ... }`, `{ "kind": "shorthand", "trigger": ... }` (must exist in `library`) or `{ "kind": "document", "shortcut": ... }` (must exist in `documents`). Each rule fires once per field. |
| `keywordRules[].action` | `offer` (default) shows the insert. `warn` shows `message` (required) and offers `insert` as an optional fix: a compliance warning. |
| `keywordRules[].detect` | Built-in detectors that must also fire. `card-number` finds a card number that passes the Luhn check. A rule may have `detect` instead of `keywords`. |
| `keywordRules[].unless` | Phrases that stop the rule when any of them appears anywhere in the field (case and spacing ignored), for example the disclaimer itself. Only text typed in the field or inserted by actle is seen; a mail client's automatic signature or pasted text is not. |
| `documents.shortcuts[]` | `trigger` (for example `/sld`), `label`, and `documents[]` with `title`, `path` (file path or URL), optional `tags` and `description`. Triggers follow the same boundary rule as text shortcuts and lose to a text shortcut with the same trigger. |
| `learning.minCount` | Distinct messages a text must recur in before it is proposed (default 3, minimum 2). |
| `learning.minLength`, `learning.minWords` | Smallest text worth proposing (defaults 20 characters, 4 words). |
| `reporting.team` | Team name written into each desk's usage report. |
| `reporting.hourlyRate`, `reporting.currency` | Used to turn hours saved into an estimated value in the roll-up. |
| `reporting.period`, `reporting.periods` | Buckets in a usage report: `day`, `week` (default) or `month`, and how many (default 12). |
| `reporting.includeApps` | `true` adds per-application totals to usage reports (default `false`). |
| `retention.metricsDays` | Days of statistics kept on disk (default 365). |
| `retention.corpusDays` | Days of learning text kept on disk (default 90). |

## Central distribution (signed policies)

On a managed desk, IT installs `deployment.json` in the app's data folder:

```json
{
  "policySources": [
    { "label": "Organisation", "url": "https://intranet.example/actle/org.signed.json" },
    { "label": "Shipping team", "path": "S:/IT/actle/shipping.signed.json" }
  ],
  "publicKeys": ["-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"],
  "refreshMinutes": 60
}
```

* Sources are layers, most general first. Later layers win field by field;
  shortcuts merge by trigger, keyword rules by `id`, document sets by
  trigger, and a later layer's capture rules are tried before an earlier
  one's. A pause in any layer pauses the desk.
* Every source must be signed with a key listed in `publicKeys`. Only
  `https://` URLs and file paths are accepted; plain `http://` is refused.
* The desk fetches at start and every `refreshMinutes` (minimum 5, default
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
node admin/actle-admin.js sign org.json --key keys/policy-signing.key --serial 2 --out org.signed.json
node admin/actle-admin.js verify org.signed.json --pub keys/policy-signing.pub
```

`sign` refuses a policy that has warnings unless `--allow-warnings` is
given, and `keygen` refuses to overwrite an existing key.

## Usage reports

A person exports a report from the dashboard (Overview, **Usage report…**),
after a preview of everything in it, and hands it to the administrator. A
report holds totals per period, the use of shortcuts, keyword rules and
document sets the organisation defined, and one total for the person's own
shortcuts. It never contains typed or inserted text, the names of a person's
own shortcuts, or individual timestamps. A random desk id lets the roll-up
count a desk once.

```
node admin/actle-admin.js report reports/*.json --policy org.json --rate 38 --currency EUR --csv team.csv
```

prints desks, hours saved, estimated value, totals per team, organisation
shortcuts by use and the ones nobody used, and writes the same as CSV. An
unreadable report is skipped with a warning.

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
