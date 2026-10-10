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
      box-sizing: border-box !important; background: rgb(13 23 43 / 28%) !important;
      color-scheme: light dark !important;
      --panel: #fff; --surface: #f4f7fc; --text: #172033; --muted: #526078;
      --line: #dce3ee; --control: #7d8ba1; --accent: #2357d7; --soft: #eaf0ff;
      --button: #2357d7; --button-hover: #1b46b2; --danger: #b42332;
      --danger-soft: #fff0f1; --shadow: 0 24px 80px rgb(13 23 43 / 25%);
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      width: 440px; max-width: 100%; max-height: 85vh; max-height: 85dvh;
      display: flex; flex-direction: column; overflow: hidden;
      border: 1px solid var(--control); border-radius: 20px;
      color: var(--text); background: var(--panel); box-shadow: var(--shadow);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: left; letter-spacing: normal; word-spacing: normal;
    }
    .heading { padding: 24px 24px 20px; border-bottom: 1px solid var(--line); }
    .eyebrow { margin: 0 0 7px; color: var(--accent); font-size: 10px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
    h2 { margin: 0; font-size: 23px; font-weight: 750; line-height: 1.2; letter-spacing: -.04em; }
    .description { margin: 8px 0 14px; color: var(--muted); font-size: 12px; }
    .meta { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .trigger { min-width: 0; margin: 0; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: var(--accent); font: 650 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .count { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .body { padding: 20px 24px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--control) var(--panel); }
    .fields { display: grid; gap: 15px; }
    .field { display: grid; gap: 6px; font-size: 12px; font-weight: 650; overflow-wrap: anywhere; }
    input {
      width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid var(--control);
      border-radius: 9px; background: var(--panel); color: var(--text);
      font: 400 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    input::placeholder { color: var(--muted); opacity: 1; }
    input:hover:not(:disabled) { border-color: var(--accent); }
    input:focus { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
    input:disabled { background: var(--surface); color: var(--muted); }
    .preview-wrap { margin-top: 22px; padding: 15px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
    .preview-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 9px; }
    .preview-heading h3 { margin: 0; font-size: 10px; font-weight: 750; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
    .preview-heading span { color: var(--muted); font-size: 10px; }
    .preview { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.7; }
    .blank { padding: 1px 4px; border-radius: 4px; color: var(--accent); background: var(--soft); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .footer { flex-shrink: 0; padding: 16px 24px 20px; border-top: 1px solid var(--line); background: var(--panel); }
    .status { margin: 0 0 12px; padding: 10px 12px; border: 1px solid var(--danger); border-radius: 8px; background: var(--danger-soft); color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 10px; }
    button { min-height: 40px; padding: 9px 16px; border: 1px solid var(--control); border-radius: 9px; background: var(--panel); color: var(--text); font: 650 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; }
    button:hover:not(:disabled) { background: var(--soft); border-color: var(--accent); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .submit { flex: 1; border-color: var(--button); background: var(--button); color: #fff; }
    .submit:hover:not(:disabled) { border-color: var(--button-hover); background: var(--button-hover); }
    button:disabled { background: var(--surface); border-color: var(--line); color: var(--muted); cursor: wait; }
    .privacy { margin: 10px 0 0; color: var(--muted); font-size: 10px; text-align: center; }
    @media (max-width: 480px) {
      :host { padding: 10px !important; }
      .panel { border-radius: 16px; }
      .heading { padding: 18px 18px 15px; }
      h2 { font-size: 21px; }
      .body { padding: 17px 18px; }
      .footer { padding: 14px 18px 16px; }
    }
    @media (prefers-color-scheme: dark) {
      :host { --panel: #151d2c; --surface: #101827; --text: #eef2f7; --muted: #a7b4c8;
        --line: #344159; --control: #7f8da5; --accent: #a4bdff; --soft: #233354;
        --button: #315ccc; --button-hover: #3765d9; --danger: #ff9da7; --danger-soft: #3c202e;
      }
    }
    @media (forced-colors: active) {
      .panel, input, button, .trigger, .preview-wrap { border-color: ButtonText; }
      input:focus, button:focus-visible { outline-color: Highlight; }
      .blank { outline: 1px solid Highlight; }
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
    for (const { name, input } of session.inputs) {
      if (includeEmpty || input.value !== "") values[name] = input.value;
    }
    return values;
  }

  function preview(session) {
    const values = valuesFor(session, false);
    const count = Object.keys(values).length;
    session.count.textContent = count + " of " + session.inputs.length + " filled";
    session.preview.textContent = "";
    for (const part of root.ShorthandTemplate.parts(session.expansion)) {
      if (part.type === "field") {
        if (Object.prototype.hasOwnProperty.call(values, part.name)) {
          session.preview.appendChild(document.createTextNode(values[part.name]));
        } else {
          session.preview.appendChild(element("span", "blank", part.label));
        }
      } else {
        const text = root.ShorthandExpander.render(part.value, session.now).text;
        session.preview.appendChild(document.createTextNode(text));
      }
    }
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
    for (const { input } of session.inputs) input.disabled = busy;
    session.submit.disabled = busy;
    session.cancel.disabled = busy;
    session.submit.textContent = busy ? "Working…" : session.actionLabel;
    if (busy) session.form.focus({ preventScroll: true });
  }

  async function submit(session) {
    if (current !== session || session.busy || !session.form.reportValidity()) return;
    const values = valuesFor(session, true);
    const rendered = root.ShorthandTemplate.render(session.expansion, values, new Date());
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
    if (!fields.length || current) return false;

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
    const description = element("p", "description", "Fill in each blank, then " + (/copy/i.test(options.actionLabel || "") ? "copy" : "insert") + ". Repeated blanks share one answer.");
    description.id = "template-description";
    const meta = element("div", "meta");
    const trigger = element("code", "trigger", String(options.trigger || "Template"));
    const count = element("span", "count");
    meta.append(trigger, count);
    heading.append(eyebrow, title, description, meta);

    const body = element("div", "body");
    const fieldList = element("div", "fields");
    const inputs = fields.map((field, i) => {
      const label = element("label", "field");
      const labelText = element("span", "", field.label);
      const input = element("input");
      input.id = "template-field-" + i;
      input.type = "text";
      input.required = true;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "Enter " + field.label;
      label.append(labelText, input);
      fieldList.appendChild(label);
      return { name: field.name, input };
    });
    const previewWrap = element("section", "preview-wrap");
    previewWrap.setAttribute("aria-label", "Live preview");
    const previewHeading = element("div", "preview-heading");
    previewHeading.append(element("h3", "", "Your finished text"), element("span", "", "Live preview"));
    const previewEl = element("p", "preview");
    previewWrap.append(previewHeading, previewEl);
    body.append(fieldList, previewWrap);

    const footer = element("footer", "footer");
    const status = element("p", "status");
    status.setAttribute("role", "alert");
    status.hidden = true;
    const actions = element("div", "actions");
    const cancelButton = element("button", "cancel", "Cancel");
    cancelButton.type = "button";
    const actionLabel = options.actionLabel || "Insert text";
    const submitButton = element("button", "submit", actionLabel);
    submitButton.type = "submit";
    actions.append(cancelButton, submitButton);
    footer.append(status, actions, element("p", "privacy", "Your answers aren’t saved."));
    form.append(heading, body, footer);
    shadow.appendChild(form);

    const session = {
      host, shadow, form, inputs, expansion, count, preview: previewEl, status,
      submit: submitButton, cancel: cancelButton, actionLabel, busy: false,
      previous: document.activeElement, restoreFocus: options.restoreFocus === true,
      onSubmit: options.onSubmit, onCancel: options.onCancel, now: new Date(),
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
      if (event.key === "Escape") {
        event.preventDefault();
        cancel(session);
      } else if (event.key === "Tab") {
        const focusable = [...inputs.map(({ input }) => input), cancelButton, submitButton].filter((el) => !el.disabled);
        if (!focusable.length) { event.preventDefault(); return; }
        const index = focusable.indexOf(shadow.activeElement);
        const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
        event.preventDefault();
        focusable[next].focus();
      }
    });
    fieldList.addEventListener("input", () => preview(session));
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
    preview(session);
    (document.body || document.documentElement).appendChild(host);
    inputs[0].input.focus({ preventScroll: true });
    return true;
  }

  root.ShorthandTemplateForm = { show, close, isOpen: () => current !== null };
})(typeof self !== "undefined" ? self : this);
