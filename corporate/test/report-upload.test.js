const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUploader, RETRY_MS, INTERVALS } = require("../core/report-upload.js");
const orgPolicy = require("../core/org-policy.js");
const { createAssistant } = require("../desktop/assistant.js");

function harness(reporting, options) {
  const calls = [];
  const saved = { value: null };
  const audits = [];
  let clock = 1_000_000;
  const policy = orgPolicy.parse({ organization: "Example", reporting });
  const uploader = createUploader(Object.assign({
    policy: () => policy,
    buildReport: () => ({ format: "actle-usage-report", installId: "desk-1", totals: { inserts: 3 } }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      const response = options && options.response ? options.response : { ok: true, status: 200, url };
      return typeof response === "function" ? response(url, init) : response;
    },
    state: { load: () => saved.value, save: (v) => { saved.value = v; } },
    now: () => clock,
    audit: (entry) => audits.push(entry),
  }, options && options.uploader));
  return { uploader, calls, saved, audits, tick: (ms) => { clock += ms; }, policy };
}

test("without an endpoint nothing is ever sent", async () => {
  const h = harness({});
  assert.equal(h.uploader.isConfigured(), false);
  assert.equal(h.uploader.due(), false);
  const result = await h.uploader.upload();
  assert.equal(result.ok, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.saved.value, null);
  assert.equal(h.uploader.status().configured, false);
});

test("the exact report is posted with the install id and an HMAC when a token is set", async () => {
  const h = harness({ endpoint: "https://collect.example/actle", uploadToken: "s3cret", uploadEvery: "day" });
  assert.equal(h.uploader.due(), true, "never sent yet");
  const result = await h.uploader.upload();
  assert.deepEqual(result, { ok: true, status: 200, bytes: Buffer.byteLength(h.calls[0].init.body) });
  const call = h.calls[0];
  assert.equal(call.url, "https://collect.example/actle");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["x-actle-install"], "desk-1");
  assert.equal(call.init.headers["content-type"], "application/json");
  const expected = "sha256=" + crypto.createHmac("sha256", "s3cret").update(call.init.body).digest("hex");
  assert.equal(call.init.headers["x-actle-signature"], expected);
  assert.deepEqual(JSON.parse(call.init.body), { format: "actle-usage-report", installId: "desk-1", totals: { inserts: 3 } });
  assert.ok(call.init.signal, "a timeout is set");
  assert.equal(h.saved.value.lastBody, call.init.body);
  assert.equal(h.saved.value.lastStatus, "ok");
  assert.deepEqual(h.audits.map((a) => a.event), ["report-uploaded"]);
  assert.equal(h.uploader.due(), false, "just sent");
  h.tick(INTERVALS.day - 1);
  assert.equal(h.uploader.due(), false);
  h.tick(2);
  assert.equal(h.uploader.due(), true);
  const status = h.uploader.status();
  assert.equal(status.signed, true);
  assert.equal(status.every, "day");
  assert.equal(status.nextDueAt, h.saved.value.lastSuccessAt + INTERVALS.day);
});

test("without a token there is no signature header", async () => {
  const h = harness({ endpoint: "https://collect.example/actle" });
  await h.uploader.upload();
  assert.equal(h.calls[0].init.headers["x-actle-signature"], undefined);
  assert.equal(h.uploader.status().signed, false);
});

test("a failed upload is recorded, retried after an hour, and never stops the desk", async () => {
  const h = harness({ endpoint: "https://collect.example/actle" }, { response: { ok: false, status: 500, url: "https://collect.example/actle" } });
  const result = await h.uploader.upload();
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 500/);
  assert.equal(h.saved.value.lastStatus, "failed");
  assert.match(h.saved.value.lastError, /HTTP 500/);
  assert.equal(h.saved.value.lastSuccessAt, undefined);
  assert.deepEqual(h.audits.map((a) => a.event), ["report-upload-failed"]);
  assert.equal(h.uploader.due(), false, "not retried at once");
  h.tick(RETRY_MS);
  assert.equal(h.uploader.due(), true);
  const redirected = harness({ endpoint: "https://collect.example/actle" }, { response: { ok: true, status: 200, url: "http://collect.example/actle" } });
  assert.match((await redirected.uploader.upload()).error, /non-https/);
  const thrown = harness({ endpoint: "https://collect.example/actle" }, { response: () => { throw new Error("ECONNREFUSED"); } });
  assert.match((await thrown.uploader.upload()).error, /ECONNREFUSED/);
});

test("the desk uploads its own report and shows what it sent", async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.ACTLE_TEST_TMP || os.tmpdir(), "actle-upload-"));
  fs.writeFileSync(path.join(dataDir, "policy.json"), JSON.stringify({ organization: "Example", reporting: { team: "Ops", endpoint: "https://collect.example/actle", uploadToken: "t" }, library: [{ trigger: "sig/", expansion: "Kind regards" }] }));
  const posts = [];
  const assistant = createAssistant({ dataDir, fetch: async (url, init) => { posts.push(init.body); return { ok: true, status: 202, url }; } });
  assistant.focusChanged({ process: "notepad" });
  for (const ch of "sig/ ") assistant.keyTyped({ text: ch });
  assert.equal(assistant.uploadDue(), true);
  const result = await assistant.uploadReport();
  assert.equal(result.ok, true);
  const body = JSON.parse(posts[0]);
  assert.equal(body.team, "Ops");
  assert.equal(body.byShortcut[0].trigger, "sig/");
  assert.equal(posts[0].includes("Kind regards"), false, "no inserted text in the upload");
  assert.equal(assistant.uploadStatus().lastBody, posts[0]);
  assert.equal(assistant.uploadDue(), false);
  assert.ok(assistant.audit().some((e) => e.event === "report-uploaded" && e.status === 202));
  const quiet = createAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "actle-noupload-")), fetch: async () => { throw new Error("must not be called"); } });
  assert.equal(quiet.uploadDue(), false);
  assert.equal((await quiet.uploadReport()).ok, false);
});
