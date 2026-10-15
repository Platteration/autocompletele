// Offline, public-key verification. Entitlement is derived from the signed
// token each time it is used, never from a saved "paid" or "premium" flag.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./premium-config.js"));
  else root.ActleLicense = factory(root.ActlePremiumConfig);
})(typeof self !== "undefined" ? self : this, function (config) {
  "use strict";

  const MAX_TOKEN_LENGTH = 4096;
  const MAX_PAYLOAD_BYTES = 2048;
  const payloadKeys = ["id", "issuedAt", "plan", "product", "version"];

  function rejected(reason) { return { valid: false, reason }; }

  function decode(value) {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (canonical !== value) throw new Error("Noncanonical encoding");
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function publicKeyShape(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.prototype.hasOwnProperty.call(value, "d")) return false;
    if (value.kty !== "EC" || value.crv !== "P-256" || (value.alg !== undefined && value.alg !== "ES256")) return false;
    try { return decode(value.x).length === 32 && decode(value.y).length === 32; }
    catch (_) { return false; }
  }

  async function importPublicKey(value) {
    if (value == null) return rejected("unconfigured");
    if (!publicKeyShape(value)) return rejected("invalid-config");
    if (typeof crypto === "undefined" || !crypto.subtle || typeof crypto.subtle.importKey !== "function" || typeof crypto.subtle.verify !== "function") return rejected("unavailable");
    try {
      // Only the required public parameters reach the crypto implementation.
      const key = await crypto.subtle.importKey("jwk", {
        kty: "EC", crv: "P-256", x: value.x, y: value.y,
      }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return { key };
    } catch (_) { return rejected("invalid-config"); }
  }

  function payloadShape(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (Object.keys(value).sort().join(",") !== payloadKeys.join(",")) return false;
    if (typeof value.id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value.id)) return false;
    if (typeof value.issuedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.issuedAt)) return false;
    const timestamp = new Date(value.issuedAt);
    return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value.issuedAt;
  }

  /** Readiness includes an actual crypto import, so unusable keys cannot enable a cap. */
  async function isConfigured(publicKeyJwk = config.publicKeyJwk) {
    return !!(await importPublicKey(publicKeyJwk)).key;
  }

  /** Fixed ES256 format: actle1.base64url(JSON).base64url(raw 64-byte signature). */
  async function verify(value, publicKeyJwk = config.publicKeyJwk) {
    if (typeof value !== "string" || value.length > MAX_TOKEN_LENGTH) return rejected("malformed");
    const token = value.trim();
    const parts = token.split(".");
    if (parts.length !== 3) return rejected("malformed");
    if (parts[0] !== "actle1") return rejected("unsupported");
    let payload, signature;
    try {
      const bytes = decode(parts[1]);
      signature = decode(parts[2]);
      if (bytes.length > MAX_PAYLOAD_BYTES || signature.length !== 64) return rejected("malformed");
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (_) { return rejected("malformed"); }
    if (!payloadShape(payload)) return rejected("malformed");
    if (payload.version !== 1 || payload.product !== "actle" || payload.plan !== "forever") return rejected("unsupported");
    const imported = await importPublicKey(publicKeyJwk);
    if (!imported.key) return imported;
    try {
      // Verify the exact encoded bytes and version prefix, not reserialized JSON.
      const message = new TextEncoder().encode(parts[0] + "." + parts[1]);
      const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, imported.key, signature, message);
      if (!verified) return rejected("invalid-signature");
    } catch (_) { return rejected("unavailable"); }
    return { valid: true, license: payload, token };
  }

  return Object.freeze({ isConfigured, verify });
});
