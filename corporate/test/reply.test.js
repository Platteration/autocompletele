const test = require("node:test");
const assert = require("node:assert/strict");
const reply = require("../core/reply.js");

const POLICY = {
  max: 3,
  dateOrder: "dmy",
  extract: {
    customer: { after: "Customer ID" },
    parcel: { pattern: "parcel\\s+(\\d{10,})", group: 1 },
    bad: { pattern: "(" },
    toomany: { pattern: "x(y)", group: 2 },
    both: { pattern: "a", after: "b" },
    neither: {},
    "[[x]]": { after: "x" },
    junk: 7,
  },
  replies: [
    { id: "late", label: "Late delivery", keywords: ["not arrived", "late", "delayed"], text: "Dear [[firstName]],\n\nI am sorry order [[order]] is late. {cursor}\n\nBest regards" },
    { id: "refund", keywords: ["refund", "money back"], match: "all", text: "Hello [[name]], your refund of [[amount]] for [[order]] is on its way ([[iban]])." },
    { id: "ack", keywords: ["ticket"], shorthand: "ack/" },
    { id: "late", keywords: ["late"], text: "Duplicate id [[order]]" },
    { id: "ghost", keywords: ["ticket"], shorthand: "nope/" },
    { id: "nokw", text: "x" },
    { id: "twobodies", keywords: ["a"], text: "x", shorthand: "y/" },
    { id: "nobody", keywords: ["a"] },
    { id: "oddmatch", keywords: ["parcel"], match: "ALL", text: "Parcel [[parcel]] for [[customer]]", extract: { customer: { pattern: "Account\\s+(\\S+)", group: 1 }, oops: { pattern: "[" } } },
    "junk",
  ],
};
const LIBRARY = [{ trigger: "ack/", expansion: "Thanks [[name]], ticket [[reference]] is with us ({date})." }, { trigger: "", expansion: "dropped" }];
const config = reply.normalizeReplies(POLICY);

const MESSAGE = [
  "Hi Sam,",
  "",
  "My order #A-55120 placed on 3 October 2026 has still not arrived. I paid €120.50 and ticket TKT-90211 is open.",
  "Customer ID: C-778",
  "",
  "Kind regards,",
  "Jane Doe",
  "",
  "On Mon, Oct 1, 2026 Sam wrote:",
  "> Your refund for order 99999 of $5 is late.",
].join("\n");

test("normalizeReplies keeps usable parts and explains what it dropped", () => {
  assert.deepEqual(config.replies.map((r) => r.id), ["late", "refund", "ack", "late-dup", "ghost", "oddmatch"]);
  assert.deepEqual(Object.keys(config.extract), ["customer", "parcel"]);
  assert.equal(config.extract.parcel.group, 1);
  assert.equal(config.replies[0].label, "Late delivery");
  assert.equal(config.replies[1].label, "refund");
  assert.equal(config.replies[1].match, "all");
  assert.equal(config.replies[2].text, null);
  assert.equal(config.replies[2].shorthand, "ack/");
  assert.equal(config.replies[5].match, "any", "an unknown match falls back to any");
  assert.deepEqual(Object.keys(config.replies[5].extract), ["customer"]);
  const text = config.warnings.join("\n");
  for (const expected of [/extractor bad ignored: invalid pattern/, /extractor toomany ignored: group must be a whole number from 0 to 1/,
    /extractor both ignored: needs exactly one/, /extractor neither ignored: needs exactly one/, /extractor "\[\[x\]\]" ignored: not a usable blank name/,
    /extractor junk ignored: not an object/, /reply nokw ignored: no keywords/, /reply twobodies ignored: needs exactly one of `text` or `shorthand`/,
    /reply nobody ignored: needs exactly one/, /reply oddmatch: match must be any or all; using any/, /reply oddmatch extractor oops ignored: invalid pattern/,
    /reply 9 ignored: not an object/]) {
    assert.match(text, expected);
  }
  assert.equal(config.warnings.length, 12);
  assert.deepEqual(reply.normalizeReplies(undefined), { replies: [], extract: {}, max: 3, dateOrder: "dmy", warnings: [] });
  assert.match(reply.normalizeReplies("nope").warnings[0], /reply section ignored: not an object/);
  assert.match(reply.normalizeReplies({ replies: {} }).warnings[0], /replies ignored: not a list/);
  assert.match(reply.normalizeReplies({ extract: [] }).warnings[0], /extract ignored: not an object/);
  const limits = reply.normalizeReplies({ max: 0, dateOrder: "ymd" });
  assert.equal(limits.max, 3);
  assert.equal(limits.dateOrder, "dmy");
  assert.deepEqual(limits.warnings.map((w) => w.split(" ")[1]), ["max", "dateOrder"]);
  assert.equal(reply.normalizeReplies({ max: 10 }).max, 10);
  assert.equal(reply.normalizeReplies({ max: 11 }).warnings.length, 1);
  assert.equal(reply.normalizeReplies({ extract: { order: "ORD-(\\d+)" } }).extract.order.pattern, "ORD-(\\d+)", "a bare string is a pattern");
});

