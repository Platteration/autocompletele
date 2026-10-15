// Plan controls live independently of the library, so a plan-service error never
// prevents editing, copying or exporting saved text.
(function () {
  "use strict";
  const card = document.getElementById("premium");
  if (!card) return;
  const premium = self.ActlePremium;
  const get = (id) => document.getElementById(id);
  const plan = get("premiumPlan");
  const usage = get("premiumUsage");
  const hint = get("premiumHint");
  const reset = get("premiumReset");
  const progress = get("premiumProgress");
  const message = get("premiumMsg");
  const checkout = get("premiumCheckout");
  const checkoutHint = get("premiumCheckoutHint");
  const license = get("premiumLicense");
  const activate = get("premiumActivate");
  const deactivate = get("premiumDeactivate");
  const activationHint = get("premiumActivationHint");
  const compact = card.hasAttribute("data-compact");
  let state = null;
  let busy = false;
  let revision = 0;
  let resetTimer = 0;
  let noticeKind = "";

  function say(text, error = false, kind = "action") {
    noticeKind = kind;
    message.textContent = text;
    message.dataset.error = String(error);
  }

  function updateControls() {
    if (!checkout) return;
    const forever = state && state.tier === "forever";
    checkout.disabled = busy || !state || !state.checkout.available || forever;
    license.disabled = busy || !state || !state.activationAvailable || forever;
    activate.disabled = license.disabled;
    deactivate.disabled = busy || !forever;
    card.setAttribute("aria-busy", String(busy));
  }

  function render(next) {
    state = next;
    const forever = next.tier === "forever";
    const preview = !forever && !next.enforced;
    const remaining = Math.max(0, next.dailyLimit - next.usedToday);
    card.dataset.state = forever ? "forever" : preview ? "preview" : remaining ? "free" : "limit";
    plan.textContent = forever ? "Forever" : preview ? "Free preview" : "Free";
    usage.textContent = forever ? "Unlimited" : preview ? `${next.usedToday} today` : `${next.usedToday} / ${next.dailyLimit}`;
    hint.textContent = forever
      ? "Unlimited auto completes. Thanks for supporting actle."
      : preview
        ? compact
          ? `Unlimited during preview. Free plan: ${next.dailyLimit} per day when it launches.`
          : `Unlimited during preview. The free plan will include ${next.dailyLimit} auto completes per day when it launches.`
        : remaining
          ? `${remaining} auto complete${remaining === 1 ? "" : "s"} left today.`
          : compact
            ? "Daily limit reached. Toolbar copying still works."
            : "Today's auto completes are used. More at midnight; toolbar copying stays available.";
    reset.hidden = forever;
    reset.textContent = compact ? "Resets at local midnight · This browser" : "Daily count resets at local midnight.";
    progress.hidden = forever || preview;
    progress.max = next.dailyLimit;
    progress.value = Math.min(next.dailyLimit, next.usedToday);
    progress.setAttribute("aria-valuetext", `${next.usedToday} of ${next.dailyLimit} daily auto completes used`);
    if (checkout) {
      get("premiumUpgrade").hidden = forever;
      get("premiumThanks").hidden = !forever;
      checkout.textContent = next.checkout.available
        ? next.checkout.price ? `Get Forever · ${next.checkout.price}` : "Get a Forever license"
        : "Forever license — coming soon";
      checkoutHint.textContent = next.checkout.available
        ? "Opens checkout in a new tab. One payment, with no recurring charge. Keep the license key you receive."
        : "Purchases aren't available yet. The price and checkout will appear here when ready.";
      activationHint.textContent = next.activationAvailable
        ? "Paste the complete key from your purchase. Activation stays in this browser; keep your key for another installation."
        : "License activation will be available when purchases launch.";
    }
    updateControls();
    clearTimeout(resetTimer);
    const delay = new Date(next.resetsAt).getTime() - Date.now() + 100;
    resetTimer = setTimeout(refresh, Number.isFinite(delay) && delay > 0 ? Math.min(delay, 86400100) : 60000);
  }

  async function refresh() {
    const current = ++revision;
    try {
      const next = await premium.status();
      if (current !== revision) return;
      render(next);
      if (noticeKind === "load") say("", false, "");
    } catch (_) {
      if (current !== revision) return;
      if (!state) {
        plan.textContent = "Plan unavailable";
        usage.textContent = "—";
        hint.textContent = "Your saved library and toolbar copying are still available.";
        progress.hidden = true;
      }
      say("Could not load your plan. Reopen this page to try again.", true, "load");
    }
  }

  async function runAction(button, pending, operation, success) {
    if (busy || button.disabled) return;
    busy = true;
    let moved = false;
    const noteFocus = (event) => {
      if (event.target !== button && event.target !== document.body) moved = true;
    };
    document.addEventListener("focusin", noteFocus);
    say(pending);
    updateControls();
    try {
      await operation();
      await refresh();
      // A successful write followed by a failed status read needs the read
      // warning to remain visible; it must not look fully confirmed.
      if (noticeKind !== "load") say(success);
    } catch (error) {
      say(error && typeof error.message === "string" ? error.message : "That didn't work. Please try again.", true);
    } finally {
      document.removeEventListener("focusin", noteFocus);
      busy = false;
      updateControls();
      if (!moved && (!document.activeElement || document.activeElement === document.body || document.activeElement === button)) {
        const target = button.closest("[hidden]") || button.disabled ? get("premiumTitle") : button;
        if (target) target.focus({ preventScroll: true });
      }
    }
  }

  if (checkout) {
    checkout.addEventListener("click", () => runAction(checkout, "Opening checkout…",
      () => premium.openCheckout(), "Checkout opened in a new tab."));
    get("premiumLicenseForm").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!license.value.trim()) {
        say("Paste your Forever license key first.", true);
        license.focus();
        return;
      }
      runAction(activate, "Activating license…", async () => {
        await premium.activate(license.value.trim());
        license.value = "";
      }, "Forever is active. Thanks for supporting actle.");
    });
    deactivate.addEventListener("click", () => runAction(deactivate, "Removing license…",
      () => premium.deactivate(), "License removed from this browser. You can activate it again with your key."));
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.prototype.hasOwnProperty.call(changes, "actle-premium")) refresh();
  });
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener("pagehide", () => clearTimeout(resetTimer));
  refresh();
}());
