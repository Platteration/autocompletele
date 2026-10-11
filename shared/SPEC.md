# Shorthand format and matching rules

All three apps (Chrome/Firefox extension, Windows program, Android app) share one
concept: a list of **shorthands**. Each shorthand has a short **trigger**
the user types and an **expansion** that replaces it.

The shared rules below are pinned down by `conformance.json` in this folder, which
every platform's test suite loads and runs. Anything added to the rules should
gain a case there first, so the three implementations cannot drift apart.

## File format

Shorthands are stored and exchanged as JSON:

```json
{
  "version": 1,
  "shorthands": [
    { "trigger": "cool/", "expansion": "That is really cool, thanks for sharing!" },
    { "trigger": "sig/",  "expansion": "Best regards,\nAlex" },
    { "trigger": "td/",   "expansion": "{date}" }
  ]
}
```

* `trigger` – non-empty, no leading/trailing whitespace, case-sensitive.
* `expansion` – any text, may contain newlines and placeholders.

Every app can import and export this exact file, so a list built on one
device can be copied to the others.

## When a trigger fires

A trigger fires the moment the text *before the caret* ends with the
trigger, provided the character just before the trigger (if any) is a
word boundary: whitespace, punctuation, or the start of the field.

* `cool/` fires after typing `c o o l /`.
* `school/` does **not** fire `cool/` because `s` precedes `cool/`.
* `(cool/` fires because `(` is a boundary.

If several triggers match, the longest one wins.

The trigger is deleted and replaced with the expansion; the caret is placed
at the end of the inserted text, or at the `{cursor}` placeholder if one was
used.

Triggers therefore usually end in a character that is not part of ordinary
words, such as `/`, `;` or `\`. That character acts as the "go" key, so a
trigger like `cool/` never interferes with typing the word "cool".

## Undo

Pressing **Backspace** as the very next key after an expansion removes the
expansion and puts the trigger back, so an accidental expansion costs one
keystroke. Any other key, click or focus change closes the undo window.

## Opting a field out (web only)

Site authors and the extension's own options page can mark an element with
`data-shorthand-ignore`; the extension never expands inside it or its
descendants.

## Placeholders

The following placeholders are substituted inside an expansion:

| Placeholder | Result                                   |
| ----------- | ---------------------------------------- |
| `{date}`    | Local date, e.g. `2026-09-08`            |
| `{time}`    | Local time, e.g. `14:05`                 |
| `{datetime}`| `2026-09-08 14:05`                       |
| `{cursor}`  | Removed; caret is placed here afterwards |

To write a literal `{date}`, escape the brace as `{{date}}`.

## Browser-only fill-in templates

The Chrome and Firefox extensions additionally recognize named blanks such as
`[[name]]` in an expansion. This is a browser feature covered by the extension's
template tests, not a shared conformance rule. The JSON format remains version
1: blanks are ordinary characters in the saved `expansion` string, with no
stored answers or extra fields. Windows and Android preserve this text during
import and export but do not prompt for answers; `[[name]]` remains literal
when those apps expand it.

Each distinct name becomes one required input in a temporary form. Names are
trimmed and case-sensitive, so `[[ name ]]` and `[[name]]` share an answer while
`[[Name]]` asks separately. Names cannot be empty or contain brackets or line
breaks. Invalid blank syntax remains literal. Prefix a valid blank with a
backslash (`\[[name]]`) to insert literal `[[name]]` in the browser without a
prompt. JSON encodes that backslash as `\\`.

Typing a template's trigger or choosing it from the browser's search picker
opens the form. The trigger stays in the field until the user confirms
insertion; cancellation leaves it unchanged. Choosing a template from the
toolbar opens the form before copying. Answers are substituted once and remain
literal, including any `[[other]]`, `{date}`, or `{cursor}` text they contain.
Built-in placeholders in the saved script are still rendered. Answers are not
saved to the library or included in exports.
