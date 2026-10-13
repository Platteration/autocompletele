const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { generateKeyPairSync, sign, webcrypto } = require("node:crypto");
const license = require("../src/license.js");
const config = require("../src/premium-config.js");

// Every key is generated for this process and discarded. No issuer key ships
// in fixtures, source, snapshots, or the built extension.
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = pair.publicKey.export({ format: "jwk" });
const payload = { version: 1, product: "actle", plan: "forever", id: "test-order_123", issuedAt: "2026-10-13T10:00:00.000Z" };

function signed(value = payload, key = pair.privateKey, prefix = "actle1") {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const message = prefix + "." + bytes.toString("base64url");
  return message + "." + sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

test("premium configuration ships with purchases and enforcement unavailable", async () => {
  assert.deepEqual(config, { dailyLimit: 100, enforceDailyLimit: false, checkoutUrl: "", priceLabel: "", publicKeyJwk: null });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(await license.isConfigured(), false);
  assert.deepEqual(await license.verify(signed()), { valid: false, reason: "unconfigured" });
});

test("a genuine forever license verifies exact signed bytes and normalizes pasted whitespace", async () => {
  const token = signed();
  const result = await license.verify(" \n" + token + "\r\n ", publicKey);
  assert.deepEqual(result, { valid: true, license: payload, token });
  assert.equal(await license.isConfigured(publicKey), true);
  assert.equal((await license.verify(signed({ ...payload, issuedAt: "2000-01-01T00:00:00.000Z" }), publicKey)).valid, true);
  assert.equal((await license.verify(signed({ ...payload, issuedAt: "2099-01-01T00:00:00.000Z" }), publicKey)).valid, true);
});

test("tampered payloads, signatures and a different issuer cannot activate", async () => {
  const token = signed();
  const parts = token.split(".");
  const replacement = Buffer.from(JSON.stringify({ ...payload, id: "changed-order" })).toString("base64url");
  assert.deepEqual(await license.verify(parts[0] + "." + replacement + "." + parts[2], publicKey), { valid: false, reason: "invalid-signature" });
  const bytes = Buffer.from(parts[2], "base64url");
  bytes[10] ^= 1;
  assert.deepEqual(await license.verify(parts.slice(0, 2).join(".") + "." + bytes.toString("base64url"), publicKey), { valid: false, reason: "invalid-signature" });
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.deepEqual(await license.verify(signed(payload, other.privateKey), publicKey), { valid: false, reason: "invalid-signature" });
});

test("token version is fixed and forms part of the signed message", async () => {
  assert.deepEqual(await license.verify(signed(payload, pair.privateKey, "actle2"), publicKey), { valid: false, reason: "unsupported" });
  const token = signed(payload, pair.privateKey, "actle2").replace(/^actle2/, "actle1");
  assert.deepEqual(await license.verify(token, publicKey), { valid: false, reason: "invalid-signature" });
});

test("malformed and oversized tokens are rejected without exposing their contents", async () => {
  const token = signed();
  const [prefix, body, signature] = token.split(".");
  for (const value of [null, undefined, 123, true, {}, [], "", "paid", "actle1", token + ".extra", " ".repeat(4097),
    " ".repeat(4097 - token.length) + token,
    prefix + "." + body + "=." + signature, prefix + "." + body + "." + signature + "=",
    prefix + "." + body + ".+" + signature.slice(1), prefix + "." + body + "." + signature.slice(1),
    prefix + "." + body.slice(0, 20) + "\n" + body.slice(20) + "." + signature,
    signed(Buffer.from(" ".repeat(2049 - Buffer.byteLength(JSON.stringify(payload))) + JSON.stringify(payload))),
    signed(Buffer.from("x".repeat(2049))), signed(Buffer.from([0xff, 0xfe])), signed(Buffer.from("{"))]) {
    assert.deepEqual(await license.verify(value, publicKey), { valid: false, reason: "malformed" });
  }
  // Nonzero unused base64url bits can decode to the same signature bytes;
  // requiring canonical encoding prevents multiple spellings of one token.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)) + 1];
  assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(signature, "base64url"));
  assert.deepEqual(await license.verify(prefix + "." + body + "." + alias, publicKey), { valid: false, reason: "malformed" });
});

