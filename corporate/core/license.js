// Per-seat business licences. A licence is a signed token issued by the
// vendor (not by the organisation: a policy signer must not be able to grant
// itself seats) and carried inside the signed organisation policy as
// `licence`. Desks verify it offline against the vendor's public keys pinned
// below. Seats are a contract term: the desk never refuses to work, the
// administrator's roll-up counts desks per licence.
//
// A licence names a tier (TIERS below). Without a valid licence a desk runs
// the free tier: shortcuts, templates, the palette, statistics and the local
// report stay; learning, keyword rules and warnings, document shortcuts,
// lookups and report upload are off. Caps on organisation shortcuts and
// policy layers degrade: the desk keeps the first N in policy order and warns,
// it never refuses to expand. Seats are counted in the roll-up only.
"use strict";

const crypto = require("node:crypto");
const { keyId } = require("./policy-signing.js");
const { dropDanglingRules } = require("./org-policy.js");

const PREFIX = "actlebiz1";
const VERSION = 2;
const STATUSES = Object.freeze(["valid", "grace", "expired", "missing", "invalid", "mismatch", "unenforced"]);
const DAY = 86400000;

// The vendor's public keys (PEM). Empty until the owner generates a keypair
// with `actle-admin keygen` and pastes the public key here. While empty, no
// licence can be verified, so licensing is reported as not enforced and every
// feature stays on; the moment a key is pinned, desks without a valid licence
// move to the free tier.
const VENDOR_PUBLIC_KEYS = Object.freeze([]);

// Version 1 tokens have no tier and count as Business, the feature set they promised.
const PAYLOAD_KEYS_BY_VERSION = Object.freeze({
  1: Object.freeze(["id", "organization", "seats", "issuedAt", "expiresAt", "graceDays", "version"]),
  2: Object.freeze(["id", "organization", "tier", "seats", "issuedAt", "expiresAt", "graceDays", "version"]),
});
const PAYLOAD_KEYS = PAYLOAD_KEYS_BY_VERSION[VERSION];

// The tiers, smallest first. `null` means no limit. Never gated or counted in
// any tier: the person's own shortcuts, templates, the palette, statistics,
// the local report, the update server, signing-key rotation and the pause.
function tier(rank, name, limits, features) {
  return Object.freeze({ rank, name, limits: Object.freeze(limits), features: Object.freeze(features) });
}
const EVERYTHING = { learning: true, keywordRules: true, documents: true, lookups: true, upload: true };
const TIERS = Object.freeze({
  free: tier(0, "Free", { seats: 1, shortcuts: 25, layers: 1 }, { learning: false, keywordRules: false, documents: false, lookups: false, upload: false }),
  team: tier(1, "Team", { seats: 25, shortcuts: 1000, layers: 2 }, { learning: true, keywordRules: true, documents: true, lookups: false, upload: false }),
  business: tier(2, "Business", { seats: 500, shortcuts: 10000, layers: 3 }, EVERYTHING),
  enterprise: tier(3, "Enterprise", { seats: null, shortcuts: null, layers: null }, EVERYTHING),
});
const TIER_IDS = Object.freeze(Object.keys(TIERS));
const LICENSED_TIERS = Object.freeze(TIER_IDS.filter((id) => id !== "free"));
const FEATURE_LABELS = Object.freeze({ learning: "learning", keywordRules: "keyword rules and warnings", documents: "document shortcuts", lookups: "lookups", upload: "report upload" });

/** A known tier id, or "free" for anything else. */
function tierOf(id) {
  return TIERS[id] ? id : "free";
}

/** The tier a verified payload grants: its own for version 2, Business for version 1. */
function tierOfLicence(payload) {
  return payload && payload.version === 2 && TIERS[payload.tier] ? payload.tier : "business";
}

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromB64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const buffer = Buffer.from(text, "base64url");
  // Canonical: re-encoding must give the same text.
  return buffer.toString("base64url") === text ? buffer : null;
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value) && Number.isFinite(Date.parse(value));
}

