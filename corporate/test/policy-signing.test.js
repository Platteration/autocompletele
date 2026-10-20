const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const signing = require("../core/policy-signing.js");

const pair = signing.generateKeyPair();
const other = signing.generateKeyPair();

test("a signed policy verifies against its pinned key", () => {
  const envelope = signing.signPolicy({ layer: "org", serial: 4, organization: "Example" }, pair.privateKey);
  assert.equal(envelope.format, "actle-signed-policy");
  assert.equal(envelope.keyId, pair.keyId);
  assert.match(pair.keyId, /^[0-9a-f]{16}$/);
  const result = signing.verifyEnvelope(JSON.stringify(envelope), [other.publicKey, pair.publicKey]);
  assert.equal(result.ok, true);
  assert.equal(result.serial, 4);
  assert.equal(result.policy.organization, "Example");
  assert.equal(result.hash, signing.sha256(envelope.payload));
});

test("the exact signed text is kept, so formatting cannot change the signature", () => {
  const text = '{"layer":"org","serial":1,  "organization":"Spaced"}';
  const envelope = signing.signPolicy(text, pair.privateKey);
  assert.equal(envelope.payload, text);
  assert.equal(signing.verifyEnvelope(envelope, [pair.publicKey]).ok, true);
});

test("tampering, untrusted keys and malformed envelopes are refused", () => {
  const envelope = signing.signPolicy({ layer: "org", serial: 2, capture: { defaultMode: "triggers" } }, pair.privateKey);
  const tampered = Object.assign({}, envelope, { payload: envelope.payload.replace("triggers", "learn") });
  assert.match(signing.verifyEnvelope(tampered, [pair.publicKey]).error, /signature does not match/);
  assert.match(signing.verifyEnvelope(envelope, [other.publicKey]).error, /untrusted key/);
  // A key id that names the trusted key does not help a forged signature.
  const forged = signing.signPolicy({ layer: "org", serial: 2, capture: { defaultMode: "learn" } }, other.privateKey);
  forged.keyId = pair.keyId;
  assert.match(signing.verifyEnvelope(forged, [pair.publicKey]).error, /signature does not match/);
  assert.match(signing.verifyEnvelope(envelope, []).error, /no trusted public key/);
  assert.match(signing.verifyEnvelope(envelope, ["not a key"]).error, /no trusted public key/);
  assert.match(signing.verifyEnvelope("{nope", [pair.publicKey]).error, /not JSON/);
  assert.match(signing.verifyEnvelope({ serial: 1 }, [pair.publicKey]).error, /format/);
  assert.match(signing.verifyEnvelope(Object.assign({}, envelope, { version: 2 }), [pair.publicKey]).error, /version/);
  assert.match(signing.verifyEnvelope(Object.assign({}, envelope, { signature: 5 }), [pair.publicKey]).error, /missing/);
  assert.match(signing.verifyEnvelope(Object.assign({}, envelope, { signature: "!!!" }), [pair.publicKey]).error, /signature does not match/);
});

test("signing requires a positive serial and an object; verification checks the serial too", () => {
  assert.throws(() => signing.signPolicy({ layer: "org", organization: "x" }, pair.privateKey), /serial/);
  assert.throws(() => signing.signPolicy({ layer: "org", serial: 0 }, pair.privateKey), /serial/);
  assert.throws(() => signing.signPolicy("[1]", pair.privateKey), /JSON object/);
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  assert.throws(() => signing.signPolicy({ layer: "org", serial: 1 }, rsa.privateKey.export({ type: "pkcs8", format: "pem" })), /Ed25519/);
  assert.throws(() => signing.keyId(rsa.publicKey.export({ type: "spki", format: "pem" })), /Ed25519/);
  // A payload without a serial, signed by hand, still fails verification.
  const payload = JSON.stringify({ organization: "no serial" });
  const signature = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(pair.privateKey)).toString("base64");
  const handMade = { format: signing.FORMAT, version: 1, keyId: pair.keyId, signature, payload };
  assert.match(signing.verifyEnvelope(handMade, [pair.publicKey]).error, /serial/);
});

test("a signed policy must name its layer, and verification reports it", () => {
  assert.throws(() => signing.signPolicy({ serial: 1 }, pair.privateKey), /layer/);
  assert.throws(() => signing.signPolicy({ serial: 1, layer: " " }, pair.privateKey), /layer/);
  assert.equal(signing.verifyEnvelope(signing.signPolicy({ serial: 1, layer: " team " }, pair.privateKey), [pair.publicKey]).layer, "team");
  const payload = JSON.stringify({ serial: 1 });
  const signature = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(pair.privateKey)).toString("base64");
  assert.match(signing.verifyEnvelope({ format: signing.FORMAT, version: 1, keyId: pair.keyId, signature, payload }, [pair.publicKey]).error, /names no layer/);
});
