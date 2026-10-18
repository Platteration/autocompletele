// A temporary, local form for filling a template before inserting or copying it.
// The caller retains responsibility for checking and restoring its insertion target.
(function (root) {
  "use strict";

  const HOST_ID = "shorthand-template-host";
  let current = null;

  const styles = `
    :host {
      all: initial !important; position: fixed !important; inset: 0 !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      z-index: 2147483647 !important; padding: 16px !important;
      box-sizing: border-box !important; background: rgb(15 17 21 / 32%) !important;
      color-scheme: light dark !important;
      --bg: #fff; --surface: #f5f6f8; --sunken: #eceef1; --ink: #1b1f24; --muted: #59636e;
      --line: #d3d8de; --control: #7a838e; --accent: #1a5fd0; --soft: #e8effc;
      --button: #1a5fd0; --button-hover: #154ca8; --frame: #1b1f24; --danger: #b3261e;
      --danger-soft: #fcedec; --shadow: 0 4px 16px rgb(0 0 0 / 12%);
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      width: 620px; max-width: 100%; max-height: 85vh; max-height: 85dvh;
      display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid var(--frame); border-radius: 0;
      color: var(--ink); background: var(--bg); box-shadow: var(--shadow);
      font: 14px/22px system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: left; letter-spacing: normal; word-spacing: normal;
    }
    .heading { padding: 24px 24px 16px; border-bottom: 1px solid var(--line); background: var(--bg); }
    .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 11px; font-weight: 650; line-height: 16px; letter-spacing: .08em; text-transform: uppercase; }
    h2 { margin: 0; font-size: 20px; font-weight: 650; line-height: 28px; letter-spacing: -.01em; }
    .description { margin: 8px 0 16px; color: var(--muted); font-size: 12px; line-height: 18px; }
    .meta { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .trigger { min-width: 0; margin: 0; padding: 4px 8px; border: 1px solid transparent; border-radius: 2px; background: var(--soft); color: var(--accent); font: 650 12px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .count { color: var(--muted); font-size: 12px; line-height: 18px; white-space: nowrap; }
    .body { padding: 24px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--control) var(--bg); }
    .view-tabs { display: flex; gap: 24px; margin-bottom: 24px; border-bottom: 1px solid var(--line); }
    .view-tabs button { flex: none; min-height: 36px; margin-bottom: -1px; padding: 8px 0; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); font-size: 12px; }
    .view-tabs button[role="tab"]:is(:hover, :disabled) { border-bottom-color: transparent; background: transparent; }
    .view-tabs button[role="tab"]:not([aria-selected="true"]):hover:not(:disabled) { color: var(--ink); }
    .view-tabs button[role="tab"][aria-selected="true"] { border-bottom-color: var(--accent); color: var(--accent); }
    .field-table { width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0; border: solid transparent; border-width: 1px 0; border-bottom-color: var(--line); }
    .field-table caption { padding: 0 0 8px; color: var(--muted); font-size: 12px; line-height: 18px; text-align: left; }
    .field-table th, .field-table td { padding: 8px 12px; vertical-align: middle; text-align: left; overflow-wrap: anywhere; }
    .field-table tr > :first-child { padding-left: 0; }
    .field-table tr > :last-child { padding-right: 0; }
    .field-table thead th { border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px; font-weight: 650; line-height: 16px; letter-spacing: .08em; text-transform: uppercase; }
    .field-table thead th:first-child { width: 32%; }
    .field-table tbody th { color: var(--ink); font-size: 12px; font-weight: 650; line-height: 18px; }
    .field-table tbody tr + tr > * { border-top: 1px solid var(--line); }
    .field-table td input { background: var(--soft); color: var(--accent); }
    .field { display: grid; gap: 8px; font-size: 12px; font-weight: 650; line-height: 18px; overflow-wrap: anywhere; }
    input, select {
      width: 100%; min-width: 0; padding: 8px 12px; border: 1px solid var(--control);
      border-radius: 2px; background: var(--bg); color: var(--ink);
      font: 400 14px/22px system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    input::placeholder { color: var(--muted); opacity: 1; }
    input:hover:not(:disabled, :focus), select:hover:not(:disabled, :focus) { border-color: var(--ink); }
    input:focus, select:focus { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
    input:disabled, select:disabled { background: var(--surface); color: var(--muted); }
    .pronouns { margin-bottom: 24px; padding: 16px; border: 1px solid transparent; border-radius: 0; background: var(--surface); }
    .pronouns .hint, .message-hint, .no-fields { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 18px; }
    .custom-pronouns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
    .inline-message { margin-top: 12px; padding: 16px; border: 1px solid transparent; border-radius: 0; background: var(--surface); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 2.6; }
    .inline-message input { display: inline-block; width: auto; min-width: 5ch; max-width: 100%; padding: 2px 8px; border-color: var(--accent); border-radius: 2px; background: var(--soft); color: var(--accent); font: inherit; line-height: 1.6; vertical-align: baseline; }
    .inline-message input::placeholder { color: var(--accent); }
    .field-table td input:disabled, .inline-message input:disabled { background: var(--surface); border-color: var(--line); color: var(--muted); }
    .variable { padding: 2px 4px; border-radius: 2px; background: var(--soft); color: var(--accent); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .preview-wrap { margin-top: 24px; padding: 16px; border: 1px solid transparent; border-radius: 0; background: var(--surface); }
    .preview-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
    .preview-heading h3 { margin: 0; font-size: 11px; font-weight: 650; line-height: 16px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .preview-heading span { color: var(--muted); font-size: 11px; line-height: 16px; }
    .preview { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 24px; }
    .blank { padding: 1px 4px; border-radius: 2px; color: var(--accent); background: var(--soft); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .footer { flex-shrink: 0; padding: 16px 24px 24px; border-top: 1px solid var(--line); background: var(--bg); }
    .status { margin: 0 0 12px; padding: 8px 12px; border: 1px solid var(--danger); border-radius: 0; background: var(--danger-soft); color: var(--danger); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; }
    button { min-height: 40px; padding: 8px 16px; border: 1px solid var(--control); border-radius: 2px; background: transparent; color: var(--ink); font: 650 13px/20px system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--sunken); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .submit { flex: 1; border-color: var(--button); background: var(--button); color: #fff; }
    .submit:hover:not(:disabled) { border-color: var(--button-hover); background: var(--button-hover); }
    button:disabled { background: var(--surface); border-color: var(--line); color: var(--muted); cursor: wait; }
    .privacy { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 16px; text-align: left; }
    @media (max-width: 480px) {
      :host { padding: 8px !important; }
      .heading { padding: 16px 16px 12px; }
      .body { padding: 16px; }
      .footer { padding: 12px 16px 16px; }
      .field-table th, .field-table td { padding: 8px; }
      .field-table td input { padding: 8px; }
      .custom-pronouns { grid-template-columns: minmax(0, 1fr); }
      .inline-message { padding: 12px; }
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #0f1115; --surface: #16191e; --sunken: #1c2026; --ink: #e7eaee; --muted: #a2aab4;
        --line: #2e343c; --control: #7d8691; --accent: #7aa7ff; --soft: #1a2840;
        --button: #2f6be0; --button-hover: #255bc6; --frame: #7d8691; --danger: #ff8a80; --danger-soft: #3a1f1d;
        --shadow: none;
      }
    }
    @media (forced-colors: active) {
      .panel, input, select, button, .trigger, .preview-wrap, .field-table { border-color: ButtonText; }
      input:focus, select:focus, button:focus-visible { outline-color: Highlight; }
      .blank, .variable { outline: 1px solid Highlight; }
    }
  `;

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function valuesFor(session, includeEmpty) {
    const values = Object.create(null);
    for (const { name } of session.inputs) {
      if (includeEmpty || session.answers[name] !== "") values[name] = session.answers[name];
    }
    return values;
  }

  // Each person's choice is keyed as the template expects: "subject" for
  // person 1, "subject2" for person 2, and so on.
  function pronounsFor(session) {
    const values = Object.create(null);
    for (const group of session.pronounGroups) {
      if (group.select.value === "custom") {
        for (const { key, input } of group.custom) {
          if (input.value !== "") values[key] = input.value;
        }
      } else if (group.select.value) {
        Object.assign(values, root.ShorthandTemplate.presetFor(group.select.value, group.person));
      }
    }
    return values;
  }

  function variableText(session, part, pronouns) {
    return root.ShorthandTemplate.render(part.raw, {}, session.now, pronouns).text;
  }

  function preview(session) {
    const values = valuesFor(session, false);
    const pronouns = pronounsFor(session);
    const ready = session.pronounGroups.filter((group) => group.custom.every(({ key }) => Object.hasOwn(pronouns, key))).length;
    const count = Object.keys(values).length + ready;
    const total = session.inputs.length + session.pronounGroups.length;
    session.count.textContent = count + " of " + total + " filled";
    session.preview.textContent = "";
    for (const part of root.ShorthandTemplate.parts(session.expansion)) {
      if (part.type === "field") {
        if (Object.prototype.hasOwnProperty.call(values, part.name)) {
          session.preview.appendChild(element("span", "blank", values[part.name]));
        } else {
          session.preview.appendChild(element("span", "blank", part.label));
        }
      } else if (part.type === "variable") {
        session.preview.appendChild(element("span", "variable", variableText(session, part, pronouns)));
      } else {
        const text = root.ShorthandExpander.render(part.value, session.now).text;
        session.preview.appendChild(document.createTextNode(text));
      }
    }
    for (const { part, el } of session.inlineVariables) el.textContent = variableText(session, part, pronouns);
  }

  function updateControls(session) {
    for (const { input } of session.inputs) input.disabled = session.busy || session.view !== "fields";
    for (const { input } of session.inlineInputs) input.disabled = session.busy || session.view !== "message";
    for (const group of session.pronounGroups) {
      group.select.disabled = session.busy;
      const custom = group.select.value === "custom";
      group.customGroup.hidden = !custom;
      for (const { input } of group.custom) input.disabled = session.busy || !custom;
    }
    for (const button of session.viewButtons) button.disabled = session.busy;
    session.submit.disabled = session.busy;
    session.cancel.disabled = session.busy;
  }

  function setView(session, view) {
    session.view = view;
    session.fieldsPanel.hidden = view !== "fields";
    session.messagePanel.hidden = view !== "message";
    session.previewWrap.hidden = view === "message";
    for (const button of session.viewButtons) {
      const selected = button.dataset.view === view;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    updateControls(session);
  }

  function syncAnswer(session, name, input) {
    session.answers[name] = input.value;
    for (const control of session.answerControls.get(name)) {
      if (control !== input) control.value = input.value;
      if (control.classList.contains("inline-input")) {
        control.size = Math.min(30, Math.max(6, input.value.length + 1, control.placeholder.length));
      }
    }
    preview(session);
  }

  function focusableControls(session) {
    const answers = session.view === "fields" ? session.inputs : session.inlineInputs.filter(({ first }) => first);
    return [
      ...session.viewButtons.filter((button) => button.tabIndex === 0),
      ...session.pronounGroups.flatMap((group) => [group.select, ...group.custom.map(({ input }) => input)]),
      ...answers.map(({ input }) => input), session.cancel, session.submit,
    ].filter((el) => el && !el.disabled);
  }

  function restoreFocus(session) {
    const previous = session.previous;
    if (!previous || !previous.isConnected || typeof previous.focus !== "function") return;
    try { previous.focus({ preventScroll: true }); } catch (_) { /* The caller can restore its own target. */ }
  }

  function close(options) {
    const session = current;
    if (!session) return;
    current = null;
    session.host.remove();
    if (options && options.restoreFocus) restoreFocus(session);
  }

  function cancel(session) {
    if (current !== session || session.busy) return;
    close({ restoreFocus: session.restoreFocus });
    if (typeof session.onCancel === "function") session.onCancel();
  }

  function setBusy(session, busy) {
    session.busy = busy;
    session.form.setAttribute("aria-busy", String(busy));
    updateControls(session);
    session.submit.textContent = busy ? "Working…" : session.actionLabel;
    if (busy) session.form.focus({ preventScroll: true });
  }

  async function submit(session) {
    if (current !== session || session.busy || !session.form.reportValidity()) return;
    const values = valuesFor(session, true);
    const rendered = root.ShorthandTemplate.render(session.expansion, values, session.now, pronounsFor(session));
    session.status.hidden = true;
    setBusy(session, true);
    try {
      const result = await session.onSubmit(rendered, values);
      if (current !== session) return;
      if (result === false || typeof result === "string") {
        session.status.textContent = typeof result === "string" && result
          ? result : "That didn’t work. Your answers are still here; please try again.";
        session.status.hidden = false;
      } else {
        // The caller may have focused its insertion target. Never steal it back.
        close();
        return;
      }
    } catch (_) {
      if (current !== session) return;
      session.status.textContent = "That didn’t work. Your answers are still here; please try again.";
      session.status.hidden = false;
    }
    setBusy(session, false);
    session.submit.focus();
  }

  function show(options) {
    if (!options || typeof options.onSubmit !== "function" || !root.ShorthandTemplate) return false;
    const expansion = String(options.expansion == null ? "" : options.expansion);
    const fields = root.ShorthandTemplate.fields(expansion);
    const people = root.ShorthandTemplate.pronounPeople(expansion);
    if ((!fields.length && !people.length) || current) return false;

    const host = element("div");
    host.id = HOST_ID;
    host.setAttribute("data-shorthand-ignore", "");
    const shadow = host.attachShadow({ mode: "closed" });
    // Constructed sheets work on strict-CSP pages in both Firefox and Chrome.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
    shadow.adoptedStyleSheets = [sheet];

    const form = element("form", "panel");
    form.tabIndex = -1;
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    form.setAttribute("aria-labelledby", "template-title");
    form.setAttribute("aria-describedby", "template-description");
    const heading = element("header", "heading");
    const eyebrow = element("p", "eyebrow", "Make it yours");
    const title = element("h2", "", "Fill in your template");
    title.id = "template-title";
    const description = element("p", "description", "Fill in the blue blanks, then " + (/copy/i.test(options.actionLabel || "") ? "copy" : "insert") + ". Repeated blanks share one answer.");
    description.id = "template-description";
    const meta = element("div", "meta");
    const trigger = element("code", "trigger", String(options.trigger || "Template"));
    const count = element("span", "count");
    meta.append(trigger, count);
    heading.append(eyebrow, title, description, meta);

    const body = element("div", "body");
    const viewTabs = element("div", "view-tabs");
    viewTabs.setAttribute("role", "tablist");
    viewTabs.setAttribute("aria-label", "Fill-in view");
    const viewButtons = [["fields", "Fields table"], ["message", "In message"]].map(([view, label]) => {
      const button = element("button", "", label);
      button.type = "button";
      button.id = "template-view-" + view;
      button.dataset.view = view;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "template-" + view + "-panel");
      viewTabs.appendChild(button);
      return button;
    });
    body.appendChild(viewTabs);

    // One pronoun choice per person. Person 1 keeps the original ids, so a
    // single-person script looks and behaves exactly as before.
    const several = people.length > 1 || (people.length === 1 && people[0].person > 1);
    const customLabels = {
      subject: "Subject (she / he / they)", object: "Object (her / him / them)",
      possessive: "Possessive (her / his / their)", possessivepronoun: "Possessive pronoun (hers / his / theirs)",
      reflexive: "Reflexive (herself / himself / themself)",
    };
    const pronounGroups = people.map(({ person, names }) => {
      const suffix = person > 1 ? "-" + person : "";
      const group = element("section", "pronouns");
      const label = element("label", "field", several ? "Pronouns for person " + person : "Pronouns for this message");
      label.htmlFor = "template-pronouns" + suffix;
      const select = element("select");
      select.id = "template-pronouns" + suffix;
      select.required = true;
      select.setAttribute("aria-describedby", "template-pronoun-hint" + suffix);
      for (const [value, text] of [["", "Choose pronouns…"], ["they/them", "they / them"], ["she/her", "she / her"], ["he/him", "he / him"], ["custom", "Custom forms…"]]) {
        const option = element("option", "", text);
        option.value = value;
        select.appendChild(option);
      }
      label.appendChild(select);
      const hint = element("p", "hint", several
        ? "Used wherever the script says " + names.map((name) => "{" + root.ShorthandTemplate.pronounKey(name, person) + "}").join(", ") + "."
        : "Use one set throughout this message, or enter custom forms.");
      hint.id = "template-pronoun-hint" + suffix;
      const customGroup = element("div", "custom-pronouns");
      const custom = names.map((name) => {
        const customLabel = element("label", "field", customLabels[name]);
        const input = element("input");
        input.id = "template-pronoun-" + name + suffix;
        input.type = "text";
        input.required = true;
        input.autocomplete = "off";
        input.spellcheck = false;
        customLabel.appendChild(input);
        customGroup.appendChild(customLabel);
        return { key: root.ShorthandTemplate.pronounKey(name, person), input };
      });
      group.append(label, hint, customGroup);
      body.appendChild(group);
      return { person, select, custom, customGroup };
    });

    const fieldsPanel = element("section");
    fieldsPanel.id = "template-fields-panel";
    fieldsPanel.setAttribute("role", "tabpanel");
    fieldsPanel.setAttribute("aria-labelledby", "template-view-fields");
    const fieldList = element("table", "field-table");
    const caption = element("caption", "", "One answer for each named blank.");
    const tableHead = element("thead");
    const headerRow = element("tr");
    for (const text of ["Blank", "Your answer"]) {
      const header = element("th", "", text);
      header.scope = "col";
      headerRow.appendChild(header);
    }
    tableHead.appendChild(headerRow);
    const tableBody = element("tbody");
    fieldList.append(caption, tableHead, tableBody);
    const answers = Object.create(null);
    const answerControls = new Map();
    const inputs = fields.map((field, i) => {
      const row = element("tr");
      const rowHeader = element("th");
      rowHeader.scope = "row";
      const label = element("label", "", field.label);
      label.htmlFor = "template-field-" + i;
      rowHeader.appendChild(label);
      const cell = element("td");
      const input = element("input");
      input.id = "template-field-" + i;
      input.type = "text";
      input.dataset.fieldName = field.name;
      input.required = true;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "Enter " + field.label;
      cell.appendChild(input);
      row.append(rowHeader, cell);
      tableBody.appendChild(row);
      answers[field.name] = "";
      answerControls.set(field.name, [input]);
      return { name: field.name, input };
    });
    if (fields.length) fieldsPanel.appendChild(fieldList);
    else fieldsPanel.appendChild(element("p", "no-fields", "This script only needs the pronouns selected above."));

    const messagePanel = element("section");
    messagePanel.id = "template-message-panel";
    messagePanel.setAttribute("role", "tabpanel");
    messagePanel.setAttribute("aria-labelledby", "template-view-message");
    const messageHint = element("p", "message-hint", "Edit the blue blanks in context. Repeated blanks stay linked.");
    messageHint.id = "template-message-hint";
    const message = element("div", "inline-message");
    message.setAttribute("aria-label", "Editable message");
    message.setAttribute("aria-describedby", messageHint.id);
    const inlineInputs = [];
    const inlineVariables = [];
    const seen = new Set();
    const now = new Date();
    for (const part of root.ShorthandTemplate.parts(expansion)) {
      if (part.type === "field") {
        const input = element("input", "inline-input");
        input.id = "template-inline-" + inlineInputs.length;
        input.dataset.fieldName = part.name;
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.placeholder = part.label;
        input.setAttribute("aria-label", part.label);
        input.size = Math.min(30, Math.max(6, part.label.length));
        const first = !seen.has(part.name);
        input.required = first;
        input.tabIndex = first ? 0 : -1;
        if (!first) input.setAttribute("aria-description", "Linked to the other " + part.label + " blanks");
        seen.add(part.name);
        answerControls.get(part.name).push(input);
        inlineInputs.push({ name: part.name, input, first });
        message.appendChild(input);
      } else if (part.type === "variable") {
        const el = element("span", "variable");
        inlineVariables.push({ part, el });
        message.appendChild(el);
      } else {
        message.appendChild(document.createTextNode(root.ShorthandExpander.render(part.value, now).text));
      }
    }
    messagePanel.append(messageHint, message);
    const previewWrap = element("section", "preview-wrap");
    previewWrap.setAttribute("aria-label", "Live preview");
    const previewHeading = element("div", "preview-heading");
    previewHeading.append(element("h3", "", "Your finished text"), element("span", "", "Live preview"));
    const previewEl = element("p", "preview");
    previewEl.id = "template-preview";
    previewWrap.append(previewHeading, previewEl);
    body.append(fieldsPanel, messagePanel, previewWrap);

    const footer = element("footer", "footer");
    const status = element("p", "status");
    status.setAttribute("role", "alert");
    status.hidden = true;
    const actions = element("div", "actions");
    const cancelButton = element("button", "cancel", "Cancel");
    cancelButton.id = "template-cancel";
    cancelButton.type = "button";
    const actionLabel = options.actionLabel || "Insert text";
    const submitButton = element("button", "submit", actionLabel);
    submitButton.id = "template-submit";
    submitButton.type = "submit";
    actions.append(cancelButton, submitButton);
    footer.append(status, actions, element("p", "privacy", "Your answers aren’t saved."));
    form.append(heading, body, footer);
    shadow.appendChild(form);

    const session = {
      host, shadow, form, inputs, expansion, count, preview: previewEl, status,
      answers, answerControls, inlineInputs, inlineVariables, fieldsPanel, messagePanel, previewWrap,
      view: "fields", viewButtons, pronounGroups,
      submit: submitButton, cancel: cancelButton, actionLabel, busy: false,
      previous: document.activeElement, restoreFocus: options.restoreFocus === true,
      onSubmit: options.onSubmit, onCancel: options.onCancel, now,
    };

    // Events stay inside this form instead of reaching the page's bubble handlers.
    // Content-script document capture handlers additionally check isOpen().
    for (const type of ["input", "change", "beforeinput", "keyup", "keypress", "click", "pointerdown", "pointerup", "mousedown", "mouseup", "compositionstart", "compositionupdate", "compositionend"]) {
      shadow.addEventListener(type, (event) => event.stopPropagation());
    }
    shadow.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.isComposing) {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      if (event.target.getAttribute("role") === "tab" && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const index = viewButtons.indexOf(event.target);
        const next = event.key === "Home" ? 0 : event.key === "End" ? viewButtons.length - 1
          : (index + (event.key === "ArrowLeft" ? -1 : 1) + viewButtons.length) % viewButtons.length;
        setView(session, viewButtons[next].dataset.view);
        viewButtons[next].focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel(session);
      } else if (event.key === "Tab") {
        const focusable = focusableControls(session);
        if (!focusable.length) { event.preventDefault(); return; }
        let index = focusable.indexOf(shadow.activeElement);
        if (index < 0 && shadow.activeElement && shadow.activeElement.dataset.fieldName) {
          index = focusable.findIndex((el) => el.dataset.fieldName === shadow.activeElement.dataset.fieldName);
        }
        const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
        event.preventDefault();
        focusable[next].focus();
      }
    });
    for (const [name, controls] of answerControls) {
      for (const input of controls) input.addEventListener("input", () => syncAnswer(session, name, input));
    }
    for (const button of viewButtons) button.addEventListener("click", () => setView(session, button.dataset.view));
    for (const group of pronounGroups) {
      group.select.addEventListener("change", () => {
        updateControls(session);
        preview(session);
      });
      for (const { input } of group.custom) input.addEventListener("input", () => preview(session));
    }
    cancelButton.addEventListener("click", () => cancel(session));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void submit(session);
    });
    // Clicking the surrounding scrim keeps the modal open and focused.
    host.addEventListener("mousedown", (event) => {
      if (event.target === host) event.preventDefault();
      event.stopPropagation();
    });

    current = session;
    setView(session, "fields");
    preview(session);
    (document.body || document.documentElement).appendChild(host);
    (inputs.length ? inputs[0].input : pronounGroups[0].select).focus({ preventScroll: true });
    return true;
  }

  root.ShorthandTemplateForm = { show, close, isOpen: () => current !== null };
})(typeof self !== "undefined" ? self : this);
