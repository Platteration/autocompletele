# Shorthand format and matching rules

All three apps (Chrome extension, Windows program, Android app) share one
concept: a list of **shorthands**. Each shorthand has a short **trigger**
the user types and an **expansion** that replaces it.

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

## Placeholders

The following placeholders are substituted inside an expansion:

| Placeholder | Result                                   |
| ----------- | ---------------------------------------- |
| `{date}`    | Local date, e.g. `2026-09-08`            |
| `{time}`    | Local time, e.g. `14:05`                 |
| `{datetime}`| `2026-09-08 14:05`                       |
| `{cursor}`  | Removed; caret is placed here afterwards |

To write a literal `{date}`, escape the brace as `{{date}}`.