test("ownPart drops quoted lines and the thread below a reply header", () => {
  assert.equal(reply.ownPart("Thanks!\n> old text\nMore\n-----Original Message-----\nFrom: x"), "Thanks!\nMore");
  assert.equal(reply.ownPart("Hello\r\nOn Tue, 2 Oct 2026, Ann wrote:\r\nold"), "Hello");
  assert.equal(reply.ownPart(null), "");
  assert.equal(reply.ownPart("x".repeat(reply.DEFAULTS.maxChars + 5)).length, reply.DEFAULTS.maxChars);
});

test("extractValues finds each built-in kind in the latest message only", () => {
  const values = reply.extractValues(MESSAGE, config.extract);
  assert.deepEqual(values, {
    greeted: "Sam",
    name: "Jane Doe",
    firstName: "Jane",
    order: "A-55120",
    reference: "TKT-90211",
    date: "2026-10-03",
    amount: "€120.50",
    customer: "C-778",
  });
  for (const key of Object.keys(values)) assert.ok(reply.BUILTIN_VALUES.includes(key) || key === "customer", key);
});

test("extractValues: names, references, dates and amounts in other spellings", () => {
  const get = (text, extractors, options) => reply.extractValues(text, extractors, options);
  assert.equal(get("Thanks, Priya").name, "Priya", "sign-off and name on one line");
  assert.equal(get("Hello team,\nplease help.\nCheers\nBo Li").greeted, undefined, "a lowercase greeting word is not a name");
  assert.equal(get("Hello team,\nplease help.\nCheers\nBo Li").name, "Bo Li");
  assert.equal(get("Hi Ana, quick question").greeted, "Ana", "greeting and text on one line");
  assert.equal(get("Thanks for your help with this").name, undefined, "a thank-you sentence is not a sign-off");
  assert.equal(get("Order no. 55120 is wrong").order, "55120");
  assert.equal(get("order number: ORD-0042-B arrived").order, "ORD-0042-B");
  assert.equal(get("I ordered 3 items, order 3 is wrong").order, undefined, "fewer than three digits is not a reference");
  assert.equal(get("Re case #778812").reference, "778812");
  assert.equal(get("I asked for a refund 220 times").reference, undefined, "refund is not ref");
  assert.equal(get("Invoice INV-2026-0099 attached").reference, "INV-2026-0099");
  assert.equal(get("due 3/4/2026").date, "2026-04-03");
  assert.equal(get("due 3/4/2026", null, { dateOrder: "mdy" }).date, "2026-03-04");
  assert.equal(get("charged 1,299.00 EUR twice").amount, "1,299.00 EUR");
  assert.equal(get("charged USD 45 and then $10").amount, "USD 45", "the first amount wins");
  assert.equal(get("charged 45 dollars").amount, undefined, "a number without a currency is not an amount");
  assert.deepEqual(get(""), {});
});

test("policy extractors: pattern with group, after a label, and they win over built-ins", () => {
  const extract = reply.normalizeReplies({
    extract: { parcel: { pattern: "parcel\\s+(\\d{10,})", group: 1 }, whole: { pattern: "PO-\\d+" }, account: { after: "Account" }, name: { pattern: "Dear ([^,]+),", group: 1 }, order: { pattern: "zzz(\\d+)", group: 1 } },
  }).extract;
  const values = reply.extractValues("Dear Ms Ito,\nParcel 1234567890 for PO-77.\nAccount:\nAccount # K-9 \norder 123456\nBest, Ken Ito", extract);
  assert.equal(values.parcel, "1234567890");
  assert.equal(values.whole, "PO-77", "group 0 is the whole match");
  assert.equal(values.account, "K-9", "an empty label line is skipped for the next one");
  assert.equal(values.name, "Ms Ito", "a policy extractor replaces the built-in when it finds a value");
  assert.equal(values.order, "123456", "the built-in stays when the policy extractor finds nothing");
  assert.equal(values.firstName, "Ken", "firstName still comes from the built-in sign-off");
});

test("rank orders by keyword hits, keeps policy order on ties and fills blanks", () => {
  const text = "Hi, my parcel is delayed and still not arrived. Ticket 445566.\nBest, Lea Roth";
  const ranked = reply.rank(text, config, LIBRARY, { now: new Date(2026, 9, 21) });
  assert.deepEqual(ranked.map((c) => [c.reply.id, c.score]), [["late", 2], ["ack", 1], ["oddmatch", 1]]);
  assert.deepEqual(ranked[0].matched, ["not arrived", "delayed"]);
  assert.equal(ranked[0].text, "Dear Lea,\n\nI am sorry order [[order]] is late. \n\nBest regards", "{cursor} is rendered, an unknown blank stays");
  assert.equal(ranked[0].cursorOffset, "Dear Lea,\n\nI am sorry order [[order]] is late. ".length);
  assert.deepEqual(ranked[0].missing, ["order"]);
  assert.deepEqual(ranked[0].values, { firstName: "Lea" });
  assert.equal(ranked[1].body, LIBRARY[0].expansion, "the body of a shorthand reply comes from the library");
  assert.equal(ranked[1].text, "Thanks Lea Roth, ticket 445566 is with us (2026-10-21).");
  assert.deepEqual(ranked[1].missing, []);
  assert.deepEqual(reply.rank(text, config, LIBRARY, { max: 1 }).map((c) => c.reply.id), ["late"]);
  const two = reply.normalizeReplies(Object.assign({}, POLICY, { max: 2 }));
  assert.equal(reply.rank(text, two, LIBRARY).length, 2);
  assert.deepEqual(reply.rank("", config, LIBRARY), []);
  assert.deepEqual(reply.rank(text, reply.normalizeReplies({}), LIBRARY), []);
});

