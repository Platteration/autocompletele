const test = require("node:test");
const assert = require("node:assert/strict");
const signing = require("../core/policy-signing.js");
const { normalizeDeployment, createPolicySource } = require("../core/policy-source.js");

const pair = signing.generateKeyPair();
const rogue = signing.generateKeyPair();
const ORG = "https://intranet.example/actle/org.signed.json";
const TEAM = "S:/IT/actle/shipping.signed.json";

function memoryCache() {
  const data = new Map();
  return { data, load: (id) => data.get(id) || null, save: (id, value) => data.set(id, JSON.parse(JSON.stringify(value))) };
}

function setup(files, extra) {
  const served = Object.assign({}, files);
  const cache = memoryCache();
  const calls = [];
  const source = createPolicySource(Object.assign({
    deployment: { policySources: [{ label: "Organisation", url: ORG }, { label: "Shipping", path: TEAM }], publicKeys: [pair.publicKey] },
    cache,
    now: () => 1000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (!(url in served)) throw new Error("connection refused");
      const body = served[url];
      if (typeof body === "number") return { ok: false, status: body, text: async () => "" };
      return { ok: true, status: 200, text: async () => body };
    },
    readFile: async (p) => {
      if (!(p in served)) throw new Error("ENOENT");
      return served[p];
    },
  }, extra));
  return { source, cache, served, calls };
}

const signed = (policy, key) => JSON.stringify(signing.signPolicy(policy, (key || pair).privateKey));

test("deployment files are validated; plain http and keyless setups are refused with warnings", () => {
  const d = normalizeDeployment({
    policySources: [{ url: "http://insecure.example/p.json" }, { url: ORG, label: "Org" }, { path: TEAM }, { url: ORG }, {}, null],
    publicKeys: ["garbage", pair.publicKey],
    refreshMinutes: 1,
  });
  assert.deepEqual(d.sources.map((s) => s.location), [ORG, TEAM]);
  assert.equal(d.sources[1].label, TEAM);
  assert.equal(d.publicKeys.length, 1);
  assert.equal(d.refreshMinutes, 60, "below five minutes falls back to the default");
  assert.equal(d.warnings.length, 4);
  assert.ok(d.warnings.some((w) => /only https/.test(w)));
  const keyless = normalizeDeployment({ policySources: [{ url: ORG }] });
  assert.ok(keyless.warnings.some((w) => /no usable public key/.test(w)));
  assert.deepEqual(normalizeDeployment(null), { sources: [], publicKeys: [], refreshMinutes: 60, warnings: [] });
});

test("refresh fetches, verifies and caches every layer in order", async () => {
  const { source, cache, calls } = setup({ [ORG]: signed({ serial: 1, organization: "Org" }), [TEAM]: signed({ serial: 7, typing: { charsPerMinute: 250 } }) });
  const result = await source.refresh();
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.layers.map((l) => l.serial), [1, 7]);
  assert.deepEqual(result.sources.map((s) => s.status), ["fresh", "fresh"]);
  assert.equal(cache.data.size, 2);
  assert.ok(calls[0].init.signal, "requests carry a timeout signal");
  const again = await source.refresh();
  assert.deepEqual(again.sources.map((s) => s.status), ["unchanged", "unchanged"]);
  assert.deepEqual(source.loadCached().sources.map((s) => s.status), ["cached", "cached"]);
});

test("an unreachable or tampered source falls back to its last good copy", async () => {
  const env = setup({ [ORG]: signed({ serial: 2, organization: "Org" }), [TEAM]: signed({ serial: 1 }) });
  await env.source.refresh();
  env.served[ORG] = 503;
  const tampered = JSON.parse(signed({ serial: 2 }));
  tampered.payload = tampered.payload.replace("2", "3");
  env.served[TEAM] = JSON.stringify(tampered);
  const result = await env.source.refresh();
  assert.deepEqual(result.layers.map((l) => l.serial), [2, 1]);
  assert.deepEqual(result.sources.map((s) => s.status), ["cached", "cached"]);
  assert.match(result.sources[0].error, /HTTP 503/);
  assert.match(result.sources[1].error, /signature does not match/);
  assert.equal(result.warnings.length, 2);
});