test("only the exact forever payload schema is accepted, even with a valid signature", async () => {
  const { id, ...missingId } = payload;
  for (const value of [null, [], true, "premium", missingId, { ...payload, id: "" }, { ...payload, id: "x".repeat(81) },
    { ...payload, id: "person@example.com" }, { ...payload, id: 123 }, { ...payload, issuedAt: "yesterday" },
    { ...payload, issuedAt: "2026-02-30T00:00:00.000Z" }, { ...payload, issuedAt: "2026-10-13T10:00:00Z" },
    { ...payload, issuedAt: 123 }, { ...payload, expiresAt: "2027-01-01T00:00:00.000Z" }, { ...payload, paid: true }]) {
    assert.deepEqual(await license.verify(signed(value), publicKey), { valid: false, reason: "malformed" });
  }
  for (const value of [{ ...payload, version: 2 }, { ...payload, version: "1" }, { ...payload, product: "another-app" }, { ...payload, plan: "monthly" }]) {
    assert.deepEqual(await license.verify(signed(value), publicKey), { valid: false, reason: "unsupported" });
  }
});

test("configuration requires a usable public-only P-256 key", async () => {
  for (const value of [false, "key", [], {}, { ...publicKey, d: "secret" }, pair.privateKey.export({ format: "jwk" }),
    { ...publicKey, kty: "RSA" }, { ...publicKey, crv: "P-384" }, { ...publicKey, alg: "RS256" },
    { ...publicKey, x: "bad" }, { ...publicKey, y: "bad" }, { ...publicKey, x: "A".repeat(43), y: "A".repeat(43) }]) {
    assert.equal(await license.isConfigured(value), false);
    assert.deepEqual(await license.verify(signed(), value), { valid: false, reason: "invalid-config" });
  }
});

function browserModule(cryptoProvider) {
  const context = vm.createContext({ self: {}, crypto: cryptoProvider, TextEncoder, TextDecoder, atob, btoa });
  for (const file of ["premium-config.js", "license.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  }
  return context.self.ActleLicense;
}

test("the real browser global uses WebCrypto and fails closed when crypto is unavailable", async () => {
  const browser = browserModule(webcrypto);
  assert.equal(await browser.isConfigured(publicKey), true);
  assert.equal((await browser.verify(signed(), publicKey)).valid, true);
  for (const provider of [undefined, {}, { subtle: { importKey() { throw new Error("unavailable"); } } }]) {
    const unavailable = browserModule(provider);
    assert.equal(await unavailable.isConfigured(publicKey), false);
    const result = await unavailable.verify(signed(), publicKey);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "unavailable");
  }
});

test("offline issuer creates interoperable licenses and exposes only the public key on request", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "actle-license-test-"));
  const filename = path.join(directory, "ephemeral-key.pem");
  const script = path.join(__dirname, "../scripts/issue-license.js");
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  fs.writeFileSync(filename, pem, { mode: 0o600 });
  try {
    const issue = spawnSync(process.execPath, [script, "--private-key", filename, "--id", payload.id, "--issued-at", payload.issuedAt], { encoding: "utf8" });
    assert.equal(issue.status, 0, issue.stderr);
    assert.equal(issue.stderr, "");
    assert.equal(issue.stdout.includes("PRIVATE KEY"), false);
    assert.deepEqual(await license.verify(issue.stdout, publicKey), { valid: true, license: payload, token: issue.stdout.trim() });
    const exported = spawnSync(process.execPath, [script, "--private-key", filename, "--public-key"], { encoding: "utf8" });
    assert.equal(exported.status, 0, exported.stderr);
    assert.deepEqual(JSON.parse(exported.stdout), publicKey);
    assert.equal(exported.stdout.includes('"d"'), false);
    for (const args of [[], ["--private-key", filename], ["--private-key", filename, "--id", "invalid id"],
      ["--private-key", filename, "--id", payload.id, "--issued-at", "2026-02-30T00:00:00.000Z"],
      ["--private-key", filename, "--id", payload.id, "--unexpected"],
      ["--private-key", filename, "--private-key", filename, "--public-key"],
      ["--private-key", filename + "-missing", "--public-key"]]) {
      const invalid = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, "");
      assert.equal(invalid.stderr.includes(pem), false);
      assert.equal(invalid.stderr.includes(filename), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("offline issuer rejects keys for the wrong algorithm and oversized key files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "actle-license-test-"));
  const filename = path.join(directory, "ephemeral-key.pem");
  const script = path.join(__dirname, "../scripts/issue-license.js");
  try {
    const wrongPair = generateKeyPairSync("ed25519");
    for (const value of [wrongPair.privateKey.export({ format: "pem", type: "pkcs8" }), "x".repeat(65537)]) {
      fs.writeFileSync(filename, value, { mode: 0o600 });
      const invalid = spawnSync(process.execPath, [script, "--private-key", filename, "--id", payload.id], { encoding: "utf8" });
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, "");
      assert.equal(invalid.stderr.includes(value), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