/** Validate a payload's shape. Returns an error string or null. */
function payloadProblem(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "the licence payload is not an object";
  const expected = PAYLOAD_KEYS_BY_VERSION[payload.version];
  if (!expected) return "unsupported licence version " + JSON.stringify(payload.version);
  const keys = Object.keys(payload).sort();
  if (keys.join(",") !== expected.slice().sort().join(",")) return "the licence payload has unexpected or missing fields";
  if (payload.version === 2 && !LICENSED_TIERS.includes(payload.tier)) return "tier must be one of " + LICENSED_TIERS.join(", ");
  if (typeof payload.id !== "string" || !payload.id.trim()) return "the licence has no id";
  if (typeof payload.organization !== "string" || !payload.organization.trim()) return "the licence names no organisation";
  if (!Number.isSafeInteger(payload.seats) || payload.seats < 1) return "seats must be a positive integer";
  if (!isIsoDate(payload.issuedAt) || !isIsoDate(payload.expiresAt)) return "issuedAt and expiresAt must be ISO dates";
  if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) return "expiresAt must be after issuedAt";
  if (!Number.isSafeInteger(payload.graceDays) || payload.graceDays < 0 || payload.graceDays > 365) return "graceDays must be 0 to 365";
  return null;
}

/** Issue a token with the vendor's private key (PEM). Throws on a bad payload or key. */
function issueLicence(fields, vendorPrivateKeyPem) {
  const payload = {
    id: fields && fields.id,
    organization: fields && fields.organization,
    tier: fields && fields.tier === undefined ? "business" : fields.tier,
    seats: fields && fields.seats,
    issuedAt: fields && fields.issuedAt,
    expiresAt: fields && fields.expiresAt,
    graceDays: fields && fields.graceDays === undefined ? 30 : fields.graceDays,
    version: VERSION,
  };
  const problem = payloadProblem(payload);
  if (problem) throw new Error(problem);
  // The seat cap is a term of issue only: a later change to the table must never invalidate a token already out there.
  const seatCap = TIERS[payload.tier].limits.seats;
  if (seatCap != null && payload.seats > seatCap) throw new Error("the " + TIERS[payload.tier].name + " tier allows at most " + seatCap + " seats");
  const privateKey = crypto.createPrivateKey(String(vendorPrivateKeyPem));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 private key");
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = crypto.sign(null, Buffer.from(PREFIX + "." + body, "utf8"), privateKey);
  return PREFIX + "." + body + "." + b64url(signature);
}

/** Verify a token against the vendor's public keys. */
function verifyLicence(token, publicKeys) {
  const text = String(token == null ? "" : token).trim();
  if (!text) return { ok: false, error: "no licence" };
  if (text.length > 4096) return { ok: false, error: "the licence token is too long" };
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: "not a business licence token" };
  const body = fromB64url(parts[1]);
  const signature = fromB64url(parts[2]);
  if (!body || !signature || signature.length !== 64) return { ok: false, error: "the licence token is malformed" };
  const keys = [];
  for (const pem of Array.isArray(publicKeys) ? publicKeys : []) {
    try {
      const key = crypto.createPublicKey(String(pem));
      if (key.asymmetricKeyType === "ed25519") keys.push({ id: keyId(pem), key });
    } catch (error) {
      // an unusable pinned key is skipped
    }
  }
  if (!keys.length) return { ok: false, error: "no vendor key is built in", unenforced: true };
  const signed = Buffer.from(parts[0] + "." + parts[1], "utf8");
  const match = keys.find((k) => {
    try {
      return crypto.verify(null, signed, k.key, signature);
    } catch (error) {
      return false;
    }
  });
  if (!match) return { ok: false, error: "the licence signature does not match" };
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    return { ok: false, error: "the licence payload is not JSON" };
  }
  const problem = payloadProblem(payload);
  if (problem) return { ok: false, error: problem };
  return { ok: true, licence: payload, keyId: match.id };
}

function sameOrganization(a, b) {
  return String(a == null ? "" : a).trim().toLowerCase() === String(b == null ? "" : b).trim().toLowerCase();
}