test("rank: match all needs every keyword, any needs one", () => {
  const ids = (text) => reply.rank(text, config, LIBRARY).map((c) => c.reply.id);
  assert.deepEqual(ids("I want a refund please"), [], "refund alone is not enough for match: all");
  assert.deepEqual(ids("I want a refund, give me my money back"), ["refund"]);
  assert.deepEqual(ids("It is LATE again"), ["late", "late-dup"], "any: one keyword, case-insensitive");
  assert.deepEqual(ids("Lateness is a word"), [], "keywords match whole words only");
});

test("rank fills from the latest message, per-reply extractors and missing blanks", () => {
  const ranked = reply.rank("Refund please, money back for order 4455 (€9.99).\nAccount ZX-1 parcel 9876543210\n\nThanks,\nOla", config, LIBRARY);
  const refund = ranked.find((c) => c.reply.id === "refund");
  assert.equal(refund.text, "Hello Ola, your refund of €9.99 for 4455 is on its way ([[iban]]).");
  assert.deepEqual(refund.missing, ["iban"]);
  const parcel = ranked.find((c) => c.reply.id === "oddmatch");
  assert.equal(parcel.text, "Parcel 9876543210 for ZX-1", "a reply's own extractor wins over the shared one of the same name");
  const quoted = reply.rank("Thanks.\n> my order 99999 is late", config, LIBRARY);
  assert.deepEqual(quoted, [], "keywords in quoted history do not pick a reply");
});

test("values from the message stay literal: no placeholders or blanks smuggled in", () => {
  const cfg = reply.normalizeReplies({ extract: { note: { after: "Note" } }, replies: [{ id: "n", keywords: ["note"], text: "Re: [[note]] [[other]]" }] });
  const [candidate] = reply.rank("Note: {clipboard} [[other]] {cursor}", cfg, []);
  assert.equal(candidate.text, "Re: {clipboard} [[other]] {cursor} [[other]]");
  assert.deepEqual(candidate.missing, ["other"]);
});

test("shorthand replies: found in the library, skipped and reported when not", () => {
  assert.deepEqual(reply.checkLibrary(config, LIBRARY), ["reply ghost skipped: shorthand nope/ is not in the library"]);
  assert.deepEqual(reply.checkLibrary(config, []).length, 2);
  assert.deepEqual(reply.checkLibrary(null, LIBRARY), []);
  const ids = reply.rank("About ticket 123456", config, LIBRARY).map((c) => c.reply.id);
  assert.deepEqual(ids, ["ack"], "ghost matches but has no body, so it is not offered");
  assert.deepEqual(reply.rank("About ticket 123456", config, null), [], "no library: shorthand replies are skipped, not thrown on");
});

test("stats count offered, inserted and edited per reply without mutating the input", () => {
  let stats = reply.recordStat({}, "late", "offered");
  stats = reply.recordStat(stats, "late", "offered");
  stats = reply.recordStat(stats, "late", "inserted");
  stats = reply.recordStat(stats, "late", "edited");
  stats = reply.recordStat(stats, "ack", "offered");
  assert.deepEqual(stats, { late: { offered: 2, inserted: 1, editedBeforeSend: 1 }, ack: { offered: 1, inserted: 0, editedBeforeSend: 0 } });
  const frozen = Object.freeze({ late: Object.freeze({ offered: 1, inserted: 0, editedBeforeSend: 0 }) });
  assert.equal(reply.recordStat(frozen, "late", "offered").late.offered, 2);
  assert.equal(frozen.late.offered, 1);
  assert.deepEqual(reply.recordStat(stats, "late", "sent"), stats, "an unknown event changes nothing");
  assert.deepEqual(reply.recordStat(stats, " ", "offered"), stats, "an empty id changes nothing");
  assert.deepEqual(reply.normalizeStats({ a: { offered: "3", inserted: -1, editedBeforeSend: 1.5, extra: 9 }, b: null, "": {} }),
    { a: { offered: 3, inserted: 0, editedBeforeSend: 0 }, b: { offered: 0, inserted: 0, editedBeforeSend: 0 } });
  assert.deepEqual(reply.normalizeStats("nope"), {});
  const proto = reply.recordStat({}, "__proto__", "offered");
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.deepEqual(Object.keys(proto), ["__proto__"]);
});
