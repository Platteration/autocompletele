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

  // Tabs
  const tabs = Array.from(document.querySelectorAll("nav [role=tab]"));
  function select(name) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      $("tab-" + tab.dataset.tab).hidden = !on;
    }
    try { localStorage.setItem("tab", name); } catch (error) { /* optional */ }
  }
  tabs.forEach((tab) => tab.addEventListener("click", () => select(tab.dataset.tab)));
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
  function overlay(candidate) {
    const box = el("div", { class: "overlay" });
    for (const segment of candidate.segments) {
      if (segment.type === "same") box.append(document.createTextNode(segment.text));
      else {
        const slot = el("span", { class: "slot", title: "Seen as: " + segment.values.join(", ") }, [
          el("abbr", { title: "Seen as: " + segment.values.join(", "), text: "[[" + segment.name + "]]" }),
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
    if (!window.confirm("Delete all learned text on this computer? Proposals based on it disappear. Your shortcuts and statistics are not affected.")) return;
    await api.clearLearning();
    announce("Learned text deleted");
  });

  async function renderLearning() {
    await renderCorpusInfo();
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
      if (candidate.kind === "template") {
        card.append(overlay(candidate));
        const slots = el("ul", { class: "slots" });
        for (const slot of candidate.slots) slots.append(el("li", { text: "[[" + slot.name + "]] seen as: " + slot.values.join(" | ") }));
        card.append(slots);
      } else {
        card.append(el("div", { class: "overlay", text: candidate.text }));
      }
      const trigger = el("input", { type: "text", value: candidate.suggestedTrigger, "aria-label": "Trigger" });
      const accept = el("button", { class: "primary", text: "Save as shortcut" });
      accept.addEventListener("click", async () => {
        const result = await api.acceptCandidate({ trigger: trigger.value, expansion: candidate.text });
        if (!result.ok) alert(result.error);
        else announce("Saved " + trigger.value);
      });
      const dismiss = el("button", { class: "plain", text: "Dismiss" });
      dismiss.addEventListener("click", () => api.dismissCandidate(candidate.text));
      card.append(el("div", { class: "row" }, [el("span", { class: "mono", text: "Trigger" }), trigger, accept, dismiss]));
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
  function auditDetail(entry) {
    switch (entry.event) {
      case "policy-applied":
        return (entry.organization || "policy") + (entry.paused ? ", PAUSED" : "") + "; sources: "
          + (entry.sources || []).map((s) => s.label + " #" + (s.serial == null ? "-" : s.serial)).join(", ")
          + (entry.warnings ? "; " + entry.warnings + " warning(s)" : "");
      case "policy-source-problem":
        return entry.source + ": " + (entry.error || entry.status);
      case "policy-source-recovered":
        return entry.source + " is reachable again";
      case "capture-rules-changed":
        return (entry.rules || []).map((r) => (r.label || JSON.stringify(r.match)) + " = " + r.mode).join(", ") || "all own rules removed";
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
        el("td", { text: entry.event }),
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
    if (status.paused) problems.push("Paused by your organisation" + (status.pausedMessage ? ": " + status.pausedMessage : ".") + " Nothing is expanded, offered or learned until it is resumed.");
    if (!status.listener.available) problems.push("Keyboard listener unavailable: " + (status.listener.error || "unknown reason") + ". Shortcuts are not expanded until this is fixed.");
    if (!status.sender.available) problems.push("Cannot type into other applications: " + status.sender.reason + ".");
    for (const warning of status.warnings) problems.push(warning);
    $("banner").hidden = !problems.length;
    text($("banner"), problems.join(" "));
    const ctx = status.context || {};
    text($("context"), ctx.process ? "Focused: " + ctx.process + " (" + status.mode + ")" : "");
  }

  async function renderAll(change) {
    const what = change || { metrics: true, library: true, learning: true, settings: true, status: true, context: true, policy: true };
    if (what.status || what.context) await renderStatus();
    if (what.settings || what.library || what.learning) await renderPolicyTabs();
    if (what.metrics || what.settings) await renderOverview();
    if (what.library) await renderLibrary();
    if (what.learning || what.library) await renderLearning();
    if (what.settings) await renderApps();
    if (what.settings || what.policy) await renderPolicy();
  }

  api.onChange((change) => { renderAll(change).catch(console.error); });
  let initial = "overview";
  try { initial = localStorage.getItem("tab") || initial; } catch (error) { /* optional */ }
  select(tabs.some((t) => t.dataset.tab === initial) ? initial : "overview");
  renderAll().catch(console.error);
})();
