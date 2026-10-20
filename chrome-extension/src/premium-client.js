// Keep editor changes synchronous during the free preview. When the daily limit
// is enabled, the background service reserves a use before touching the editor.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = { createClient: factory };
  else root.ActlePremium = factory({ root, chrome, config: root.ActlePremiumConfig });
})(typeof self !== "undefined" ? self : this, function createClient(dependencies) {
  "use strict";

  const { root = {}, chrome, config = {}, notice } = dependencies || {};

  let errorText = "";
  let noticeHost = null;
  let noticeText = null;
  let noticeManage = true;
  const STALE = "That field changed before actle could insert the text. Try the shortcut again.";
  const FAILED = "actle couldn’t insert this text. Try the shortcut again.";
  const UNSAVED = "Text inserted, but today’s usage could not be saved. Open Manage plan to check your usage.";

  async function request(action, values = {}) {
    const response = await chrome.runtime.sendMessage({ type: "actle-premium", action, ...values });
    if (!response || typeof response.ok !== "boolean") throw new Error("No valid response from actle. Reopen the extension and try again.");
    if (!response.ok) throw new Error(typeof response.error === "string" && response.error ? response.error : "actle could not complete this request.");
    return response.result;
  }

  function closeNotice() {
    if (noticeHost) noticeHost.remove();
    noticeHost = null;
    noticeText = null;
  }

  function showNotice(message, manageButton = true) {
    if (notice) { notice(message); return; }
    const document = root.document;
    if (!document || !document.documentElement) return;
    if (noticeHost && noticeHost.isConnected && noticeManage === manageButton) {
      noticeText.textContent = message;
      return;
    }
    closeNotice();
    noticeManage = manageButton;
    noticeHost = document.createElement("div");
    noticeHost.id = "actle-usage-notice";
    const shadow = noticeHost.attachShadow({ mode: "closed" });
    // Constructed sheets also work on pages with strict inline-style CSP.
    const sheet = new root.CSSStyleSheet();
    sheet.replaceSync(`
      :host { all: initial !important; position: fixed !important;
        right: 12px !important; bottom: 12px !important; z-index: 2147483647 !important;
        display: block !important; width: 350px !important; max-width: calc(100vw - 24px) !important;
        margin: 0 !important; padding: 0 !important; border: 0 !important;
        color-scheme: light dark; --bg: #fff; --sunken: #eceef1; --ink: #1b1f24; --muted: #59636e;
        --line: #d3d8de; --control: #7a838e; --accent: #1a5fd0; --frame: #1b1f24;
        --shadow: 0 4px 16px rgb(0 0 0 / 12%); }
      .notice { box-sizing: border-box; padding: 0; border: 1px solid var(--frame);
        border-radius: 0; background: var(--bg); color: var(--ink);
        box-shadow: var(--shadow);
        font: 13px/20px system-ui, -apple-system, "Segoe UI", sans-serif; }
      .brand { padding: 8px 16px; border-bottom: 1px solid var(--line); color: var(--muted);
        font: 650 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .08em; text-transform: uppercase; }
      .message { margin: 12px 16px 16px; overflow-wrap: anywhere; }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 16px; }
      button { font: 650 12px/16px system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink);
        background: transparent; border: 1px solid var(--control); border-radius: 2px;
        min-height: 36px; padding: 8px 12px; cursor: pointer; }
      button:hover { background: var(--sunken); }
      button:active { background: var(--line); }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      button:disabled { color: var(--muted); cursor: wait; background: var(--sunken); }
      @media (prefers-color-scheme: dark) {
        :host { --bg: #0f1115; --sunken: #1c2026; --ink: #e7eaee; --muted: #a2aab4;
          --line: #2e343c; --control: #7d8691; --accent: #7aa7ff; --frame: #7d8691; --shadow: none; }
      }
      @media (forced-colors: active) {
        .notice, button { border-color: ButtonText; }
        button:focus-visible { outline-color: Highlight; }
      }
    `);
    shadow.adoptedStyleSheets = [sheet];
    const panel = document.createElement("div");
    panel.className = "notice";
    const brand = document.createElement("div");
    brand.className = "brand";
    brand.textContent = "actle";
    noticeText = document.createElement("p");
    noticeText.className = "message";
    noticeText.setAttribute("role", "status");
    noticeText.setAttribute("aria-live", "polite");
    noticeText.setAttribute("aria-atomic", "true");
    const actions = document.createElement("div");
    actions.className = "actions";
    const manage = document.createElement("button");
    manage.type = "button";
    manage.textContent = "Manage plan";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", (event) => { if (event.isTrusted) closeNotice(); });
    manage.addEventListener("click", async (event) => {
      if (!event.isTrusted || manage.disabled) return;
      manage.disabled = true;
      try {
        await request("openOptions");
        closeNotice();
      } catch (_) {
        report("actle couldn’t open Manage plan. Open the extension’s settings from your browser toolbar.");
      } finally {
        manage.disabled = false;
      }
    });
    if (manageButton) actions.append(manage);
    actions.append(dismiss);
    panel.append(brand, noticeText, actions);
    shadow.append(panel);
    document.documentElement.append(noticeHost);
    noticeText.textContent = message;
  }

  function report(message, options = {}) {
    errorText = message;
    if (options.notice === false) return;
    // UI failure must not reject an accounting promise or undo an insertion.
    try { showNotice(message); } catch (_) { /* The API retains lastError for extension UI. */ }
  }

  function validTarget(validate, options) {
    try {
      const valid = validate();
      if (valid && typeof valid.then === "function") {
        // Preview cannot await a target check without changing the trusted
        // input lifecycle. Handle a rejected validator before failing closed.
        void Promise.resolve(valid).catch(() => {});
        throw new TypeError("Preview validation must be synchronous");
      }
      if (valid) return true;
    } catch (_) { /* A detached or protected field is no longer a target. */ }
    report(STALE, options);
    return false;
  }

  async function validTargetReserved(validate, options) {
    try {
      if (await validate()) return true;
    } catch (_) { /* Settings reads and target checks may fail after a claim. */ }
    report(STALE, options);
    return false;
  }

  function insert(action, options) {
    try {
      if (action() !== false) return true;
    } catch (_) { /* Preserve the typed trigger when the editor rejects insertion. */ }
    report(FAILED, options);
    return false;
  }

  async function saveInsertion(id) {
    try {
      if (id) await request("finish", { id, success: true });
      else await request("record");
    } catch (_) {
      // Even template callers need this visible after their successful form
      // closes. Never refund or undo text that was already inserted.
      report(UNSAVED);
    }
  }

  async function release(id, options) {
    if (!id) return;
    try { await request("finish", { id, success: false }); }
    catch (_) { report("No text inserted, but actle couldn’t release the reserved autocomplete. Open Manage plan to check your usage.", options); }
  }

  function deniedMessage(status) {
    const limit = status && Number.isSafeInteger(status.dailyLimit) ? status.dailyLimit : 100;
    return `You’ve used today’s ${limit} free autocompletes. Your allowance resets at local midnight. Manage your plan for a forever license.`;
  }

  async function executeReserved(action, validate, options) {
    if (!await validTargetReserved(validate, options)) return false;
    let claim;
    try {
      claim = await request("claim");
      if (!claim || typeof claim.approved !== "boolean"
          || (claim.id !== null && (typeof claim.id !== "string" || !claim.id))) throw new Error("Invalid reservation response");
    } catch (_) {
      report("actle couldn’t check today’s allowance. Your text has not been changed. Try again or open Manage plan.", options);
      return false;
    }
    if (!claim.approved) {
      report(deniedMessage(claim.status), options);
      return false;
    }
    if (!await validTargetReserved(validate, options) || !insert(action, options)) {
      await release(claim.id, options);
      return false;
    }
    void saveInsertion(claim.id);
    return true;
  }

  function execute(action, validate, options = {}) {
    errorText = "";
    if (config.enforceDailyLimit === true) return executeReserved(action, validate, options);
    if (!validTarget(validate, options) || !insert(action, options)) return false;
    // Intentionally no await: the normal trusted-input/selection lifecycle is
    // unchanged in preview, and saveInsertion handles rejected writes itself.
    void saveInsertion(null);
    return true;
  }

  async function openCheckout() {
    const current = await request("status");
    if (!current || !current.checkout || current.checkout.available !== true) throw new Error("Checkout is not available yet.");
    let url;
    try { url = new URL(current.checkout.url); } catch (_) { throw new Error("The configured checkout address is invalid."); }
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("The configured checkout address is invalid.");
    if (!chrome.tabs || typeof chrome.tabs.create !== "function") throw new Error("Open checkout from the extension’s Manage plan page.");
    await chrome.tabs.create({ url: url.href });
  }

  return {
    status: () => request("status"),
    activate: (token) => request("activate", { token }),
    deactivate: () => request("deactivate"),
    openCheckout,
    execute,
    lastError: () => errorText,
    // A page message without the plan button, for notices about the page itself.
    notify: (message) => { try { showNotice(message, false); } catch (_) { /* Best effort. */ } },
    closeNotice,
  };
});
