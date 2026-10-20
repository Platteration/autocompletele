// Turn a writing-pad draft into a fill-in template: find the values that change
// from one email to the next (the greeting name, dates, amounts...) and write
// the draft as an actle expansion with [[blanks]] in their place. Pure: no DOM,
// storage or network.
//
// buildTemplate must survive actle's own renderer (template.js on top of
// expander.js) exactly, so the escaping below follows their parsers:
// - template.parts reads "[[body]]" as a blank when the body is non-empty after
//   trim() and has no [ ] \r \n; "\[[body]]" is the same text as a literal with
//   the backslash removed; anything else (empty, bracketed, unclosed) is
//   literal as written. A "[[" with no "]]" after it makes the rest literal.
// - expander.render turns "{{x}}" into "{x}" when x matches
//   [a-z]+[1-4]?([+-]\d{1,4})? (ASCII letters, any case), and replaces {date},
//   {time}, {datetime}, {cursor}; template.parts also reads {weekday} and the
//   pronoun variables. Every "{x}" of that shape is therefore written "{{x}}",
//   not only today's placeholder names, so a placeholder added later cannot
//   change what an old template inserts.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ShorthandTemplateMaker = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Between candidates that start at the same place, the lower number wins.
  const PRIORITY = { name: 0, email: 1, link: 2, date: 3, day: 4, time: 5, amount: 6, phone: 7, number: 8, repeat: 9 };

  const CAP = String.raw`[\p{Lu}\p{Lt}][\p{L}\p{M}]*(?:['\u2019\-][\p{L}\p{M}]+)*`;
  const TITLE = String.raw`(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?`;
  const PERSON = String.raw`(?:${TITLE}[ \t]+)?${CAP}(?:[ \t]+(?:(?:and|&)[ \t]+)?${CAP}){0,2}`;
  const GREETING = new RegExp(String.raw`^[ \t]*(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Gg]ood[ \t]+(?:[Mm]orning|[Aa]fternoon|[Ee]vening))(?:[ \t]*,)?[ \t]+(${PERSON})(?=[ \t]*(?:[,!.:;]|$))`, "gmu");
  // "Hi Team," and "Dear Sir," address nobody in particular.
  const GENERIC = new Set(["all", "everyone", "everybody", "team", "there", "folks", "guys", "friends",
    "both", "sir", "madam", "colleague", "colleagues", "again", "you", "y'all", "ladies", "gentlemen",
    "people", "world", "members", "customer", "customers"]);

  const SIGNOFF = new RegExp(String.raw`^[ \t]*(?:best(?:[ \t]+(?:regards|wishes))?|kind(?:est)?[ \t]+regards|warm(?:est)?[ \t]+(?:regards|wishes)|regards|many[ \t]+thanks|thanks(?:[ \t]+(?:again|so[ \t]+much))?|thank[ \t]+you(?:[ \t]+(?:again|so[ \t]+much))?|cheers|sincerely|yours(?:[ \t]+(?:sincerely|truly|faithfully))?|all[ \t]+the[ \t]+best|take[ \t]+care|talk[ \t]+soon|warmly|respectfully|with[ \t]+thanks|love)[ \t]*([,!.]?)[ \t]*(.*)$`, "gimu");
  const SIGNOFF_NAME = new RegExp(String.raw`^${PERSON}[ \t]*[.!]?[ \t]*$`, "u");

  // Starting only where an address can start keeps a long run of letters,
  // dots or hyphens linear instead of retrying it from every position.
  const EMAIL = /(?<![\p{L}\p{N}._%+\-])[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}](?:[\p{L}\p{N}\-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}\-]*[\p{L}\p{N}])?)+/gu;
  // Characters RFC 3986 does not allow unescaped are not part of a link.
  const LINK = /(?:https?:\/\/|www\.)[^\s<>"`{}|\\^\[\]]+/giu;
  const PHONE = /(?:\+\d{1,3}[ .\-]?)?(?:\(\d{1,5}\)[ .\-]?)?\d{1,5}(?:[ .\-]\d{1,5}){0,6}/gu;

  const MONTH = String.raw`(?:January|February|March|April|May|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\.?)`;
  const DAY_OF_MONTH = String.raw`(?:3[01]|[12]\d|0?[1-9])(?:st|nd|rd|th)?`;
  const WEEKDAY = String.raw`(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)`;
  const WEEKDAY_PREFIX = String.raw`(?:(?:${WEEKDAY}|(?:Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)\.?),?[ \t]+)?`;
  const YEAR = String.raw`(?:,?[ \t]+\d{4})?`;
  const OPEN = String.raw`(?<![\p{L}\p{N}])`;
  const CLOSE = String.raw`(?![\p{L}\p{N}])`;
  const DATES = [
    new RegExp(`${OPEN}${WEEKDAY_PREFIX}${MONTH}[ \\t]+${DAY_OF_MONTH}${YEAR}${CLOSE}`, "gu"),
    new RegExp(`${OPEN}${WEEKDAY_PREFIX}(?:the[ \\t]+)?${DAY_OF_MONTH}(?:[ \\t]+of)?[ \\t]+${MONTH}${YEAR}${CLOSE}`, "gu"),
    // 2026-10-20, 2026/10/20, and day/month/year or month/day/year with / . or -.
    /(?<![\p{L}\p{N}.\/\-])\d{4}([\/\-])(?:0?[1-9]|1[0-2])\1(?:0?[1-9]|[12]\d|3[01])(?![\p{L}\p{N}]|[.\/\-]\p{N})/gu,
    /(?<![\p{L}\p{N}.\/\-])(\d{1,2})([\/.\-])(\d{1,2})\2(?:\d{4}|\d{2})(?![\p{L}\p{N}]|[.\/\-]\p{N})/gu,
  ];
  const DAY = new RegExp(`${OPEN}${WEEKDAY}${CLOSE}`, "gu");
  // "pm" and "p.m." but not the full stop after "3pm." that ends a sentence.
  const TIMES = [
    /(?<![\p{L}\p{N}:.])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:[ \t]?(?:[AaPp][Mm]|[AaPp]\.[Mm]\.?))?(?![\p{L}\p{N}]|:\d)/gu,
    /(?<![\p{L}\p{N}:.])(?:1[0-2]|0?[1-9])[ \t]?(?:[AaPp][Mm]|[AaPp]\.[Mm]\.?)(?![\p{L}\p{N}])/gu,
  ];

  const NUMBER = String.raw`(?:\d{1,3}(?:[,.'\u00a0\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?`;
  const SCALE = String.raw`(?:[ \t]?(?:k|K|M|bn|million|billion|thousand))?`;
  const CODES = "(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|INR|NZD|SEK|NOK|DKK|PLN|MXN|BRL|ZAR|SGD|HKD|KRW|TRY|ILS|AED|CZK|HUF)";
  const AMOUNTS = [
    new RegExp(`${OPEN}(?:[A-Z]{1,2})?\\p{Sc}[ \\t\\u00a0]?${NUMBER}${SCALE}${CLOSE}`, "gu"),
    new RegExp(`(?<![\\p{L}\\p{N}.,])${NUMBER}[ \\t\\u00a0]?\\p{Sc}${CLOSE}`, "gu"),
    new RegExp(`${OPEN}${CODES}[ \\t\\u00a0]?${NUMBER}${SCALE}${CLOSE}`, "gu"),
    new RegExp(`(?<![\\p{L}\\p{N}.,])${NUMBER}${SCALE}[ \\t\\u00a0]?${CODES}${CLOSE}`, "gu"),
  ];

  const HASH_ID = /(?<![\p{L}\p{N}&#])#[\p{L}\p{N}](?:[\p{L}\p{N}\-_]*[\p{L}\p{N}])?/gu;
  const TOKEN = /[\p{L}\p{N}]+(?:[\-_\/][\p{L}\p{N}]+)*/gu;

  // Shape of the {x} tokens the renderers read; see the header comment.
  const BRACE_TOKEN = /\{[a-z]+[1-4]?(?:[+-]\d{1,4})?\}/gi;
  const BRACE_TOKEN_AT = /\{[a-z]+[1-4]?(?:[+-]\d{1,4})?\}/iy;

  function asText(value) {
    return typeof value === "string" ? value : String(value == null ? "" : value);
  }

  function each(pattern, text, visit) {
    pattern.lastIndex = 0;
    for (let match; (match = pattern.exec(text)) !== null;) {
      visit(match);
      if (match[0] === "") pattern.lastIndex++;
    }
  }

  function digitCount(value) {
    return (value.match(/\d/g) || []).length;
  }

  /**
   * Where the writer's own sign-off starts ("Best regards," and the lines
   * under it), or text.length. Nothing there becomes a blank: the name and
   * contact details under a sign-off are usually the writer's.
   */
  function signoffStart(text) {
    let strong = -1;
    let weak = -1;
    each(SIGNOFF, text, (match) => {
      const punctuation = match[1];
      const rest = match[2];
      if (rest && !SIGNOFF_NAME.test(rest)) return;
      const after = text.slice(match.index + match[0].length).split(/\r\n|[\n\r\u2028\u2029]/u)
        .filter((line) => line.trim()).length;
      if (punctuation === "," || rest) {
        if (after <= 8) strong = match.index;
      } else if (after <= 2) {
        weak = match.index;
      }
    });
    return strong >= 0 ? strong : weak >= 0 ? weak : text.length;
  }

  function greetingNames(text, add) {
    each(GREETING, text, (match) => {
      const person = match[1];
      const words = person.split(/[ \t]+/u).filter((word) => !/^(?:and|&)$/u.test(word));
      if (words.every((word) => GENERIC.has(word.toLowerCase().replace(/\u2019/gu, "'")))) return;
      const end = match.index + match[0].length;
      add("name", end - person.length, end);
    });
  }

  function emails(text, add) {
    each(EMAIL, text, (match) => {
      const lead = /^[._%+\-]*/u.exec(match[0])[0].length;
      if (!/\.\p{L}{2,}$/u.test(match[0])) return;
      if (match[0].indexOf("@") <= lead) return;
      add("email", match.index + lead, match.index + match[0].length);
    });
  }

  function links(text, add) {
    each(LINK, text, (match) => {
      if (/[\p{L}\p{N}@.]/u.test(text[match.index - 1] || "")) return;
      let value = match[0];
      for (;;) {
        const last = value[value.length - 1];
        if (last === ")" && (value.match(/\(/g) || []).length >= (value.match(/\)/g) || []).length) break;
        if (!/[.,;:!?'\u2019\u201d\u00bb)]/u.test(last)) break;
        value = value.slice(0, -1);
      }
      if (/^(?:https?:\/\/|www\.)$/iu.test(value)) return;
      add("link", match.index, match.index + value.length);
    });
  }

  function phones(text, add) {
    each(PHONE, text, (match) => {
      const value = match[0];
      if (/[\p{L}\p{N}+]/u.test(text[match.index - 1] || "")) return;
      if (/[\p{L}\p{N}]/u.test(text[match.index + value.length] || "")) return;
      const digits = digitCount(value);
      if (digits < 7 || digits > 15) return;
      const groups = value.split(/[ .\-()+]+/u).filter(Boolean);
      if (!value.startsWith("+") && !value.includes("(")) {
        // A bare digit run is left to the number rule; 10.234.567 and
        // 1 234 567 are thousands; 2025-2026 is a span of years.
        if (groups.length < 2 || !groups.some((group) => group.length >= 3)) return;
        if (groups[0].length <= 3 && groups.slice(1).every((group) => group.length === 3)) return;
        if (/^(?:19|20)\d\d[ \-](?:19|20)\d\d$/u.test(value)) return;
      }
      add("phone", match.index, match.index + value.length);
    });
  }

  function dates(text, add) {
    DATES.forEach((pattern, index) => each(pattern, text, (match) => {
      if (index === 3) {
        const first = Number(match[1]);
        const second = Number(match[3]);
        if (first < 1 || second < 1 || first > 31 || second > 31 || (first > 12 && second > 12)) return;
      }
      add("date", match.index, match.index + match[0].length);
    }));
    each(DAY, text, (match) => add("day", match.index, match.index + match[0].length));
  }

  function times(text, add) {
    for (const pattern of TIMES) each(pattern, text, (match) => add("time", match.index, match.index + match[0].length));
  }

  function amounts(text, add) {
    for (const pattern of AMOUNTS) each(pattern, text, (match) => add("amount", match.index, match.index + match[0].length));
  }

  function numbers(text, add) {
    each(HASH_ID, text, (match) => {
      if (digitCount(match[0]) >= 3) add("number", match.index, match.index + match[0].length);
    });
    each(TOKEN, text, (match) => {
      const value = match[0];
      const before = text[match.index - 1] || "";
      const after = text.slice(match.index + value.length, match.index + value.length + 2);
      // Part of a link, an address, a decimal or a hashtag, not a token of its own.
      if (/[#@.\/\\:_\-]/u.test(before) || /^[@.\/\\:_\-][\p{L}\p{N}]/u.test(after)) return;
      const runs = value.match(/\d+/g) || [];
      // A year (2026, FY2026, Q4-2026) is not an order number.
      const id = runs.some((run) => run.length >= 5)
        || (/\p{L}/u.test(value) && runs.some((run) => run.length === 4 && !/^(?:19|20)\d\d$/u.test(run)));
      if (id) add("number", match.index, match.index + value.length);
    });
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
  }

  /** Later mentions of a greeting name ("Thanks again, Sam") share its blank. */
  function repeatedNames(text, candidates, add) {
    const names = new Set(candidates.filter((candidate) => candidate.kind === "name").map((candidate) => candidate.value));
    for (const name of names) {
      if (name.length < 2) continue;
      const pattern = new RegExp(String.raw`(?<![\p{L}\p{M}\p{N}])${escapeRegExp(name)}(?![\p{L}\p{M}\p{N}])`, "gu");
      each(pattern, text, (match) => add("repeat", match.index, match.index + match[0].length));
    }
  }

  /**
   * Starts at which a blank cannot be written so that the rest renders back
   * literally: right after "\" (it would escape the blank), right after "[" (it
   * would join the blank's "[["), or after a "[[" with no "]]" before the
   * blank (the renderer would read up to the blank's "]]").
   */
  function unsafeStart(text) {
    const open = [];
    for (let at = text.indexOf("[["); at >= 0; at = text.indexOf("[[", at + 1)) {
      const close = text.indexOf("]]", at + 2);
      open.push([at + 2, close < 0 ? Infinity : close + 1]);
    }
    return (start) => text[start - 1] === "\\" || text[start - 1] === "["
      || open.some(([from, to]) => start >= from && start <= to);
  }

  /**
   * Values in a draft that would change from one use to the next.
   *
   * Kinds: "name" (the person after Hi, Hello, Hey, Dear, Good morning/
   * afternoon/evening at the start of a line, and later mentions of that
   * name), "email", "link", "phone", "date", "day" (a weekday on its own),
   * "time", "amount", "number" (#12345, INV-20481, 12345). Nothing at or after
   * the writer's sign-off is a blank. Spans never overlap and come in reading
   * order. The same value of a kind always gets the same name; each different
   * value gets the next number (date, date2, date3).
   *
   * @param {string} text
   * @returns {Array<{start: number, end: number, value: string, kind: string, name: string}>}
   */
  function findBlanks(text) {
    const source = asText(text);
    const limit = signoffStart(source);
    const unsafe = unsafeStart(source);
    const candidates = [];
    const add = (kind, start, end) => {
      if (end <= start || start >= limit || end > limit || unsafe(start)) return;
      candidates.push({ start, end, value: source.slice(start, end), kind: kind === "repeat" ? "name" : kind, priority: PRIORITY[kind] });
    };
    greetingNames(source, add);
    emails(source, add);
    links(source, add);
    phones(source, add);
    dates(source, add);
    times(source, add);
    amounts(source, add);
    numbers(source, add);
    repeatedNames(source, candidates.slice(), add);

    candidates.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);
    const chosen = [];
    let end = 0;
    for (const candidate of candidates) {
      if (candidate.start < end) continue;
      chosen.push(candidate);
      end = candidate.end;
    }

    const names = new Map();
    const used = new Map();
    return chosen.map(({ start, end, value, kind }) => {
      const key = kind + "\u0000" + value;
      if (!names.has(key)) {
        const count = (used.get(kind) || 0) + 1;
        used.set(kind, count);
        names.set(key, count === 1 ? kind : kind + count);
      }
      return { start, end, value, kind, name: names.get(key) };
    });
  }

  function wrapBraces(text) {
    return text.replace(BRACE_TOKEN, "{$&}");
  }

  /** Write literal text so that actle renders it back unchanged. */
  function escapeLiteral(text, beforeBlank) {
    let out = "";
    let at = 0;
    while (at < text.length) {
      const escaped = text.startsWith("\\[[", at);
      const open = escaped ? at + 1 : at;
      if (text.startsWith("[[", open)) {
        const close = text.indexOf("]]", open + 2);
        if (close < 0) {
          if (beforeBlank) throw new RangeError("A blank cannot follow an unclosed \"[[\".");
          return out + wrapBraces(text.slice(at));
        }
        const body = text.slice(open + 2, close);
        const chunk = wrapBraces(text.slice(at, close + 2));
        out += !body.trim() || /[\[\]\r\n]/.test(body) ? chunk : "\\" + chunk;
        at = close + 2;
        continue;
      }
      BRACE_TOKEN_AT.lastIndex = at;
      const token = BRACE_TOKEN_AT.exec(text);
      if (token) {
        out += "{" + token[0] + "}";
        at += token[0].length;
        continue;
      }
      out += text[at++];
    }
    return out;
  }

  /**
   * The draft as an expansion with the chosen spans as [[name]] blanks.
   * Everything else is escaped, so rendering the result with each blank
   * answered by its original value gives back exactly the draft; with no spans
   * chosen it is a plain expansion that inserts the draft as written.
   *
   * Throws RangeError for spans that overlap, fall outside the text, have a
   * name actle cannot use as a blank (empty, or containing [ ] or a line
   * break), or start where findBlanks never offers one (see unsafeStart).
   *
   * @param {string} text
   * @param {Array<{start: number, end: number, name: string}>} chosen
   * @returns {string}
   */
  function buildTemplate(text, chosen) {
    const source = asText(text);
    const spans = (Array.isArray(chosen) ? chosen : []).map((span) => {
      const start = span && span.start;
      const end = span && span.end;
      const name = asText(span && span.name);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > source.length || start >= end) {
        throw new RangeError("A blank must cover part of the draft.");
      }
      if (!name.trim() || /[\[\]\r\n]/.test(name)) {
        throw new RangeError("A blank name cannot be empty or contain brackets or line breaks.");
      }
      return { start, end, name };
    }).sort((a, b) => a.start - b.start);

    let out = "";
    let at = 0;
    for (const span of spans) {
      if (span.start < at) throw new RangeError("Blanks cannot overlap.");
      const before = source.slice(at, span.start);
      if (/[\\[]$/.test(before)) throw new RangeError("A blank cannot follow \"\\\" or \"[\".");
      out += escapeLiteral(before, true) + "[[" + span.name + "]]";
      at = span.end;
    }
    return out + escapeLiteral(source.slice(at), false);
  }

  return { findBlanks, buildTemplate };
});