/**
 * The licence state of a desk.
 * @param {string|null} token from the policy
 * @param {object} options { now (ms), publicKeys (default VENDOR_PUBLIC_KEYS), organization (policy's) }
 * @returns {{status:string, reason:string, licence:object|null, keyId:string|null, daysLeft:number|null}}
 */
function licenceState(token, options) {
  const settings = options || {};
  const now = Number(settings.now) || Date.now();
  const publicKeys = settings.publicKeys === undefined ? VENDOR_PUBLIC_KEYS : settings.publicKeys;
  const base = { licence: null, keyId: null, daysLeft: null };
  if (!(Array.isArray(publicKeys) && publicKeys.length)) {
    return Object.assign(base, { status: "unenforced", reason: "no vendor key is built into this version, so licences cannot be checked; every feature stays on" });
  }
  const text = String(token == null ? "" : token).trim();
  if (!text) return Object.assign(base, { status: "missing", reason: "the organisation policy carries no licence" });
  const verified = verifyLicence(text, publicKeys);
  if (!verified.ok) return Object.assign(base, { status: "invalid", reason: verified.error });
  const licence = verified.licence;
  const state = Object.assign(base, { licence, keyId: verified.keyId });
  if (settings.organization !== undefined && !sameOrganization(licence.organization, settings.organization)) {
    return Object.assign(state, { status: "mismatch", reason: "the licence was issued to " + JSON.stringify(licence.organization) + ", not to this organisation" });
  }
  const expires = Date.parse(licence.expiresAt);
  const graceEnd = expires + licence.graceDays * DAY;
  const daysLeft = Math.ceil((expires - now) / DAY);
  if (now < expires) return Object.assign(state, { status: "valid", reason: "", daysLeft });
  if (now < graceEnd) {
    return Object.assign(state, { status: "grace", daysLeft, reason: "the licence expired on " + licence.expiresAt.slice(0, 10) + "; " + Math.ceil((graceEnd - now) / DAY) + " day(s) of grace remain" });
  }
  return Object.assign(state, { status: "expired", daysLeft, reason: "the licence expired on " + licence.expiresAt.slice(0, 10) + " and the grace period is over" });
}

/**
 * What a desk in this state may do.
 * @param {object} state from licenceState
 * @param {{override?:string|null, allowOverride?:boolean}} [options] the person's testing override
 *   and whether the organisation policy allows one while licensing is enforced
 * @returns {{tier:string, name:string, source:string, licensedTier:string, limits:object, features:object, enforced:boolean,
 *   override:{requested:string|null, honoured:boolean, allowed:boolean, note:string}}}
 */
function entitlements(state, options) {
  const opts = options || {};
  const status = state && state.status ? state.status : "missing";
  const enforced = !!state && status !== "unenforced";
  const licensedTier = status === "unenforced" ? "enterprise" : ["valid", "grace"].includes(status) ? tierOfLicence(state.licence) : "free";
  const requested = TIERS[opts.override] ? opts.override : null;
  const override = { requested, honoured: false, allowed: !enforced || opts.allowOverride === true, note: "" };
  let tier = licensedTier;
  let source = status === "unenforced" ? "unenforced" : "licence";
  if (requested) {
    if (!override.allowed) {
      override.note = "licensing is enforced and the organisation policy does not allow trying other tiers";
    } else if (enforced && TIERS[requested].rank > TIERS[licensedTier].rank) {
      // A hand-edited settings file or a policy signer can never unlock more than the licence grants.
      override.note = TIERS[requested].name + " is above this desk's " + TIERS[licensedTier].name + " tier";
    } else {
      override.honoured = true;
      tier = requested;
      source = "override";
    }
  }
  return {
    tier,
    name: TIERS[tier].name,
    source,
    licensedTier,
    limits: Object.assign({}, TIERS[tier].limits),
    features: Object.assign({}, TIERS[tier].features),
    enforced,
    override,
  };
}

