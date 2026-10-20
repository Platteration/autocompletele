// Opt-in upload of the counts-only usage report to a collection endpoint the
// organisation names in its policy. Nothing is sent unless the policy sets
// `reporting.endpoint`; the person can see the last upload and exactly what
// it contained on the Policy tab. A failed upload is recorded and retried
// later; the desk keeps working.
//
// The body is the exact report `buildReport` produces (see report.js: counts
// per period, organisation shortcuts by use, never typed text). With
// `reporting.uploadToken` the body is signed with HMAC-SHA256 so the
// collector can drop posts from anyone who merely knows the URL. Desks hold
// no private key and the token sits in every desk's policy cache, so the
// signature proves "sent by a desk holding this policy", no more.
"use strict";

const crypto = require("node:crypto");

const INTERVALS = Object.freeze({ day: 86400000, week: 7 * 86400000 });
const RETRY_MS = 60 * 60 * 1000; // after a failure, wait an hour before the next try
const DEFAULTS = Object.freeze({ timeoutMs: 15000 });

function signBody(body, token) {
  return "sha256=" + crypto.createHmac("sha256", String(token)).update(body, "utf8").digest("hex");
}

/**
 * @param {object} options
 *   policy: () => parsed policy (re-read on every call, so a refresh applies)
 *   buildReport: () => report object
 *   fetch: fetch-like function (injected in tests)
 *   state: { load(): object|null, save(object) }
 *   now: () => ms; audit: (entry) => void; installId: () => string
 */
function createUploader(options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const now = typeof settings.now === "function" ? settings.now : () => Date.now();
  const policyOf = typeof settings.policy === "function" ? settings.policy : () => settings.policy;
  const state = settings.state || { load: () => null, save: () => {} };
  const audit = typeof settings.audit === "function" ? settings.audit : () => {};

  function reporting() {
    const policy = policyOf();
    return (policy && policy.reporting) || {};
  }

  function isConfigured() {
    return typeof reporting().endpoint === "string" && /^https:\/\//i.test(reporting().endpoint);
  }

  function interval() {
    return INTERVALS[reporting().uploadEvery] || INTERVALS.week;
  }

  function loadState() {
    const saved = state.load();
    return saved && typeof saved === "object" ? saved : {};
  }

  /** True when a scheduled upload should run now. */
  function due() {
    if (!isConfigured()) return false;
    const saved = loadState();
    const at = now();
    if (saved.lastAttemptAt && saved.lastStatus !== "ok" && at - saved.lastAttemptAt < RETRY_MS) return false;
    if (!saved.lastSuccessAt) return true;
    return at - saved.lastSuccessAt >= interval();
  }

  async function upload() {
    if (!isConfigured()) return { ok: false, error: "no https endpoint is configured in the policy" };
    const doFetch = settings.fetch || globalThis.fetch;
    if (typeof doFetch !== "function") return { ok: false, error: "this runtime cannot make requests" };
    const endpoint = reporting().endpoint;
    const report = settings.buildReport();
    const body = JSON.stringify(report);
    const headers = { "content-type": "application/json", "x-actle-install": String(report.installId || "") };
    if (reporting().uploadToken) headers["x-actle-signature"] = signBody(body, reporting().uploadToken);
    const attemptAt = now();
    const saved = Object.assign({}, loadState(), { lastAttemptAt: attemptAt, lastBody: body, lastEndpoint: endpoint });
    let result;
    try {
      const response = await doFetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(settings.timeoutMs), redirect: "follow" });
      if (response.url && !/^https:\/\//i.test(response.url)) throw new Error("redirected to a non-https address");
      if (!response.ok) throw new Error("HTTP " + response.status);
      result = { ok: true, status: response.status, bytes: Buffer.byteLength(body, "utf8") };
      Object.assign(saved, { lastSuccessAt: attemptAt, lastStatus: "ok", lastError: null });
      audit({ event: "report-uploaded", status: response.status, bytes: result.bytes, endpoint });
    } catch (error) {
      const message = String(error && error.message || error);
      result = { ok: false, error: message, bytes: Buffer.byteLength(body, "utf8") };
      Object.assign(saved, { lastStatus: "failed", lastError: message });
      audit({ event: "report-upload-failed", error: message, endpoint });
    }
    state.save(saved);
    return result;
  }

  function status() {
    const saved = loadState();
    return {
      configured: isConfigured(),
      endpoint: isConfigured() ? reporting().endpoint : null,
      signed: !!reporting().uploadToken,
      every: reporting().uploadEvery || "week",
      lastAttemptAt: saved.lastAttemptAt || null,
      lastSuccessAt: saved.lastSuccessAt || null,
      lastStatus: saved.lastStatus || null,
      lastError: saved.lastError || null,
      lastBody: saved.lastBody || null,
      nextDueAt: isConfigured() && saved.lastSuccessAt ? saved.lastSuccessAt + interval() : null,
    };
  }

  return { isConfigured, due, upload, status, signBody };
}

module.exports = { INTERVALS, RETRY_MS, DEFAULTS, signBody, createUploader };
