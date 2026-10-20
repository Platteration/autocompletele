// Fetches the organisation's signed policy layers named in a deployment file,
// verifies each against the pinned public keys, and keeps the last good copy
// of every layer. A layer that cannot be fetched or does not verify falls
// back to its last good copy with a warning; one bad layer never stops the
// others (safety nets degrade, they never refuse).
//
// deployment.json, written by IT at install time:
//   { "policySources": [ { "layer": "organisation", "label": "Organisation", "url": "https://…/org.signed.json" },
//                        { "layer": "shipping", "label": "Shipping", "path": "S:/IT/actle/shipping.signed.json" } ],
//     "publicKeys": [ "-----BEGIN PUBLIC KEY-----…" ],
//     "refreshMinutes": 60 }
"use strict";

const fs = require("node:fs");
const signing = require("./policy-signing.js");

const DEFAULTS = Object.freeze({ refreshMinutes: 60, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 });
// A timer delay above 2^31-1 ms (about 24.8 days) overflows to 1 ms in Node
// and Electron, so the refresh interval is kept between 5 minutes and a day.
const MIN_REFRESH_MINUTES = 5;
const MAX_REFRESH_MINUTES = 1440;

function asText(value) {
  return String(value == null ? "" : value).trim();
}

/** Validate a deployment file. Unusable sources and keys are skipped with a warning. */
function normalizeDeployment(raw) {
  const warnings = [];
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const publicKeys = [];
  for (const pem of Array.isArray(source.publicKeys) ? source.publicKeys : []) {
    try {
      signing.keyId(pem);
      publicKeys.push(String(pem));
    } catch (error) {
      warnings.push("deployment: a public key was ignored (" + error.message + ")");
    }
  }
  const sources = [];
  const seen = new Set();
  (Array.isArray(source.policySources) ? source.policySources : []).forEach((item, index) => {
    const entry = item && typeof item === "object" ? item : {};
    const url = asText(entry.url);
    const path = asText(entry.path);
    const location = url || path;
    const layer = asText(entry.layer);
    if (!location) {
      warnings.push("deployment: policy source " + index + " ignored: no url or path");
      return;
    }
    if (!layer) {
      warnings.push("deployment: policy source " + location + " ignored: it names no layer");
      return;
    }
    if (url && !/^https:\/\//i.test(url)) {
      // Threat: the policy lists internal file locations and rules; over plain
      // HTTP anyone on the network path can read them.
      warnings.push("deployment: policy source " + location + " ignored: only https:// URLs or file paths are allowed");
      return;
    }
    if (seen.has(location)) return;
    seen.add(location);
    sources.push({
      id: signing.sha256(location).slice(0, 16),
      layer,
      label: asText(entry.label) || location,
      url: url || null,
      path: url ? null : path,
      location,
    });
  });
  if (sources.length && !publicKeys.length) {
    warnings.push("deployment: no usable public key; signed policy sources cannot be verified and are not applied");
  }
  const minutes = Number(source.refreshMinutes);
  return {
    sources,
    publicKeys,
    refreshMinutes: Number.isFinite(minutes) && minutes >= MIN_REFRESH_MINUTES
      ? Math.min(minutes, MAX_REFRESH_MINUTES) : DEFAULTS.refreshMinutes,
    warnings,
  };
}