test("an older or same-serial-but-different policy is refused as a possible replay", async () => {
  const env = setup({ [ORG]: signed({ serial: 5, capture: { defaultMode: "triggers" } }), [TEAM]: signed({ serial: 1 }) });
  await env.source.refresh();
  env.served[ORG] = signed({ serial: 4, capture: { defaultMode: "learn" } });
  let result = await env.source.refresh();
  assert.equal(result.layers[0].capture.defaultMode, "triggers");
  assert.match(result.sources[0].error, /older than the accepted serial 5/);
  env.served[ORG] = signed({ serial: 5, capture: { defaultMode: "learn" } });
  result = await env.source.refresh();
  assert.equal(result.layers[0].capture.defaultMode, "triggers");
  assert.match(result.sources[0].error, /serial stayed at 5/);
  env.served[ORG] = signed({ serial: 6, capture: { defaultMode: "learn" } });
  result = await env.source.refresh();
  assert.equal(result.layers[0].capture.defaultMode, "learn");
  assert.equal(result.sources[0].status, "fresh");
});

test("a policy signed by an untrusted key is never applied, even the first time", async () => {
  const env = setup({ [ORG]: signed({ serial: 9, capture: { defaultMode: "learn" } }, rogue), [TEAM]: signed({ serial: 1 }) });
  const result = await env.source.refresh();
  assert.deepEqual(result.layers.map((l) => l.serial), [1]);
  assert.equal(result.sources[0].status, "failed");
  assert.match(result.warnings[0], /untrusted key.*not applied/);
});

test("oversized responses, missing files and missing keys fail per source", async () => {
  const big = setup({ [ORG]: signed({ serial: 1, organization: "x".repeat(200) }), [TEAM]: signed({ serial: 1 }) }, { maxBytes: 100 });
  const result = await big.source.refresh();
  assert.match(result.sources[0].error, /larger than 100 bytes/);
  assert.match(result.sources[1].error, /larger than 100 bytes/);
  const missing = setup({});
  const r2 = await missing.source.refresh();
  assert.deepEqual(r2.sources.map((s) => s.status), ["failed", "failed"]);
  assert.match(r2.sources[1].error, /ENOENT/);
  const keyless = setup({ [ORG]: signed({ serial: 1 }) }, { deployment: { policySources: [{ url: ORG }] } });
  const r3 = await keyless.source.refresh();
  assert.match(r3.sources[0].error, /no trusted public key/);
  assert.equal(r3.layers.length, 0);
});

test("a cached copy signed by a key that was later removed is not used", async () => {
  const env = setup({ [ORG]: signed({ serial: 1 }), [TEAM]: signed({ serial: 1 }) });
  await env.source.refresh();
  const rotated = createPolicySource({
    deployment: { policySources: [{ url: ORG }], publicKeys: [rogue.publicKey] },
    cache: env.cache,
    fetch: async () => { throw new Error("offline"); },
  });
  const cached = rotated.loadCached();
  assert.equal(cached.layers.length, 0);
  assert.match(cached.sources[0].error, /no longer verifies/);
  const refreshed = await rotated.refresh();
  assert.equal(refreshed.layers.length, 0);
  assert.match(refreshed.sources[0].error, /offline.*no longer verifies/);
});

test("before the first fetch a source is pending, not failed", () => {
  const { source } = setup({});
  const cached = source.loadCached();
  assert.deepEqual(cached.sources.map((s) => s.status), ["pending", "pending"]);
  assert.deepEqual(cached.layers, []);
  assert.deepEqual(cached.warnings, []);
});
