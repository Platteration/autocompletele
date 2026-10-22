// actle Forms: dashboard tab. The organisation's records, lookup lists and
// forms, the person's own records with Delete, the proposals learned from
// stored fills with Accept and Dismiss, the window last focused and the form
// it matched, a "Try a lookup" box, and the stored fills with Clear.
"use strict";

(function () {
  window.actleApps = window.actleApps || {};
  // Kept across renders: the section is rebuilt on every change event.
  let lookupDraft = "";
  let lookupResult = null;
  const triggerDrafts = {};
  const labelDrafts = {};
  // The section last rendered: a change that touches nothing shown here (a metrics entry, a library edit) keeps it as it is.
  let rendered = null;
  const WATCHED = ["apps", "settings", "policy", "context", "status"];

  function concerns(change) {
    const keys = change && typeof change === "object" ? Object.keys(change).filter((key) => change[key]) : [];
    return !keys.length || keys.some((key) => WATCHED.includes(key));
  }

  function fieldsText(fields, helpers) {
    return helpers.preview(Object.entries(fields).map(([name, value]) => name + " = " + value).join("; "));
  }

  function matchText(match) {
    const parts = [];
    if (match.process.length) parts.push("process " + match.process.join(", "));
    if (match.title) parts.push("title matches /" + match.title + "/");
    return parts.join("; ");
  }

  function recordRows(records, helpers, onDelete) {
    const { el } = helpers;
    return records.map((record) => {
      const cells = [
        el("td", {}, [el("div", { text: record.label }), el("div", { class: "hint mono", text: record.id })]),
        el("td", { class: "mono", text: record.trigger || "(palette only)" }),
        el("td", { text: fieldsText(record.fields, helpers) }),
        el("td", { class: "mono", text: record.blanks.join(", ") }),
      ];
      if (onDelete) {
        const remove = el("button", { class: "plain danger", text: "Delete" });
        remove.addEventListener("click", () => onDelete(record));
        cells.push(el("td", {}, [remove]));
      }
      return el("tr", {}, cells);
    });
  }

  function recordTable(records, helpers, onDelete) {
    const { el } = helpers;
    const head = [el("th", { text: "Record" }), el("th", { text: "Trigger" }), el("th", { text: "Fields" }), el("th", { text: "Blanks" })];
    if (onDelete) head.push(el("th", { text: "" }));
    return el("table", {}, [el("thead", {}, [el("tr", {}, head)]), el("tbody", {}, recordRows(records, helpers, onDelete))]);
  }

  function renderLookupResult(helpers) {
    const { el } = helpers;
    if (!lookupResult) return el("p", { class: "hint", text: lookupDraft.trim() ? "No lookup row matches." : "" });
    const hit = lookupResult;
    return el("p", { class: "hint", text: "Row " + hit.key + " in " + hit.lookup + " (" + (hit.via === "pattern" ? "found by its key pattern" : "exact key") + "): " + Object.entries(hit.row).map(([name, value]) => name + " = " + value).join("; ") });
  }

  function proposalCard(proposal, helpers) {
    const { api, el, announce } = helpers;
    const card = el("div", { class: "candidate" }, [
      el("div", { class: "meta", text: proposal.label + ": " + proposal.count + " fills on form " + proposal.form + "; constant: " + proposal.constant.join(", ") + (proposal.templated.length ? "; as a template: " + proposal.templated.join(", ") : "") }),
      el("div", { class: "overlay", text: Object.entries(proposal.fields).map(([name, value]) => name + " = " + value).join("\n") }),
    ]);
    // The proposal's label is neutral ("Learned record 1 on …"); the person may name the record, and an empty name keeps the neutral one.
    const label = el("input", { type: "text", "aria-label": "Name for this record", placeholder: proposal.label });
    label.value = Object.hasOwn(labelDrafts, proposal.digest) ? labelDrafts[proposal.digest] : proposal.label;
    label.addEventListener("input", () => { labelDrafts[proposal.digest] = label.value; });
    const trigger = el("input", { type: "text", "aria-label": "Trigger for this record", placeholder: "trigger to type, e.g. refund2/" });
    trigger.value = triggerDrafts[proposal.digest] || "";
    trigger.addEventListener("input", () => { triggerDrafts[proposal.digest] = trigger.value; });
    const accept = el("button", { class: "primary", text: "Accept as my record" });
    accept.addEventListener("click", async () => {
      const result = await api.invoke("forms:acceptProposal", { digest: proposal.digest, trigger: trigger.value, label: label.value });
      if (result && result.ok) {
        delete triggerDrafts[proposal.digest];
        delete labelDrafts[proposal.digest];
        announce("Saved " + result.record.label + " with trigger " + result.record.trigger);
      } else announce((result && result.error) || "Could not save the record");
    });
    const dismiss = el("button", { class: "plain", text: "Dismiss" });
    dismiss.addEventListener("click", async () => {
      const result = await api.invoke("forms:dismissProposal", { digest: proposal.digest });
      announce(result && result.ok ? "Dismissed" : (result && result.error) || "Could not dismiss the proposal");
    });
    card.append(el("div", { class: "row" }, [label, trigger, accept, dismiss]));
    return card;
  }

  /** A lookup's first rows, one per line, with how many the tab does not show. */
  function lookupRows(lookup, helpers) {
    const { el } = helpers;
    const lines = lookup.rows.map((row) => el("div", { text: row[lookup.key] + ": " + Object.entries(row).filter(([name]) => name !== lookup.key).map(([name, value]) => name + " = " + value).join(", ") }));
    if (lookup.rowCount > lookup.rows.length) lines.push(el("div", { class: "hint", text: "… " + (lookup.rowCount - lookup.rows.length) + " more" }));
    return el("td", {}, lines);
  }

  window.actleApps.forms = {
    async render(section, helpers, change) {
      const { api, el, announce } = helpers;
      if (section === rendered && !concerns(change)) return;
      const info = await api.invoke("forms:info");
      rendered = section;
      section.textContent = "";
      if (!info || info.ok === false) {
        section.append(el("p", { class: "hint", text: "Forms is not available: " + ((info && info.error) || "no answer from the app.") }));
        return;
      }
      section.append(el("p", { class: "hint", text: "Put the caret in the first field of a form and type a record's trigger, or pick the record in the search palette. The popover shows the form matched to the focused window, fills the customer fields from a lookup list when a reference is copied or typed, asks for the blanks still open, and types the values in Tab order with a Tab for every field passed over. " + info.notes.selectors + " " + info.notes.noForm }));
      if (info.paused) section.append(el("div", { class: "banner" }, [el("div", { text: "Paused by your organisation: no record is offered." })]));
      if (info.warnings.length) section.append(el("div", { class: "banner" }, info.warnings.map((warning) => el("div", { text: warning }))));
      const where = info.context.process ? info.context.process + (info.context.title ? " “" + info.context.title + "”" : "") : "none yet";
      section.append(el("p", { class: "hint", text: "Last focused window: " + where + ". " + (info.context.form ? "Form matched: " + info.context.form.label + "." : "No form matched.") }));

      section.append(el("h2", { text: "Records" }));
      if (!info.records.length) section.append(el("p", { class: "hint", text: "The organisation policy has no form records (section \"forms\")." }));
      else section.append(recordTable(info.records, helpers, null));

      section.append(el("h2", { class: "mt", text: "Your records" }));
      if (!info.ownRecords.length) section.append(el("p", { class: "hint", text: "None yet. Accept a learned proposal below to keep it as a record of your own; it lives on this desk only." }));
      else {
        section.append(recordTable(info.ownRecords, helpers, async (record) => {
          const result = await api.invoke("forms:deleteOwnRecord", { id: record.id });
          announce(result && result.ok ? "Deleted " + record.label : (result && result.error) || "Could not delete the record");
        }));
      }

      section.append(el("h2", { class: "mt", text: "Learned from your fills" }));
      section.append(el("p", { class: "hint", text: "Fields filled together in at least " + info.learning.minCount + " fills of one form (" + info.learning.minFields + " or more constant fields) are proposed as a record; text that differs from fill to fill becomes a blank. Fills are stored only when a form matched; a dismissed proposal is remembered by a digest." }));
      if (!info.proposals.length) section.append(el("p", { class: "hint", text: "No proposals yet." }));
      for (const proposal of info.proposals) section.append(proposalCard(proposal, helpers));

      section.append(el("h2", { class: "mt", text: "Lookups" }));
      if (!info.lookups.length) section.append(el("p", { class: "hint", text: "No lookup lists in the policy." }));
      else {
        section.append(el("table", {}, [
          el("thead", {}, [el("tr", {}, [el("th", { text: "Lookup" }), el("th", { text: "Key column" }), el("th", { text: "Key pattern" }), el("th", { class: "num", text: "Rows" }), el("th", { text: "First rows" })])]),
          el("tbody", {}, info.lookups.map((lookup) => el("tr", {}, [
            el("td", { class: "mono", text: lookup.id }),
            el("td", { class: "mono", text: lookup.key }),
            el("td", { class: "mono", text: lookup.keyPattern || "" }),
            el("td", { class: "num", text: String(lookup.rowCount) }),
            lookupRows(lookup, helpers),
          ]))),
        ]));
      }
      section.append(el("h2", { class: "mt", text: "Try a lookup" }));
      section.append(el("p", { class: "hint", text: "Paste a reference, or any text that contains one, to see which row would fill the form. Nothing is counted or inserted." }));
      const box = el("input", { type: "text", "aria-label": "Reference or text to look up" });
      box.value = lookupDraft;
      box.addEventListener("input", () => { lookupDraft = box.value; });
      const run = el("button", { class: "primary", text: "Look up" });
      let shown = renderLookupResult(helpers);
      run.addEventListener("click", async () => {
        const result = await api.invoke("forms:lookup", { text: box.value });
        lookupResult = result && result.hit ? result.hit : null;
        const next = renderLookupResult(helpers);
        shown.replaceWith(next);
        shown = next;
        announce(lookupResult ? "Row " + lookupResult.key + " found" : "No row matches");
      });
      section.append(el("div", { class: "row mb" }, [box, run]), shown);

      section.append(el("h2", { class: "mt", text: "Forms" }));
      if (!info.forms.length) section.append(el("p", { class: "hint", text: "No forms in the policy: fields are filled in record order." }));
      else {
        section.append(el("table", {}, [
          el("thead", {}, [el("tr", {}, [el("th", { text: "Form" }), el("th", { text: "Window" }), el("th", { text: "Fields (selector, shown only)" })])]),
          el("tbody", {}, info.forms.map((form) => el("tr", {}, [
            el("td", {}, [el("div", { text: form.label }), el("div", { class: "hint mono", text: form.id })]),
            el("td", { text: matchText(form.match) }),
            el("td", { text: form.fields.map((field) => field.label + " (" + field.selector + ")").join(", ") }),
          ]))),
        ]));
      }

      const clear = el("button", { class: "plain danger", text: "Clear stored fills" });
      clear.addEventListener("click", async () => {
        const result = await api.invoke("forms:clearSessions");
        announce(result && result.ok ? "Stored fills cleared (" + result.removed + ")" : (result && result.error) || "Could not clear the fills");
      });
      section.append(el("div", { class: "toolbar mt" }, [
        el("span", { class: "hint", text: info.sessions + " of at most " + info.maxSessions + " fills stored for learning" + (info.retentionDays ? ", each for " + info.retentionDays + " days" : "") + ". \"Clear stored fills\" deletes them; \"Delete learned text\" on the Learning tab does too, but that button is enabled only while the Learning tab has learned text of its own. A stored fill keeps only the values that came from your organisation's records and lookup lists: nothing you type into the fill popover, no value of a field whose name has a word such as password, PIN, credential, CVV, IBAN, SSN or token in it, and no card number, IBAN, US, UK, Spanish or French national ID number, labelled secret or long token found in a value." }),
        clear,
      ]));
    },
  };
})();
