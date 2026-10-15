// Both packaged browsers run this contract with real keyboard input. Only the
// automation adapter and privileged fixture setup differ; production APIs and
// the accounting/verification modules run unchanged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const LIBRARY = [
  { trigger: "cool/", expansion: "You got it." },
  { trigger: "hello/", expansion: "Hi [[name]]." },
];
const STATE_KEY = "actle-premium";
const NOTICE = "#actle-usage-notice";

function inspectNotice() {
  const root = this.nodeType === 11 ? this : this.getRootNode();
  const buttons = [...root.querySelectorAll("button")].map((button) => {
    const box = button.getBoundingClientRect();
    return { text: button.textContent, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  return { closed: root.host.shadowRoot === null, role: root.querySelector(".message").getAttribute("role"),
    message: root.querySelector(".message").textContent, buttons };
}

function fabricateDismiss() {
  const root = this.nodeType === 11 ? this : this.getRootNode();
  [...root.querySelectorAll("button")].find((button) => button.textContent === "Dismiss").click();
}

async function configuredPackage(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "actle-premium-package-"));
  const extensionPath = path.join(directory, "extension");
  fs.cpSync(source, extensionPath, { recursive: true });
  const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKeyJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
  const config = { dailyLimit: 100, enforceDailyLimit: true,
    checkoutUrl: "https://example.invalid/actle-forever", priceLabel: "", publicKeyJwk };
  // This is the sole changed package file. The private key remains only in
  // this Node process and is neither staged nor committed nor transmitted.
  fs.writeFileSync(path.join(extensionPath, "src", "premium-config.js"),
    `self.ActlePremiumConfig = Object.freeze(${JSON.stringify(config)});\n`);
  async function sign(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const message = `actle1.${encoded}`;
    const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey,
      new TextEncoder().encode(message));
    return `${message}.${Buffer.from(signature).toString("base64url")}`;
  }
  const valid = await sign({ version: 1, product: "actle", plan: "forever", id: "browser-fixture",
    issuedAt: new Date().toISOString() });
  const parts = valid.split(".");
  parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  return { extensionPath, tokens: { valid, invalid: parts.join(".") },
    close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

async function runPreviewCases(t, app) {
  const helpers = contractHelpers(app);
  const { reset, typeInto, waitForValue, used, visible, until } = helpers;

  await t.test("the shipping package shows unlimited preview with purchasing and activation unavailable", async () => {
    await app.options();
    await until(() => visible("#premium"), "Premium card must render");
    await until(async () => (await app.text("#premiumPlan")) === "Free preview", "Preview plan must load");
    assert.match(await app.text("#premiumHint"), /preview/i);
    assert.equal(await app.evaluate(() => document.querySelector("#premiumCheckout").disabled), true);
    assert.equal(await app.evaluate(() => document.querySelector("#premiumActivate").disabled), true);
    const status = await app.status();
    assert.equal(status.enforced, false);
    assert.equal(status.activationAvailable, false);
    assert.equal(status.dailyLimit, 100);
    assert.equal(status.usedToday, 0);
  });

  await t.test("only completed webpage insertions count; undo, cancelled/stale templates and toolbar copying do not", async () => {
    await reset();
    await typeInto("#inp", "cool/");
    await waitForValue("#inp", "You got it.");
    await app.key("Backspace");
    assert.equal(await app.value("#inp"), "cool/");
    await used(1);

    await reset();
    await typeInto("#inp", "co");
    await until(() => visible("#actle-suggestions-host"), "Suggestions must open");
    await app.key("ArrowDown"); await app.key("Enter");
    await waitForValue("#inp", "You got it.");
    await used(2);

    await reset();
    await typeInto("#ta", ";;");
    await until(() => visible("#shorthand-picker-host"), "Picker must open");
    await app.type("cool"); await app.key("Enter");
    await waitForValue("#ta", "You got it.");
    await used(3);

    await reset();
    await typeInto("#inp", "hello/");
    await until(() => visible("#shorthand-template-host"), "Template must open");
    await app.type("Cancelled"); await app.key("Escape");
    assert.equal(await app.value("#inp"), "hello/");
    await used(3);

    await reset();
    await typeInto("#inp", "hello/");
    await until(() => visible("#shorthand-template-host"), "Template must reopen");
    await app.type("Alex"); await app.key("Enter");
    await waitForValue("#inp", "Hi Alex.");
    await used(4);

    await reset();
    await typeInto("#inp", "hello/");
    await until(() => visible("#shorthand-template-host"), "Template must open for stale-target check");
    await app.evaluate(() => { document.querySelector("#inp").value = "Newer draft"; });
    await app.type("Alex"); await app.key("Enter");
    await app.pause(150);
    assert.equal(await app.value("#inp"), "Newer draft");
    assert.equal(await visible("#shorthand-template-host"), true);
    await app.key("Escape");
    await used(4);

    await app.popup();
    await app.fill("#search", "cool/");
    await app.click(".result");
    await until(async () => (await app.text("#toast")) === "Copied cool/", "Toolbar must copy the selected snippet");
    await used(4);
  });

  await t.test("preview remains usable beyond the planned daily allowance", async () => {
    await app.seed({ used: 100 });
    await reset();
    await typeInto("#ce", "cool/");
    await waitForValue("#ce", "You got it.");
    await used(101);
    assert.equal(await visible(NOTICE), false);
    await app.options();
    await until(async () => (await app.text("#premiumUsage")) === "101 today", "Preview usage must update in options");
  });
}

async function runEnforcedCases(t, app, tokens) {
  const { reset, typeInto, waitForValue, used, visible, until } = contractHelpers(app);

  await t.test("a configured package permits the 100th completion, leaves the 101st literal, and keeps undo usable", async () => {
    await app.seed({ used: 99 });
    await reset();
    await typeInto("#inp", "cool/");
    await waitForValue("#inp", "You got it.");
    await app.key("Backspace");
    assert.equal(await app.value("#inp"), "cool/");
    await used(100);
    await reset();
    await typeInto("#inp", "cool/");
    await until(() => visible(NOTICE), "Daily cap must produce a visible notice");
    assert.equal(await app.value("#inp"), "cool/");
    await used(100);
    await app.options();
    await until(async () => (await app.text("#premiumPlan")) === "Free", "Configured package must display Free");
    assert.equal(await app.text("#premiumUsage"), "100 / 100");
    assert.equal(await app.evaluate(() => document.querySelector("#premiumCheckout").disabled), false);
  });

  await t.test("the remaining completion is shared by two page tabs without overshooting", async () => {
    await app.seed({ used: 99 });
    const outcomes = await app.twoTabAttempts();
    assert.deepEqual(outcomes.sort(), ["You got it.", "cool/"].sort());
    await used(100);
  });

  await t.test("a completed template at the cap keeps its answers and explains the daily allowance", async () => {
    await reset();
    await typeInto("#inp", "hello/");
    await until(() => visible("#shorthand-template-host"), "Templates remain available to prepare at the cap");
    await app.type("Alex"); await app.key("Enter");
    await until(async () => /100/.test((await app.template()).error), "The template must show the daily limit error");
    assert.equal(await app.value("#inp"), "hello/");
    assert.equal(await visible("#shorthand-template-host"), true);
    assert.ok((await app.template()).answers.includes("Alex"), "Keep the user's completed answer available");
    await app.key("Escape");
    await used(100);
  });

  await t.test("the cap notice works under strict CSP and dismisses only after a trusted click", async () => {
    await app.fixture("strict-csp.html");
    await app.evaluate(() => {
      window.premiumViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.premiumViolations.push(event.violatedDirective));
    });
    await app.pause(150);
    await typeInto("#inp", "cool/");
    await until(() => visible(NOTICE), "A strict page must still explain the cap");
    const notice = await app.notice();
    assert.equal(notice.closed, true);
    assert.equal(notice.role, "status");
    assert.match(notice.message, /100/);
    assert.deepEqual(await app.evaluate(() => window.premiumViolations), []);
    await app.fakeNoticeDismiss();
    assert.equal(await visible(NOTICE), true);
    const dismiss = notice.buttons.find((button) => button.text === "Dismiss");
    await app.pointer(dismiss.x, dismiss.y);
    await until(async () => !(await visible(NOTICE)), "The user's click must dismiss the notice");
    assert.equal(await app.value("#inp"), "cool/");
    await used(100);
  });

  if (app.delayedClaim) {
    for (const change of ["value", "paused", "username"]) {
      await t.test(`a ${change} change while the real claim waits cancels insertion and refunds its reservation`, async () => {
        await app.delayedClaim(change);
        await used(99);
      });
    }
  }

  await t.test("a forged paid flag cannot unlock completion, and malformed or incorrectly signed keys stay rejected", async () => {
    await app.seed({ used: 100, premium: true, tier: "forever", paid: true,
      licenseToken: tokens.invalid });
    await reset();
    await typeInto("#inp", "cool/");
    await until(() => visible(NOTICE), "Forged state must still enforce the cap");
    assert.equal(await app.value("#inp"), "cool/");
    assert.equal((await app.status()).tier, "free");
    await app.options();
    await app.click("#premiumLicenseDetails summary");
    for (const token of ["not-a-license", tokens.invalid]) {
      await app.fill("#premiumLicense", token);
      await app.click("#premiumActivate");
      await until(() => app.evaluate(() => !document.querySelector("#premiumActivate").disabled
        && document.querySelector("#premiumMsg").dataset.error === "true"), "Invalid activation must explain the failure");
      assert.equal(await app.value("#premiumLicense"), token, "Keep the rejected key available for correction");
      assert.equal(await app.text("#premiumPlan"), "Free");
      assert.equal((await app.status()).tier, "free");
    }
  });

  await t.test("a signed forever key activates through the UI, survives reload, and removal restores the used free allowance", async () => {
    await app.fill("#premiumLicense", tokens.valid);
    await app.click("#premiumActivate");
    await until(async () => (await app.text("#premiumPlan")) === "Forever", "Signed key must activate");
    assert.equal(await app.text("#premiumUsage"), "Unlimited");
    assert.equal(await app.value("#premiumLicense"), "");
    await app.reload();
    await until(async () => (await app.text("#premiumPlan")) === "Forever", "Stored signed license must verify after reload");
    assert.equal((await app.status()).tier, "forever");
    await reset();
    await typeInto("#inp", "cool/");
    await waitForValue("#inp", "You got it.");
    await used(101);
    assert.equal(await visible(NOTICE), false);
    await app.options();
    await app.click("#premiumDeactivate");
    await until(async () => (await app.text("#premiumPlan")) === "Free", "Removing the key must return to Free");
    await reset();
    await typeInto("#inp", "cool/");
    await until(() => visible(NOTICE), "Removing the key must restore the free daily cap");
    assert.equal(await app.value("#inp"), "cool/");
    await used(101);
  });
}

function contractHelpers(app) {
  const visible = (selector) => app.evaluate((selector) => !!document.querySelector(selector), selector);
  async function until(check, message) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await check()) return;
      await app.pause(50);
    }
    assert.fail(message);
  }
  return {
    visible, until,
    reset: async () => { await app.fixture(); await app.pause(150); },
    typeInto: async (selector, text) => { await app.click(selector); await app.type(text); },
    waitForValue: (selector, expected) => until(async () => (await app.value(selector)) === expected,
      `${selector} must contain ${JSON.stringify(expected)}`),
    used: (expected) => until(async () => (await app.status()).usedToday === expected,
      `Committed daily usage must equal ${expected}`),
  };
}

// This function executes only in a privileged extension test page. It does not
// expose a reset feature or alter any production code. Background derives the
// exact same local calendar date when it reads this deterministic fixture.
async function seedState(patch) {
  const now = new Date();
  const day = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")].join("-");
  await chrome.storage.local.set({ "actle-premium": {
    version: 1, day, used: 0, pending: {}, licenseToken: "", ...patch,
  } });
}

module.exports = { LIBRARY, STATE_KEY, configuredPackage, runPreviewCases, runEnforcedCases,
  seedState, inspectNotice, fabricateDismiss };