/** The sentence a desk shows for what a tier switches off; empty when nothing is. */
function tierNote(id) {
  const t = TIERS[tierOf(id)];
  const off = Object.keys(FEATURE_LABELS).filter((key) => !t.features[key]).map((key) => FEATURE_LABELS[key]);
  if (!off.length) return "";
  return off.join(", ") + (off.length > 1 ? " are" : " is") + " off until a licence for a higher tier is installed in the organisation policy.";
}

const FREE_TIER_NOTE = tierNote("free");

/** What the policy uses of what the tier counts; measured before anything is trimmed. */
function usage(policy, layers) {
  return { shortcuts: policy && Array.isArray(policy.library) ? policy.library.length : 0, layers: Number.isFinite(layers) ? layers : 0 };
}

/** One warning per cap the policy exceeds; the same text on the desk and in the admin tool. */
function tierWarnings(policy, id, context) {
  const t = TIERS[tierOf(id)];
  const use = usage(policy, context && context.layers);
  const warnings = [];
  const n = (value) => value.toLocaleString("en-US");
  if (t.limits.shortcuts != null && use.shortcuts > t.limits.shortcuts) {
    warnings.push(n(use.shortcuts - t.limits.shortcuts) + " organisation shortcuts ignored: the " + t.name + " tier allows " + n(t.limits.shortcuts) + " (the first " + n(t.limits.shortcuts) + " in policy order are kept)");
  }
  if (t.limits.layers != null && use.layers > t.limits.layers) {
    warnings.push("policy layers: " + use.layers + " applied, the " + t.name + " tier allows " + t.limits.layers + "; nothing was dropped");
  }
  return warnings;
}

/**
 * A parsed policy reduced to what the entitlements allow. The original is not
 * modified; the same object comes back when nothing changes. Features the tier
 * lacks are switched off, organisation shortcuts beyond the cap are dropped from
 * the end (policy order: the organisation layer first, so an entry appended
 * later is the one cut), layers beyond the cap only warn.
 * @param {{layers?:number}} [context] how many policy layers are applied
 */
function applyTier(policy, ent, context) {
  if (!policy || !ent || !ent.features) return policy;
  const f = ent.features;
  const limits = ent.limits || {};
  const capWarnings = tierWarnings(policy, ent.tier, context);
  const honoured = !!(ent.override && ent.override.honoured);
  const allOn = f.learning && f.keywordRules && f.documents && f.lookups && f.upload;
  if (allOn && !capWarnings.length && !honoured) return policy;
  const reduced = Object.assign({}, policy);
  reduced.warnings = policy.warnings.slice();
  if (!f.learning) {
    reduced.capture = {
      defaultMode: policy.capture.defaultMode === "learn" ? "triggers" : policy.capture.defaultMode,
      apps: policy.capture.apps.map((rule) => (rule.mode === "learn" ? Object.assign({}, rule, { mode: "triggers" }) : rule)),
      warnings: policy.capture.warnings,
    };
  }
  if (!f.keywordRules) reduced.keywordRules = [];
  if (!f.documents) reduced.documents = { shortcuts: [] };
  if (!f.lookups) reduced.lookups = [];
  if (!f.upload) reduced.reporting = Object.assign({}, policy.reporting, { endpoint: null });
  if (limits.shortcuts != null && policy.library.length > limits.shortcuts) {
    reduced.library = policy.library.slice(0, limits.shortcuts);
    // A keyword rule that pointed at a shortcut beyond the cap now points at nothing.
    dropDanglingRules(reduced);
  }
  for (const warning of capWarnings) reduced.warnings.push(warning);
  if (honoured) reduced.warnings.push("Testing override: this desk runs the " + ent.name + " tier chosen on the Policy tab, not the tier its licence gives");
  const note = tierNote(ent.tier);
  if (note) reduced.warnings.push(ent.name + " tier: " + note);
  return reduced;
}

module.exports = {
  PREFIX, VERSION, STATUSES, VENDOR_PUBLIC_KEYS, TIERS, TIER_IDS, LICENSED_TIERS, FEATURE_LABELS, FREE_TIER_NOTE,
  tierOf, tierOfLicence, tierNote, payloadProblem, issueLicence, verifyLicence, licenceState, entitlements, usage, tierWarnings, applyTier,
};
