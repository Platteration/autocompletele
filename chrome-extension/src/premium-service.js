// The background owns local usage and license writes. No field text, snippet
// contents, browsing history or payment details enter this protocol or storage.
(function (root) {
  "use strict";

  const STORAGE_KEY = "actle-premium";
  const TOKEN_LIMIT = 8192;
  const RECEIPT = /^[A-Za-z0-9_-]{16,96}$/;
  const ACTION_FIELDS = {
    status: [], claim: [], record: [], deactivate: [], openOptions: [],
    finish: ["id", "success"], activate: ["token"],
  };

  function create({ chrome, config, license, now = () => new Date(), randomId = () => root.crypto.randomUUID() }) {
    const dailyLimit = Number.isSafeInteger(config.dailyLimit) && config.dailyLimit > 0 && config.dailyLimit <= 100000 ? config.dailyLimit : 100;
    let queue = Promise.resolve();

    function calendar() {
      const current = now();
      if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error("The local clock is unavailable.");
      return {
        day: `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`,
        resetsAt: new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).toISOString(),
      };
    }

    function checkout(activationAvailable) {
      let url = "";
      try {
        const candidate = new URL(config.checkoutUrl);
        if (activationAvailable && candidate.protocol === "https:" && !candidate.username && !candidate.password) url = candidate.href;
      } catch (_) { /* Checkout remains unavailable until configured. */ }
      return { available: !!url, url, price: typeof config.priceLabel === "string" ? config.priceLabel.slice(0, 120) : "" };
    }

    function extensionPage(sender) {
      return typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
    }

    function owner(sender) {
      const document = typeof sender.documentId === "string" && sender.documentId.length <= 128 ? sender.documentId : "";
      if (Number.isSafeInteger(sender.tab?.id) && sender.tab.id >= 0 && Number.isSafeInteger(sender.frameId ?? 0) && (sender.frameId ?? 0) >= 0) {
        return `tab:${sender.tab.id}:frame:${sender.frameId ?? 0}:document:${document}`;
      }
      if (extensionPage(sender)) return `extension:document:${document}`;
      throw new Error("This page cannot request an autocomplete allowance.");
    }

    function validRequest(message, sender) {
      if (!sender || sender.id !== chrome.runtime.id) throw new Error("This request did not come from actle.");
      if (!message || message.type !== "actle-premium" || !Object.hasOwn(ACTION_FIELDS, message.action)) throw new Error("Invalid premium request.");
      const fields = ACTION_FIELDS[message.action];
      if (Object.keys(message).some((key) => key !== "type" && key !== "action" && !fields.includes(key))) throw new Error("Invalid premium request.");
      if (message.action === "finish" && (typeof message.id !== "string" || !RECEIPT.test(message.id) || typeof message.success !== "boolean")) throw new Error("Invalid autocomplete receipt.");
      if (message.action === "activate" && (typeof message.token !== "string" || message.token.length === 0 || message.token.length > TOKEN_LIMIT)) throw new Error("Enter a valid forever license.");
      if ((message.action === "activate" || message.action === "deactivate") && !extensionPage(sender)) throw new Error("Manage your license from actle's extension page.");
    }

    async function readState(day) {
      let stored;
      try { stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]; }
      catch (_) { throw new Error("actle could not read local premium data. Try again."); }
      if (stored === undefined) return { version: 1, day, used: 0, pending: {}, licenseToken: "" };
      if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.version !== 1 ||
          typeof stored.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stored.day) ||
          !Number.isSafeInteger(stored.used) || stored.used < 0 ||
          !stored.pending || typeof stored.pending !== "object" || Array.isArray(stored.pending) ||
          typeof stored.licenseToken !== "string" || stored.licenseToken.length > TOKEN_LIMIT) {
        throw new Error("actle could not read local premium data. Its saved format is invalid.");
      }
      const pending = Object.entries(stored.pending);
      if (pending.length > dailyLimit || pending.length > stored.used || pending.some(([id, who]) => !RECEIPT.test(id) || typeof who !== "string" || who.length > 256)) {
        throw new Error("actle could not read local premium data. Its saved receipts are invalid.");
      }
      return { version: 1, day, used: stored.day === day ? stored.used : 0,
        pending: stored.day === day ? Object.fromEntries(pending) : {}, licenseToken: stored.licenseToken };
    }

    async function saveState(state) {
      try { await chrome.storage.local.set({ [STORAGE_KEY]: state }); }
      catch (_) { throw new Error("actle could not save local premium data. Try again."); }
    }

    async function statusFor(state, date) {
      const activationAvailable = await license.isConfigured(config.publicKeyJwk);
      const verified = state.licenseToken ? await license.verify(state.licenseToken, config.publicKeyJwk) : null;
      const checkoutInfo = checkout(activationAvailable);
      return {
        tier: verified?.valid === true ? "forever" : "free",
        usedToday: state.used, dailyLimit, resetsAt: date.resetsAt,
        enforced: config.enforceDailyLimit === true && activationAvailable && checkoutInfo.available,
        checkout: checkoutInfo, activationAvailable,
      };
    }

    async function perform(message, sender) {
      validRequest(message, sender);
      if (message.action === "openOptions") {
        await chrome.runtime.openOptionsPage();
        return { opened: true };
      }
      const date = calendar();
      const state = await readState(date.day);
      let status = await statusFor(state, date);
      if (message.action === "status") return status;
      if (message.action === "activate") {
        if (!status.activationAvailable) throw new Error("Forever license activation is not available in this preview.");
        const verified = await license.verify(message.token, config.publicKeyJwk);
        if (verified?.valid !== true || typeof verified.token !== "string" || verified.token.length > TOKEN_LIMIT) throw new Error("This forever license could not be verified. Check the complete license and try again.");
        state.licenseToken = verified.token;
        await saveState(state);
        return { ...status, tier: "forever" };
      }
      if (message.action === "deactivate") {
        state.licenseToken = "";
        await saveState(state);
        return { ...status, tier: "free" };
      }
      const senderOwner = owner(sender);
      if (message.action === "claim") {
        if (!status.enforced || status.tier === "forever") return { approved: true, id: null, status };
        if (state.used >= dailyLimit) return { approved: false, id: null, status };
        const id = randomId();
        if (typeof id !== "string" || !RECEIPT.test(id) || Object.hasOwn(state.pending, id)) throw new Error("actle could not create an autocomplete receipt. Try again.");
        state.used++;
        state.pending[id] = senderOwner;
        // Persist before granting permission. An interrupted client may retain
        // this one charge; an expiring reservation could let tabs exceed 100.
        await saveState(state);
        return { approved: true, id, status: { ...status, usedToday: state.used } };
      }
      if (message.action === "finish") {
        if (!Object.hasOwn(state.pending, message.id) || state.pending[message.id] !== senderOwner) return { finished: false, status };
        delete state.pending[message.id];
        if (!message.success) state.used--;
        await saveState(state);
        return { finished: true, status: { ...status, usedToday: state.used } };
      }
      if (status.enforced && status.tier !== "forever") throw new Error("An autocomplete allowance must be approved before insertion.");
      if (state.used === Number.MAX_SAFE_INTEGER) throw new Error("The daily autocomplete counter is full.");
      state.used++;
      await saveState(state);
      return { ...status, usedToday: state.used };
    }

    function handle(message, sender) {
      const operation = queue.then(async () => {
        try { return { ok: true, result: await perform(message, sender) }; }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : "actle could not update premium data. Try again." }; }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    }

    function install() {
      chrome.runtime.onMessage.addListener((message, sender, respond) => {
        if (!message || message.type !== "actle-premium") return false;
        handle(message, sender).then(respond);
        return true;
      });
    }

    return { handle, install };
  }

  const api = { create, STORAGE_KEY };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ActlePremiumService = api;
})(typeof self === "object" ? self : globalThis);
