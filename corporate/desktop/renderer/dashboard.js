// Dashboard page. Talks to the main process only through window.actle.
"use strict";

(function () {
  const api = window.actle;
  const $ = (id) => document.getElementById(id);
  let library = [];
  let policy = null;
  let settings = null;
  let editing = null;

  function text(node, value) {
    node.textContent = value == null ? "" : String(value);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children || []) node.append(child);
    return node;
  }

  function seconds(value) {
    const s = Math.round(Number(value) || 0);
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min " + (s % 60) + " s";
    const h = Math.floor(s / 3600);
    return h + " h " + Math.floor((s % 3600) / 60) + " min";
  }

  function announce(message) {
    text($("status"), message);
  }

  // The suite's apps: one tab each, rendered by renderer/apps/<id>.js through
  // window.actleApps[id].render(section, helpers, change). Tabs are inserted
  // before Policy; an app without a renderer gets a placeholder.
  const appRenderers = window.actleApps || {};
  let appList = [];
  function addAppTabs(list) {
    const nav = document.querySelector("nav");
    const policyTab = nav.querySelector('[data-tab="policy"]');
    const policySection = $("tab-policy");
    for (const app of list) {
      if (!app.tab || $("tab-" + app.id)) continue;
      const button = el("button", { role: "tab", "data-tab": app.id, "aria-selected": "false", text: app.title });
      nav.insertBefore(button, policyTab);
      const section = el("section", { id: "tab-" + app.id, role: "tabpanel" });
      section.hidden = true;
      policySection.parentNode.insertBefore(section, policySection);
    }
  }
  const helpers = { api, el, text, announce, seconds, preview: (value) => String(value || "").replace(/\s+/g, " ").slice(0, 140) };
  async function renderSuiteTabs(change) {
    for (const app of appList) {
      if (!app.tab) continue;
      const section = $("tab-" + app.id);
      const renderer = appRenderers[app.id];
      if (!section) continue;
      if (!renderer || typeof renderer.render !== "function") {
        section.textContent = "";
        section.append(el("p", { class: "hint", text: app.title + " has no dashboard page yet." }));
        continue;
      }
      try {
        await renderer.render(section, helpers, change || {});
      } catch (error) {
        section.textContent = "";
        section.append(el("p", { class: "hint", text: app.title + " could not be shown: " + (error && error.message || error) }));
      }
    }
  }

  // Tabs
  let tabs = Array.from(document.querySelectorAll("nav [role=tab]"));
  function select(name) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      $("tab-" + tab.dataset.tab).hidden = !on;
    }
    try { localStorage.setItem("tab", name); } catch (error) { /* optional */ }
  }
  tabs.forEach((tab) => { tab.dataset.wired = "1"; tab.addEventListener("click", () => select(tab.dataset.tab)); });
  document.querySelector("nav").addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    if (event.key === "ArrowRight") tabs[(index + 1) % tabs.length].focus();
    if (event.key === "ArrowLeft") tabs[(index + tabs.length - 1) % tabs.length].focus();
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") document.activeElement.click();
  });

  // Overview
  async function renderOverview() {
    const period = $("period").value;
    const summary = await api.getSummary({ period });
    text($("m-keystrokes"), summary.keystrokesSaved.toLocaleString());
    text($("m-time"), seconds(summary.secondsSaved));
    text($("m-inserts"), summary.expansions.toLocaleString());
    const chartPeriod = $("chart-period").value;
    const series = await api.getSeries({ period: chartPeriod, count: chartPeriod === "day" ? 14 : 12 });
    const max = Math.max(1, ...series.map((b) => b.keystrokesSaved));
    const chart = $("chart");
    chart.textContent = "";
    chart.setAttribute("aria-label", "Keystrokes saved per " + chartPeriod + ": " + series.map((b) => b.key + " " + b.keystrokesSaved).join(", "));
    for (const bucket of series) {
      const fill = el("div", { class: "fill", title: bucket.key + ": " + bucket.keystrokesSaved + " keystrokes, " + seconds(bucket.secondsSaved) });
      fill.style.height = Math.max(2, Math.round(bucket.keystrokesSaved / max * 120)) + "px";
      chart.append(el("div", { class: "bar" }, [fill, el("div", { class: "key", text: bucket.key.slice(chartPeriod === "day" ? 5 : 0) })]));
    }
    const rows = await api.getByApp({});
    const body = $("by-app");
    body.textContent = "";
    if (!rows.length) body.append(el("tr", {}, [el("td", { colspan: "4", text: "Nothing recorded yet." })]));
    for (const row of rows) {
      body.append(el("tr", {}, [
        el("td", { text: row.app }),
        el("td", { class: "num", text: row.expansions }),
        el("td", { class: "num", text: row.keystrokesSaved }),
        el("td", { class: "num", text: seconds(row.secondsSaved) }),
      ]));
    }
    if (policy) text($("typing-note"), "Time is estimated at " + policy.typing.charsPerMinute + " characters per minute and " + policy.typing.secondsPerAttachment + " s per attached document. An expansion undone with Backspace is not counted.");
  }
  $("period").addEventListener("change", renderOverview);
  $("chart-period").addEventListener("change", renderOverview);

  // Library
  function preview(value) {
    return String(value || "").replace(/\s+/g, " ").slice(0, 140);
  }

  async function renderLibrary() {
    library = await api.getLibrary();
    const body = $("library");
    body.textContent = "";
    text($("library-count"), library.length + " shortcut" + (library.length === 1 ? "" : "s"));
    for (const sh of library) {
      const own = sh.source !== "organization";
      const actions = el("td", {});
      if (own) {
        const edit = el("button", { class: "plain", text: "Edit" });
        edit.addEventListener("click", () => openEditor(sh));
        const remove = el("button", { class: "plain danger", text: "Delete" });
        remove.addEventListener("click", async () => {
          if (!confirm("Delete " + sh.trigger + "?")) return;
          await api.deleteShorthand(sh.trigger);
          announce("Deleted " + sh.trigger);
        });
        actions.append(edit, " ", remove);
      }
      const trigger = el("td", { class: "mono", text: sh.trigger });
      if (!own) trigger.append(el("span", { class: "tag", text: "organisation" }));
      body.append(el("tr", {}, [trigger, el("td", { text: preview(sh.expansion) }), actions]));
    }
  }

  function openEditor(sh) {
    editing = sh || null;
    text($("editor-title"), sh ? "Edit shortcut" : "Add shortcut");
    $("editor-trigger").value = sh ? sh.trigger : "";
    $("editor-expansion").value = sh ? sh.expansion : "";
    text($("editor-error"), "");
    $("editor").showModal();
    $("editor-trigger").focus();
  }
  $("add").addEventListener("click", () => openEditor(null));
  $("editor-cancel").addEventListener("click", () => $("editor").close());
  $("editor-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api.saveShorthand({ trigger: $("editor-trigger").value, expansion: $("editor-expansion").value, previousTrigger: editing ? editing.trigger : "" });
    if (!result.ok) {
      text($("editor-error"), result.error);
      return;
    }
    $("editor").close();
    announce("Saved " + $("editor-trigger").value);
  });
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    const result = await api.importLibrary(await file.text());
    announce(result.ok ? "Imported: " + result.added + " added, " + result.updated + " updated." : result.error);
    if (!result.ok) alert(result.error);
    $("import-file").value = "";
  });
  $("export").addEventListener("click", async () => {
    const result = await api.exportLibrary();
    if (result.ok) announce("Exported to " + result.path);
  });

  // Learning
  function overlay(candidate, names) {
    const box = el("div", { class: "overlay" });
    for (const segment of candidate.segments) {
      if (segment.type === "same") box.append(document.createTextNode(segment.text));
      else {
        const name = (names && names[segment.name] && names[segment.name].trim()) || segment.name;
        const slot = el("span", { class: "slot", title: "Seen as: " + segment.values.join(", ") }, [
          el("abbr", { title: "Seen as: " + segment.values.join(", "), text: "[[" + name + "]]" }),
        ]);
        box.append(slot);
      }
    }
    return box;
  }

  async function renderCorpusInfo() {
    const info = await api.getLearningInfo();
    let line;
    if (!info.storing) line = info.problem;
    else if (!info.sessions) line = "No learned text stored. Learned text is encrypted with your system keychain and kept for " + info.retentionDays + " days.";
    else line = info.sessions + " learned message(s) from " + new Date(info.oldest).toLocaleDateString() + " to " + new Date(info.newest).toLocaleDateString()
      + ", encrypted with your system keychain and kept for " + info.retentionDays + " days.";
    if (info.locked) line += " " + info.locked + " older message(s) cannot be read with the current key and are kept.";
    text($("corpus-info"), line);
    $("corpus-clear").disabled = !(info.sessions || info.locked);
  }

  $("corpus-clear").addEventListener("click", async () => {
    if (!window.confirm("Delete all learned text on this computer, including suggestions not yet exported? Proposals based on it disappear. Your shortcuts and statistics are not affected.")) return;
    await api.clearLearning();
    announce("Learned text deleted");
  });

  async function renderSuggestions() {
    const queued = await api.getSuggestions();
    const body = $("suggestions");
    body.textContent = "";
    for (const item of queued) {
      const remove = el("button", { class: "plain", text: "Remove" });
      remove.addEventListener("click", () => api.unsuggest(item.text));
      body.append(el("tr", {}, [el("td", { class: "mono", text: item.text }), el("td", { class: "mono", text: item.trigger }), el("td", {}, [remove])]));
    }
    if (!queued.length) body.append(el("tr", {}, [el("td", { colspan: "3", text: "Nothing suggested yet. Use Suggest to organisation on a proposal above." })]));
    $("suggestions-save").disabled = !queued.length;
  }

  $("suggestions-save").addEventListener("click", async () => {
    const result = await api.saveSuggestions();
    if (result && result.ok) announce("Suggestions saved to " + result.path);
    else if (result && result.error) announce(result.error);
  });

  async function renderLearning() {
    await renderCorpusInfo();
    await renderSuggestions();
    const list = await api.getCandidates();
    const host = $("candidates");
    host.textContent = "";
    if (!list.length) {
      host.append(el("p", { class: "hint", text: "No proposals yet. Allow an application in learn mode under Applications, then write a few messages there." }));
      return;
    }
    for (const candidate of list) {
      const card = el("div", { class: "candidate" });
      const kind = candidate.kind === "template" ? "Template" : candidate.kind === "paragraph" ? "Paragraph" : candidate.kind === "sentence" ? "Sentence" : "Phrase";
      card.append(el("div", { class: "meta", text: kind + " seen in " + candidate.sessions + " messages" }));
      const names = {};
      if (candidate.kind === "template") {
        let preview = overlay(candidate, names);
        card.append(preview);
        // Each blank can be renamed before saving; the overlay follows.
        const slots = el("ul", { class: "slots" });
        for (const slot of candidate.slots) {
          const input = el("input", { type: "text", value: slot.name, class: "slot-name", "aria-label": "Name for the blank seen as " + slot.values.join(", ") });
          input.addEventListener("input", () => {
            names[slot.name] = input.value;
            const next = overlay(candidate, names);
            preview.replaceWith(next);
            preview = next;
          });
          slots.append(el("li", {}, [input, el("span", { text: " seen as: " + slot.values.join(" | ") })]));
        }
        card.append(slots);
      } else {
        card.append(el("div", { class: "overlay", text: candidate.text }));
      }
      const trigger = el("input", { type: "text", value: candidate.suggestedTrigger, "aria-label": "Trigger" });
      const accept = el("button", { class: "primary", text: "Save as shortcut" });
      accept.addEventListener("click", async () => {
        const result = await api.acceptCandidate(candidate.kind === "template"
          ? { trigger: trigger.value, template: candidate.template, names }
          : { trigger: trigger.value, expansion: candidate.text });
        if (!result.ok) alert(result.error);
        else announce("Saved " + trigger.value);
      });
      const dismiss = el("button", { class: "plain", text: "Dismiss" });
      dismiss.addEventListener("click", () => api.dismissCandidate(candidate.text));
      const share = el("button", { class: "plain", text: "Suggest to organisation" });
      share.addEventListener("click", async () => {
        const result = await api.suggest(candidate.kind === "template"
          ? { trigger: trigger.value, template: candidate.template, names }
          : { trigger: trigger.value, text: candidate.text });
        if (!result.ok) alert(result.error);
        else announce("Added to your suggestions");
      });
      card.append(el("div", { class: "row" }, [el("span", { class: "mono", text: "Trigger" }), trigger, accept, share, dismiss]));
      host.append(card);
    }
  }

  // Applications
  function ruleLabel(rule) {
    const parts = [];
    if (rule.processes && rule.processes.length) parts.push(rule.processes.join(", "));
    if (rule.bundleIds && rule.bundleIds.length) parts.push(rule.bundleIds.join(", "));
    if (rule.titlePattern) parts.push("title matches /" + rule.titlePattern + "/");
    return (rule.label ? rule.label + ": " : "") + parts.join("; ");
  }

  async function renderApps() {
    settings = await api.getSettings();
    policy = policy || await api.getPolicyInfo();
    $("enabled").checked = settings.enabled;
    const body = $("rules");
    body.textContent = "";
    settings.captureApps.forEach((rule, index) => {
      const remove = el("button", { class: "plain danger", text: "Remove" });
      remove.addEventListener("click", async () => {
        const next = settings.captureApps.filter((r, i) => i !== index);
        await api.saveSettings({ captureApps: next });
      });
      const match = rule.match || rule;
      const label = [match.process, match.title ? "title matches /" + match.title + "/" : ""].flat().filter(Boolean).join("; ");
      body.append(el("tr", {}, [el("td", { text: label }), el("td", { text: rule.mode }), el("td", {}, [remove])]));
    });
    if (!settings.captureApps.length) body.append(el("tr", {}, [el("td", { colspan: "3", text: "No rules of your own. Everything not listed uses the organisation default: " + policy.capture.defaultMode + "." })]));
    const org = $("org-rules");
    org.textContent = "";
    const own = new Set(settings.captureApps.map((r) => r.id));
    for (const rule of policy.capture.apps) {
      if (own.has(rule.id)) continue;
      org.append(el("tr", {}, [el("td", { text: ruleLabel(rule) }), el("td", { text: rule.mode })]));
    }
    $("cpm").value = settings.charsPerMinute || "";
  }
  $("rule-add").addEventListener("click", async () => {
    const process = $("rule-process").value.trim();
    const title = $("rule-title").value.trim();
    if (!process && !title) {
      alert("Enter a process name or a window title pattern.");
      return;
    }
    const rule = { id: "own-" + Date.now().toString(36), mode: $("rule-mode").value, match: {} };
    if (process) rule.match.process = process;
    if (title) rule.match.title = title;
    await api.saveSettings({ captureApps: settings.captureApps.concat([rule]) });
    $("rule-process").value = "";
    $("rule-title").value = "";
    announce("Rule added");
  });
  $("cpm-save").addEventListener("click", async () => {
    const value = Number($("cpm").value);
    await api.saveSettings({ charsPerMinute: value > 0 ? value : null });
    policy = await api.getPolicyInfo();
    announce("Typing speed saved");
  });
  $("enabled").addEventListener("change", () => api.setEnabled($("enabled").checked));

  // Keywords and documents
  async function renderPolicyTabs() {
    policy = await api.getPolicyInfo();
    text($("org"), policy.organization ? policy.organization : "no organisation policy loaded");
    const kw = $("keywords");
    kw.textContent = "";
    for (const rule of policy.keywordRules) {
      const insert = rule.insert;
      const inserts = !insert ? "" : insert.kind === "text" ? "text: " + preview(insert.text)
        : insert.kind === "shorthand" ? "shortcut " + insert.trigger : "documents " + insert.shortcut;
      const does = rule.action === "warn" ? "Warns: " + rule.message + (inserts ? " Fix: " + inserts : "") : inserts;
      const when = rule.keywords.concat((rule.detect || []).map((name) => "[" + name + "]")).join(", ")
        + ((rule.unless || []).length ? " unless: " + rule.unless.join("; ") : "");
      kw.append(el("tr", {}, [el("td", { text: rule.label }), el("td", { text: when }), el("td", { text: rule.match }), el("td", { text: does })]));
    }
    if (!policy.keywordRules.length) kw.append(el("tr", {}, [el("td", { colspan: "4", text: "No keyword rules in the policy." })]));
    const docs = $("documents");
    docs.textContent = "";
    for (const shortcut of policy.documents) {
      const table = el("table", {}, [el("thead", {}, [el("tr", {}, [el("th", { text: "Title" }), el("th", { text: "Path" }), el("th", { text: "Tags" })])])]);
      const body = el("tbody");
      for (const doc of shortcut.documents) body.append(el("tr", {}, [el("td", { text: doc.title }), el("td", { class: "mono", text: doc.path }), el("td", { text: doc.tags.join(", ") })]));
      table.append(body);
      docs.append(el("h2", {}, [el("span", { class: "mono", text: shortcut.trigger }), document.createTextNode(" " + shortcut.label)]), table, el("br"));
    }
    if (!policy.documents.length) docs.append(el("p", { class: "hint", text: "No document shortcuts in the policy." }));
  }

  // Filing
  async function renderFiling() {
    const info = await api.getFilingInfo();
    const status = info.status || {};
    text($("filing-status"), !info.enabled ? "The organisation policy has no filing rules, so nothing is proposed."
      : status.watching ? "Watching " + status.watching + " folder" + (status.watching === 1 ? "" : "s") + ". Each filing is credited " + info.secondsPerFiling + " s in the statistics."
        : "No folder is being watched. Add one below or turn a policy folder on.");
    const folders = $("filing-folders");
    folders.textContent = "";
    for (const folder of info.folders.policy.concat(info.folders.own)) {
      const actions = el("td", {});
      if (folder.source === "organization") {
        const toggle = el("button", { class: "plain", text: folder.ignored ? "Turn on" : "Turn off" });
        toggle.addEventListener("click", () => api.ignoreFilingFolder({ path: folder.raw, ignore: !folder.ignored }));
        actions.append(toggle);
      } else {
        const remove = el("button", { class: "plain danger", text: "Remove" });
        remove.addEventListener("click", () => api.removeFilingFolder(folder.raw));
        actions.append(remove);
      }
      if (!folder.ignored && info.enabled) {
        const rescan = el("button", { class: "plain", text: "File existing documents…" });
        rescan.addEventListener("click", async () => {
          if (!confirm("Propose a name and folder for every document already in " + folder.path + "? Each one is shown for you to confirm or skip.")) return;
          const r = await api.rescanFilingFolder(folder.path);
          announce(r.ok ? r.queued + " document(s) queued" : r.error);
        });
        actions.append(" ", rescan);
      }
      folders.append(el("tr", {}, [
        el("td", { class: "mono", text: folder.path + (folder.recursive ? " (and subfolders)" : "") }),
        el("td", { text: folder.source === "organization" ? "organisation" + (folder.label && folder.label !== folder.raw ? ": " + folder.label : "") : "you" }),
        el("td", { text: folder.ignored ? "turned off" : (status.folders || []).includes(folder.path) ? "watching" : "not watching (missing folder?)" }),
        actions,
      ]));
    }
    if (!info.folders.policy.length && !info.folders.own.length) folders.append(el("tr", {}, [el("td", { colspan: "4", text: "No folders are watched." })]));
    const rules = $("filing-rules");
    rules.textContent = "";
    for (const rule of info.rules) {
      const when = rule.keywords.join(rule.match === "all" ? " + " : ", ") + (rule.extensions.length ? " (" + rule.extensions.join(", ") + ")" : "");
      rules.append(el("tr", {}, [el("td", { text: rule.label }), el("td", { text: when }), el("td", { class: "mono", text: rule.name }), el("td", { class: "mono", text: rule.folder || "(same folder)" })]));
    }
    if (info.fallback) rules.append(el("tr", {}, [el("td", { text: info.fallback.label }), el("td", { text: "anything else" }), el("td", { class: "mono", text: info.fallback.name }), el("td", { class: "mono", text: info.fallback.folder || "(same folder)" })]));
    if (!info.rules.length && !info.fallback) rules.append(el("tr", {}, [el("td", { colspan: "4", text: "No filing rules in the policy." })]));
    await renderFiled();
  }

  async function renderFiled() {
    const query = $("filing-query").value.trim();
    const rows = query ? await api.searchFiling(query) : await api.getFilingRecent(50);
    const info = await api.getFilingInfo();
    text($("filing-count"), info.indexed + " filed document" + (info.indexed === 1 ? "" : "s") + (query ? ", " + rows.length + " matching" : ""));
    $("filing-clear").disabled = !info.indexed;
    const body = $("filing-recent");
    body.textContent = "";
    for (const entry of rows) {
      const undo = el("button", { class: "plain", text: "Undo" });
      undo.addEventListener("click", async () => {
        const r = await api.undoFiling(entry.id);
        announce(r.ok ? "Moved back to " + r.to : r.error);
        if (!r.ok) alert(r.error);
      });
      const reveal = el("button", { class: "plain", text: "Reveal" });
      // By index entry id: main.js reveals only what the filing index holds.
      reveal.addEventListener("click", async () => {
        const r = await api.revealFiled(entry.id);
        if (r && r.ok === false) announce(r.error);
      });
      body.append(el("tr", {}, [
        el("td", { text: entry.filedAt ? new Date(entry.filedAt).toLocaleString() : "" }),
        el("td", { class: "mono", text: entry.originalName }),
        el("td", { class: "mono", text: entry.path }),
        el("td", { text: entry.ruleLabel || entry.rule }),
        el("td", {}, [undo, " ", reveal]),
      ]));
    }
    if (!rows.length) body.append(el("tr", {}, [el("td", { colspan: "5", text: query ? "Nothing matches." : "Nothing filed yet." })]));
  }
  $("filing-query").addEventListener("input", () => { renderFiled().catch(console.error); });
  $("filing-add-folder").addEventListener("click", async () => {
    const r = await api.addFilingFolder();
    if (r && r.ok) announce("Folder added");
  });
  $("filing-clear").addEventListener("click", async () => {
    if (!confirm("Forget every filed document in the index? The files themselves are not touched, but Undo and the palette search will no longer find them.")) return;
    const r = await api.clearFiling();
    announce("Index cleared (" + r.removed + " entries)");
  });

  // Usage report preview and export
  async function openReport() {
    const report = await api.previewReport();
    const rows = [
      ["Organisation", report.organization || "(not named)"],
      ["Team", report.team || "(not set)"],
      ["Period", new Date(report.range.from).toLocaleDateString() + " to " + new Date(report.range.to - 1).toLocaleDateString() + " (" + report.series.length + " " + report.period + "s)"],
      ["Inserts", report.totals.inserts],
      ["Keystrokes saved", report.totals.keystrokesSaved],
      ["Estimated time saved", seconds(report.totals.secondsSaved)],
      ["Organisation shortcuts used", report.byShortcut.map((s) => s.trigger + " (" + s.inserts + ")").join(", ") || "none"],
      ["Your own shortcuts", report.personal.inserts + " inserts, not named"],
      ["Applications", report.byApp ? report.byApp.map((a) => a.app).join(", ") || "none" : "not included"],
      ["Desk id", report.installId],
    ];
    const body = $("report-summary");
    body.textContent = "";
    for (const [label, value] of rows) body.append(el("tr", {}, [el("th", { scope: "row", text: label }), el("td", { text: value })]));
    $("report").showModal();
  }
  $("report-open").addEventListener("click", () => { openReport().catch(console.error); });
  $("report-cancel").addEventListener("click", () => $("report").close());
  $("report-save").addEventListener("click", async () => {
    const result = await api.saveReport();
    if (result && result.ok) {
      $("report").close();
      announce("Report saved to " + result.path);
    }
  });

  // Policy sources and the change log
  const EVENT_LABELS = {
    "policy-applied": "Policy applied",
    "policy-source-problem": "Policy source failing",
    "policy-source-recovered": "Policy source recovered",
    "capture-rules-changed": "Your capture rules changed",
    "corpus-key-created": "Learning key created",
    "corpus-key-replaced": "Learning key replaced",
    "corpus-encrypted": "Learned text encrypted",
    "corpus-deleted": "Learned text deleted",
    "document-filed": "Document filed",
    "document-unfiled": "Filing undone",
    "filing-index-cleared": "Filing index cleared",
  };

  function auditDetail(entry) {
    switch (entry.event) {
      case "policy-applied": {
        const sources = (entry.sources || []).map((s) => s.label + (s.serial == null ? " (" + s.status + ")" : " #" + s.serial));
        return (entry.organization || "No organisation policy") + (entry.paused ? ", paused" : "")
          + (sources.length ? "; sources: " + sources.join(", ") : "")
          + (entry.warnings ? "; " + entry.warnings + " warning(s)" : "");
      }
      case "corpus-encrypted":
        return entry.sessions + " message(s) from an earlier version";
      case "corpus-deleted":
        return entry.sessions + " message(s)";
      case "corpus-key-replaced":
        return "the previous key could not be read and protected nothing; kept as " + entry.aside;
      case "policy-source-problem":
        return entry.source + ": " + (entry.error || entry.status);
      case "policy-source-recovered":
        return entry.source + " is reachable again";
      case "capture-rules-changed":
        return (entry.rules || []).map((r) => (r.label || JSON.stringify(r.match)) + " = " + r.mode).join(", ") || "all own rules removed";
      case "document-filed":
      case "document-unfiled":
        return (entry.rule ? entry.rule + ": " : "") + entry.from + " \u2192 " + entry.to;
      case "filing-index-cleared":
        return entry.entries + " entries";
      default:
        return "";
    }
  }

  async function renderPolicy() {
    const info = await api.getPolicyInfo();
    text($("policy-mode"), info.managed
      ? "This desk receives a signed policy from your organisation and checks for updates every " + info.refreshMinutes + " minutes."
      : "This desk is not centrally managed; it uses a local policy file if one is installed.");
    $("policy-refresh").hidden = !info.managed;
    const sources = $("policy-sources");
    sources.textContent = "";
    for (const source of info.sources || []) {
      sources.append(el("tr", {}, [
        el("td", { text: source.label }),
        el("td", { text: source.status }),
        el("td", { class: "num", text: source.serial == null ? "" : source.serial }),
        el("td", { class: "mono", text: source.keyId || "" }),
        el("td", { text: source.error || "" }),
      ]));
    }
    if (!(info.sources || []).length) sources.append(el("tr", {}, [el("td", { colspan: "5", text: "No signed policy sources." })]));
    const audit = $("audit");
    audit.textContent = "";
    const entries = (await api.getAudit()).slice().reverse();
    for (const entry of entries) {
      audit.append(el("tr", {}, [
        el("td", { text: new Date(entry.at).toLocaleString() }),
        el("td", { text: EVENT_LABELS[entry.event] || entry.event }),
        el("td", { text: auditDetail(entry) }),
      ]));
    }
    if (!entries.length) audit.append(el("tr", {}, [el("td", { colspan: "3", text: "No changes recorded yet." })]));
  }

  $("policy-refresh").addEventListener("click", async () => {
    text($("policy-refresh-result"), "Checking…");
    const result = await api.refreshPolicy();
    text($("policy-refresh-result"), result && result.ok ? "Checked." : "Could not check: " + ((result && result.error) || "not managed"));
    announce($("policy-refresh-result").textContent);
  });

  async function renderStatus() {
    const status = await api.getStatus();
    const problems = [];
    if (status.paused) {
      const reason = status.pausedMessage ? ": " + status.pausedMessage.replace(/[.!?]*$/, ".") : ".";
      problems.push("Paused by your organisation" + reason + " Nothing is expanded, offered or learned until it is resumed.");
    }
    if (!status.listener.available) problems.push("Keyboard listener unavailable: " + (status.listener.error || "unknown reason") + ". Shortcuts are not expanded until this is fixed.");
    if (!status.sender.available) problems.push("Cannot type into other applications: " + status.sender.reason + ".");
    if (status.palette && status.palette.accelerator && !status.palette.registered) {
      problems.push("The search palette shortcut " + status.palette.accelerator + " is not available (" + (status.palette.error || "unknown reason") + "). Use Search shortcuts in the tray menu instead.");
    }
    for (const warning of status.warnings) problems.push(warning);
    $("banner").hidden = !problems.length;
    $("banner").textContent = "";
    for (const problem of problems) $("banner").append(el("div", { text: problem }));
    const ctx = status.context || {};
    text($("context"), ctx.process ? "Focused: " + ctx.process + " (" + status.mode + ")" : "");
  }

  async function renderAll(change) {
    const what = change || { metrics: true, library: true, learning: true, settings: true, status: true, context: true, policy: true, filing: true };
    if (what.status || what.context) await renderStatus();
    if (what.settings || what.library || what.learning) await renderPolicyTabs();
    if (what.metrics || what.settings) await renderOverview();
    if (what.library) await renderLibrary();
    if (what.learning || what.library) await renderLearning();
    if (what.settings) await renderApps();
    if (what.settings || what.policy) await renderPolicy();
    if (what.settings || what.policy || what.filing) await renderFiling();
    await renderSuiteTabs(what);
  }

  api.onChange((change) => { renderAll(change).catch(console.error); });
  (async function init() {
    try {
      appList = await api.listApps();
    } catch (error) {
      appList = [];
    }
    addAppTabs(appList);
    tabs = Array.from(document.querySelectorAll("nav [role=tab]"));
    tabs.forEach((tab) => { if (!tab.dataset.wired) { tab.dataset.wired = "1"; tab.addEventListener("click", () => select(tab.dataset.tab)); } });
    let initial = "overview";
    try { initial = localStorage.getItem("tab") || initial; } catch (error) { /* optional */ }
    select(tabs.some((t) => t.dataset.tab === initial) ? initial : "overview");
    await renderAll();
  })().catch(console.error);
})();
