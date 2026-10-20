// Signed organisation policies. An administrator signs the policy file with an
// Ed25519 key; every desk pins the public key and refuses a remotely fetched
// policy that does not verify.
//
// Threat: the policy decides which applications are learned from (in effect,
// which keystrokes are written to disk) and which files document shortcuts
// point at. Anyone who can alter the policy on its web server, file share or
// in transit could otherwise switch learning on for every application or
// point "/sld" at a malicious file. The signature stops that; the serial
// stops an attacker replaying an older, validly signed policy; and the
// layer name stops a policy signed for one layer (say the organisation's,
// from before learning was restricted) being replayed at another layer's
// location, where its serial would be compared with the wrong history.
"use strict";

const crypto = require("node:crypto");

const FORMAT = "actle-signed-policy";
const VERSION = 1;

function publicKeyObject(pem) {
  const key = crypto.createPublicKey(String(pem));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 public key");
  return key;
}

/** Short, stable identifier of a public key: the first 16 hex digits of SHA-256 of its DER form. */
function keyId(publicKeyPem) {
  const der = publicKeyObject(publicKeyPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" });
  return {
    publicKey: publicPem,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    keyId: keyId(publicPem),
  };
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Sign a policy. The payload is the exact JSON text that was signed, so no
 * canonical form is needed: desks verify those bytes and then parse them.
 */
function signPolicy(policy, privateKeyPem) {
  const payload = typeof policy === "string" ? policy : JSON.stringify(policy, null, 2);
  const parsed = JSON.parse(payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("the policy must be a JSON object");
  if (!Number.isSafeInteger(parsed.serial) || parsed.serial < 1) throw new Error("the policy needs a positive integer \"serial\"");
  if (typeof parsed.layer !== "string" || !parsed.layer.trim()) throw new Error("the policy needs a \"layer\" name matching its deployment source");
  const privateKey = crypto.createPrivateKey(String(privateKeyPem));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 private key");
  const publicPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return { format: FORMAT, version: VERSION, keyId: keyId(publicPem), signature, payload };
}

/**
 * Verify an envelope against pinned public keys.
 * @returns {{ok:true, policy:object, keyId:string, serial:number, hash:string}|{ok:false, error:string}}
 */
function verifyEnvelope(envelope, trustedPublicKeys) {
  const source = typeof envelope === "string" ? safeParse(envelope) : envelope;
  if (!source || typeof source !== "object") return { ok: false, error: "not a signed policy (not JSON)" };
  if (source.format !== FORMAT) return { ok: false, error: "not a signed policy (format is " + JSON.stringify(source.format) + ")" };
  if (source.version !== VERSION) return { ok: false, error: "unsupported signed policy version " + JSON.stringify(source.version) };
  if (typeof source.payload !== "string" || typeof source.signature !== "string") return { ok: false, error: "signed policy is missing its payload or signature" };
  const keys = [];
  for (const pem of Array.isArray(trustedPublicKeys) ? trustedPublicKeys : []) {
    try {
      keys.push({ id: keyId(pem), key: publicKeyObject(pem) });
    } catch (error) {
      // An unusable pinned key is reported by the caller's deployment check.
    }
  }
  if (!keys.length) return { ok: false, error: "no trusted public key is configured" };
  const match = keys.find((k) => k.id === source.keyId);
  if (!match) return { ok: false, error: "signed by an untrusted key " + JSON.stringify(source.keyId) };
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(source.payload, "utf8"), match.key, Buffer.from(source.signature, "base64"));
  } catch (error) {
    valid = false;
  }
  if (!valid) return { ok: false, error: "the signature does not match the policy" };
  const policy = safeParse(source.payload);
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return { ok: false, error: "the signed payload is not a JSON object" };
  if (!Number.isSafeInteger(policy.serial) || policy.serial < 1) return { ok: false, error: "the signed policy has no positive integer serial" };
  if (typeof policy.layer !== "string" || !policy.layer.trim()) return { ok: false, error: "the signed policy names no layer" };
  return { ok: true, policy, keyId: match.id, serial: policy.serial, layer: policy.layer.trim(), hash: sha256(source.payload) };
}

function safeParse(text) {
  try {
    return JSON.parse(String(text));
  } catch (error) {
    return null;
  }
}

module.exports = { FORMAT, VERSION, keyId, generateKeyPair, sha256, signPolicy, verifyEnvelope };