// The size limit is checked before reading where the size is known (a file's
// size, a Content-Length header) and again after reading, for a server that
// sends no length.
async function fetchText(source, options) {
  const maxBytes = options.maxBytes;
  const tooBig = () => new Error("larger than " + maxBytes + " bytes");
  let text;
  if (source.url) {
    const doFetch = options.fetch || globalThis.fetch;
    if (typeof doFetch !== "function") throw new Error("this runtime cannot fetch URLs");
    const response = await doFetch(source.url, { signal: AbortSignal.timeout(options.timeoutMs), redirect: "follow" });
    // Same reason plain http sources are refused: an https source must not
    // hand the policy over plain http through a redirect.
    if (response.url && !/^https:\/\//i.test(response.url)) throw new Error("redirected to a non-https address");
    if (!response.ok) throw new Error("HTTP " + response.status);
    const length = Number(response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : NaN);
    if (Number.isFinite(length) && length > maxBytes) throw tooBig();
    text = await response.text();
  } else if (options.readFile) {
    text = String(await options.readFile(source.path));
  } else {
    const stat = await fs.promises.stat(source.path);
    if (stat.size > maxBytes) throw tooBig();
    text = await fs.promises.readFile(source.path, "utf8");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooBig();
  return text;
}

/**
 * @param {object} options
 *   deployment: raw deployment object
 *   cache: { load(id) -> {envelope, serial, hash, keyId, acceptedAt}|null, save(id, value) }
 *   fetch, readFile, now, timeoutMs, maxBytes: injectable for tests
 */
function createPolicySource(options) {
  const settings = Object.assign({}, DEFAULTS, options || {});
  const now = typeof settings.now === "function" ? settings.now : () => Date.now();
  const deployment = normalizeDeployment(settings.deployment);
  const cache = settings.cache || { load: () => null, save: () => {} };

  /** Verify an envelope for this source: valid signature and the source's own layer. */
  function verifyFor(source, envelope) {
    const verified = signing.verifyEnvelope(envelope, deployment.publicKeys);
    if (!verified.ok) return verified;
    if (verified.layer !== source.layer) {
      return { ok: false, error: "signed for layer " + JSON.stringify(verified.layer) + ", but this source is layer " + JSON.stringify(source.layer) };
    }
    return verified;
  }

  function fromCache(source) {
    const cached = cache.load(source.id);
    if (!cached || typeof cached.envelope !== "string") return null;
    const verified = verifyFor(source, cached.envelope);
    if (!verified.ok) return { error: "last good copy no longer verifies: " + verified.error };
    return { verified, acceptedAt: cached.acceptedAt || null };
  }

  function report(source, fields) {
    return Object.assign({ id: source.id, label: source.label, location: source.location }, fields);
  }

  /** Use only the last good copies (fast, synchronous; for start-up). */
  function loadCached() {
    const layers = [];
    const sources = [];
    const warnings = deployment.warnings.slice();
    for (const source of deployment.sources) {
      const cached = fromCache(source);
      if (cached && cached.verified) {
        layers.push(cached.verified.policy);
        sources.push(report(source, { status: "cached", serial: cached.verified.serial, keyId: cached.verified.keyId, hash: cached.verified.hash, acceptedAt: cached.acceptedAt }));
      } else if (cached) {
        sources.push(report(source, { status: "failed", error: cached.error }));
      } else {
        // Never fetched on this desk: nothing to apply yet, and not a fault.
        sources.push(report(source, { status: "pending" }));
      }
    }
    return { layers, sources, warnings };
  }

  /** Fetch every source, verify it and fall back per source to its last good copy. */
  async function refresh() {
    const layers = [];
    const sources = [];
    const warnings = deployment.warnings.slice();
    for (const source of deployment.sources) {
      let fresh = null;
      let problem = null;
      if (!deployment.publicKeys.length) {
        problem = "no trusted public key";
      } else {
        try {
          const text = await fetchText(source, settings);
          fresh = verifyFor(source, text);
          if (!fresh.ok) {
            problem = fresh.error;
            fresh = null;
          } else {
            fresh.text = text;
          }
        } catch (error) {
          problem = "could not be fetched (" + (error && error.message || error) + ")";
        }
      }
      const cached = fromCache(source);
      const good = cached && cached.verified ? cached.verified : null;
      if (fresh && good) {
        if (fresh.serial < good.serial) {
          problem = "serial " + fresh.serial + " is older than the accepted serial " + good.serial + " (possible replay)";
          fresh = null;
        } else if (fresh.serial === good.serial && fresh.hash !== good.hash) {
          problem = "content changed but the serial stayed at " + fresh.serial;
          fresh = null;
        }
      }
      if (fresh) {
        const unchanged = good && good.hash === fresh.hash;
        const acceptedAt = unchanged && cached.acceptedAt ? cached.acceptedAt : now();
        if (!unchanged) cache.save(source.id, { envelope: fresh.text, serial: fresh.serial, hash: fresh.hash, keyId: fresh.keyId, acceptedAt });
        layers.push(fresh.policy);
        sources.push(report(source, { status: unchanged ? "unchanged" : "fresh", serial: fresh.serial, keyId: fresh.keyId, hash: fresh.hash, acceptedAt }));
        continue;
      }
      if (good) {
        layers.push(good.policy);
        warnings.push("policy source " + source.label + ": " + problem + "; using the last good copy (serial " + good.serial + ")");
        sources.push(report(source, { status: "cached", serial: good.serial, keyId: good.keyId, hash: good.hash, acceptedAt: cached.acceptedAt, error: problem }));
        continue;
      }
      const reason = cached && cached.error ? problem + "; " + cached.error : problem;
      warnings.push("policy source " + source.label + ": " + reason + "; it is not applied");
      sources.push(report(source, { status: "failed", error: reason }));
    }
    return { layers, sources, warnings };
  }

  return { deployment, loadCached, refresh };
}

module.exports = { DEFAULTS, MIN_REFRESH_MINUTES, MAX_REFRESH_MINUTES, normalizeDeployment, createPolicySource };
