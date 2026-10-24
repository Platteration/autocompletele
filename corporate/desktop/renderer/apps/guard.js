// gactle: dashboard tab. The organisation's rule packs, the internal
// domains and codes, the counts of warnings raised, fixed, dismissed and left
// unanswered (from the audit trail, which holds rule ids and outcomes only),
// and a "Try it" box that runs the same check on a text with recipients and
// an application typed in, without counting or auditing anything.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  // Kept across renders: the section is rebuilt on every change event.
  let draft = "";
  let recipientsDraft = "";
  let appDraft = "";
  let tried = null;

  function whenOf(rule) {
    const parts = [];
    if (rule.detect.length) parts.push("detects " + rule.detect.join(", ") + (rule.countries.length ? " (" + rule.countries.join(", ") + ")" : "") + (rule.phrases.length ? ": " + rule.phrases.join(", ") : ""));
    if (rule.keywords.length) parts.push((rule.match === "all" ? "all of " : "") + rule.keywords.join(", ") + (rule.caseSensitive ? " (case-sensitive)" : ""));
    if (rule.unless.length) parts.push("unless: " + rule.unless.join(" | "));
    if (rule.apps.length) parts.push("in " + rule.apps.join(", "));
    return parts.join("; ");
  }

  function fixOf(fix, helpers) {
    if (!fix) return "none";
    if (fix.kind === "text") return "add text" + (fix.position === "start" ? " at the start (to the clipboard)" : "") + ": " + helpers.preview(fix.text);
    if (fix.kind === "shorthand") return "insert shortcut " + fix.trigger;
    return (fix.with ? "replace with " + fix.with : "remove") + " (to the clipboard)";
  }

  function renderHits(helpers, result) {
    const { el } = helpers;
    if (!result) return [];
    if (!result.hits.length) return [el("p", { class: "hint", text: "No rule fires on this text" + (result.recipients ? " for these recipients" : "") + (result.app ? " in " + result.app : "") + "." })];
    return result.hits.map((hit) => el("div", { class: "candidate" }, [
      el("div", { class: "meta", text: hit.pack + " / " + hit.rule + " (" + hit.severity + ")" + (hit.fix ? "; fix: " + hit.fix.kind : "") }),
      el("div", { text: hit.message }),
      el("div", { class: "hint mono", text: hit.findings.length ? "Found " + hit.findings.map((f) => f.kind + (f.country ? " " + f.country : "") + ": " + f.value).join("; ") : "" }),
    ]));
  }

  function countsRow(helpers, label, row) {
    const { el } = helpers;
    return el("tr", {}, [el("td", { text: label }), ...["raised", "accepted", "dismissed", "unanswered"].map((key) => el("td", { class: "num", text: String(row[key]) }))]);
  }

  window.actleApps.guard = {
    async render(section, helpers) {
      const { api, el, announce } = helpers;
      const info = await api.invoke("guard:info");
      section.textContent = "";
      if (!info || info.ok === false) {
        section.append(el("p", { class: "hint", text: "gactle is not available: " + ((info && info.error) || "no answer from the app.") }));
        return;
      }
      section.append(el("h2", { text: "gactle: compliance warnings" }));
      section.append(el("p", { class: "hint", text: "While you write, the text of the current field (what was typed or inserted since it got the focus, up to 4,000 characters, held in memory only) is checked against the organisation's rule packs when a word ends. A rule that fires shows a warning with its findings masked and, where the rule has one, a fix. Recipients cannot be read, so rules for outside recipients " + (info.assumeExternal ? "treat every message as going outside (assumeExternal)." : "stay silent unless the policy sets assumeExternal.") + " Only rule ids and outcomes are recorded; nothing you typed is." }));
      if (info.paused) section.append(el("div", { class: "banner" }, [el("div", { text: "Paused by your organisation: nothing is checked." })]));
      if (info.warnings.length) section.append(el("div", { class: "banner" }, info.warnings.map((warning) => el("div", { text: warning }))));

      section.append(el("h2", { text: "Packs and rules" }));
      if (!info.configured) section.append(el("p", { class: "hint", text: "The organisation policy has no rule packs (section \"guard\")." }));
      const rows = info.packs.flatMap((pack) => pack.rules.map((rule) => el("tr", {}, [
        el("td", {}, [el("div", { text: pack.label }), el("div", { class: "hint mono", text: pack.id })]),
        el("td", {}, [el("div", { text: rule.label }), el("div", { class: "hint mono", text: rule.id })]),
        el("td", { text: rule.severity }),
        el("td", { text: whenOf(rule) }),
        el("td", { text: rule.recipients === "external" ? "outside only" : "any" }),
        el("td", { text: fixOf(rule.fix, helpers) }),
      ])));
      section.append(el("table", {}, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Pack" }), el("th", { text: "Rule" }), el("th", { text: "Severity" }), el("th", { text: "When" }), el("th", { text: "Recipients" }), el("th", { text: "Fix" })])]),
        el("tbody", {}, rows),
      ]));
      section.append(el("p", { class: "hint mt", text: "Internal domains: " + (info.internalDomains.join(", ") || "none") + ". Internal code patterns: " + (info.internalCodes.join("  ") || "none") + ". Detectors available: " + info.detectors.join(", ") + "; national IDs for " + info.countries.join(", ") + ". A severity is a label: nothing is blocked." }));

      section.append(el("h2", { class: "mt", text: "Warnings so far" }));
      const counts = await api.invoke("guard:summary");
      const summary = counts && counts.summary;
      if (!summary || !counts.entries) section.append(el("p", { class: "hint", text: "No warnings recorded yet." }));
      else {
        const head = el("thead", {}, [el("tr", {}, [el("th", { text: "" }), el("th", { class: "num", text: "Raised" }), el("th", { class: "num", text: "Fixed" }), el("th", { class: "num", text: "Dismissed" }), el("th", { class: "num", text: "Unanswered" })])]);
        const body = [countsRow(helpers, "All rules", summary.total)];
        for (const row of summary.byPack) body.push(countsRow(helpers, "Pack " + row.pack, row));
        for (const row of summary.byRule) body.push(countsRow(helpers, row.pack + " / " + row.rule, row));
        section.append(el("table", {}, [head, el("tbody", {}, body)]));
        section.append(el("p", { class: "hint", text: "Unanswered: the warning's window was replaced by a later warning or offer, or closed without Fix or Dismiss. " + (summary.skipped ? summary.skipped + " unreadable audit line(s) skipped." : "") }));
      }

      section.append(el("h2", { class: "mt", text: "Try it" }));
      section.append(el("p", { class: "hint", text: "Paste a text and, optionally, recipients (comma-separated) and an application to see which rules would fire and what they report. Rules limited to applications fire only when the application is given. Nothing is counted, audited or inserted." }));
      const box = el("textarea", { rows: "5", "aria-label": "Text to check" });
      box.value = draft;
      box.addEventListener("input", () => { draft = box.value; });
      const recipients = el("input", { type: "text", placeholder: "Recipients, e.g. buyer@customer.test", "aria-label": "Recipients" });
      recipients.value = recipientsDraft;
      recipients.addEventListener("input", () => { recipientsDraft = recipients.value; });
      const application = el("input", { type: "text", placeholder: "Application, e.g. outlook (optional)", "aria-label": "Application" });
      application.value = appDraft;
      application.addEventListener("input", () => { appDraft = application.value; });
      const results = el("div", {}, renderHits(helpers, tried));
      const run = el("button", { class: "primary", text: "Check" });
      run.addEventListener("click", async () => {
        const result = await api.invoke("guard:check", { text: box.value, recipients: recipients.value, app: application.value });
        tried = result && Array.isArray(result.hits) ? result : null;
        results.textContent = "";
        for (const node of renderHits(helpers, tried)) results.append(node);
        announce(tried && tried.hits.length ? tried.hits.length + " rule" + (tried.hits.length === 1 ? " fires" : "s fire") : "No rule fires");
      });
      section.append(el("label", {}, [box]), el("div", { class: "row mb" }, [recipients, application, run]), results);
    },
  };
})();
