// Named fill-in blanks live inside ordinary expansion text, so existing
// storage and JSON exports preserve templates without a format migration.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./expander.js"));
  } else {
    root.ShorthandTemplate = factory(root.ShorthandExpander);
  }
})(typeof self !== "undefined" ? self : this, function (expander) {
  "use strict";

  function asText(value) {
    return String(value == null ? "" : value);
  }

  const variableLabels = Object.freeze({
    weekday: "Weekday",
    subject: "Subject pronoun",
    object: "Object pronoun",
    possessive: "Possessive determiner",
    possessivepronoun: "Possessive pronoun",
    reflexive: "Reflexive pronoun",
  });
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  // {subject} is person 1; {subject2} to {subject4} let one script refer to
  // up to four people, each with their own pronoun choice.
  const PEOPLE = 4;
  const pronounPresets = Object.freeze({
    "she/her": Object.freeze({ subject: "she", object: "her", possessive: "her", possessivepronoun: "hers", reflexive: "herself" }),
    "he/him": Object.freeze({ subject: "he", object: "him", possessive: "his", possessivepronoun: "his", reflexive: "himself" }),
    "they/them": Object.freeze({ subject: "they", object: "them", possessive: "their", possessivepronoun: "theirs", reflexive: "themself" }),
  });

  /** Split named blanks and browser variables, preserving their escapes. */
  function parts(text) {
    const source = asText(text);
    const result = [];
    let pending = "";
    let position = 0;

    const flush = () => {
      if (pending) result.push({ type: "text", value: pending });
      pending = "";
    };

    while (position < source.length) {
      if (source[position] === "{") {
        // Consume an escape as a whole so its inner token cannot request an
        // answer. The shared renderer removes one brace pair later.
        const escapedVariable = /^\{\{[a-z]+[1-4]?(?:[+-]\d{1,4})?\}\}/i.exec(source.slice(position));
        if (escapedVariable) {
          pending += escapedVariable[0];
          position += escapedVariable[0].length;
          continue;
        }
        const variable = /^\{(weekday|subject|object|possessive|possessivepronoun|reflexive)([1-4])?([+-]\d{1,4})?\}/i.exec(source.slice(position));
        const weekday = variable && variable[1].toLowerCase() === "weekday";
        if (variable && (weekday ? !variable[2] : !variable[3])) {
          flush();
          const name = variable[1].toLowerCase();
          const part = { type: "variable", name, label: variableLabels[name], raw: variable[0] };
          if (variable[3]) part.offset = parseInt(variable[3], 10);
          if (variable[2]) part.person = Number(variable[2]);
          result.push(part);
          position += variable[0].length;
          continue;
        }
      }
      const escaped = source.startsWith("\\[[", position);
      const start = escaped ? position + 1 : position;
      if (!source.startsWith("[[", start)) {
        pending += source[position++];
        continue;
      }
      const end = source.indexOf("]]", start + 2);
      if (end < 0) {
        pending += source.slice(position);
        break;
      }
      const raw = source.slice(start, end + 2);
      const body = source.slice(start + 2, end);
      const name = body.trim();
      if (!name || /[\[\]\r\n]/.test(body)) {
        pending += source.slice(position, end + 2);
      } else if (escaped) {
        pending += raw;
      } else {
        flush();
        result.push({ type: "field", name, label: name, raw });
      }
      position = end + 2;
    }
    flush();
    return result;
  }

  /** Repeated, case-sensitive names share one answer. */
  function fields(text) {
    const seen = new Set();
    return parts(text).filter((part) => {
      if (part.type !== "field" || seen.has(part.name)) return false;
      seen.add(part.name);
      return true;
    }).map(({ name, label }) => ({ name, label }));
  }

  function variables(text) {
    return [...new Set(parts(text).filter((part) => part.type === "variable").map((part) => part.name))];
  }

  /** Pronoun values are keyed "subject" for person 1 and "subject2" onward. */
  function pronounKey(name, person) {
    return person > 1 ? name + person : name;
  }

  /** The people a script mentions, in order, with the pronoun forms each uses. */
  function pronounPeople(text) {
    const people = new Map();
    for (const part of parts(text)) {
      if (part.type !== "variable" || part.name === "weekday") continue;
      const person = part.person || 1;
      if (!people.has(person)) people.set(person, []);
      const names = people.get(person);
      if (!names.includes(part.name)) names.push(part.name);
    }
    return [...people].sort((a, b) => a[0] - b[0]).map(([person, names]) => ({ person, names }));
  }

  /** Expand a preset choice for one person into its keyed pronoun values. */
  function presetFor(preset, person) {
    const forms = pronounPresets[preset];
    const values = Object.create(null);
    if (forms) for (const name of Object.keys(forms)) values[pronounKey(name, person)] = forms[name];
    return values;
  }

  function requiresInput(text) {
    return parts(text).some((part) => part.type === "field"
      || (part.type === "variable" && part.name !== "weekday"));
  }

  function resolve(parsed, values) {
    const answers = new Map();
    for (const part of parsed) {
      if (part.type !== "field" || answers.has(part.name)) continue;
      if (values != null && Object.hasOwn(values, part.name)) {
        answers.set(part.name, asText(values[part.name]));
      }
    }
    return answers;
  }

  /** Substitute once: an answer containing another token remains literal. */
  function fill(text, values) {
    const parsed = parts(text);
    const answers = resolve(parsed, values);
    return parsed.map((part) => part.type === "text" ? part.value
      : part.type === "field" && answers.has(part.name) ? answers.get(part.name) : part.raw).join("");
  }

  function variableValue(part, now, pronouns) {
    let value;
    if (part.name === "weekday") value = weekdays[(((now.getDay() + (part.offset || 0)) % 7) + 7) % 7];
    else if (pronouns != null && Object.hasOwn(pronouns, pronounKey(part.name, part.person))) {
      value = asText(pronouns[pronounKey(part.name, part.person)]);
    }
    else return part.raw;
    const spelling = part.raw.slice(1, 1 + part.name.length);
    if (spelling === spelling.toUpperCase()) return value.toUpperCase();
    if (spelling === part.name[0].toUpperCase() + part.name.slice(1)) {
      return value.replace(/^./u, (letter) => letter.toUpperCase());
    }
    return value;
  }

  /** Render built-in placeholders in the template, never in supplied answers. */
  function render(text, values, now, pronouns) {
    const source = asText(text);
    const parsed = parts(source);
    const answers = resolve(parsed, values);
    const renderTime = now || new Date();
    // Rendering can join literal characters by removing {cursor}. Check the
    // rendered text segments too, so those joins cannot manufacture a marker.
    // Field markers separate the segments and interrupt built-in placeholders.
    const renderedLiterals = parsed.filter((part) => part.type === "text")
      .map((part) => expander.render(part.value, renderTime).text);
    // Include answers for names this particular template does not reference.
    const supplied = [values, pronouns].flatMap((source) => source == null ? [] : Object.keys(Object(source))
      .map((name) => asText(source[name])));
    const occupied = [source, ...renderedLiterals, ...supplied];
    let markerPrefix = "\uE000";
    while (occupied.some((value) => value.includes(markerPrefix))) {
      markerPrefix += "\uE000";
    }
    const replacements = [];
    const protectedText = parsed.map((part) => {
      if (part.type === "text") return part.value;
      const index = replacements.length;
      replacements.push(part.type === "variable" ? variableValue(part, renderTime, pronouns)
        : answers.has(part.name) ? answers.get(part.name) : part.raw);
      return markerPrefix + index + "\uE001";
    }).join("");
    const rendered = expander.render(protectedText, renderTime);
    const marker = new RegExp(markerPrefix + "(\\d+)\uE001", "g");
    let cursorOffset = rendered.cursorOffset;
    const output = rendered.text.replace(marker, (match, index, offset) => {
      const replacement = replacements[Number(index)];
      if (offset < rendered.cursorOffset) cursorOffset += replacement.length - match.length;
      return replacement;
    });
    return { text: output, cursorOffset };
  }

  return { parts, fields, variables, pronounPeople, pronounKey, presetFor, requiresInput, pronounPresets, PEOPLE, fill, render };
});
