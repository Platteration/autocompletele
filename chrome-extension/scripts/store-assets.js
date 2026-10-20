// Capture real extension UI with synthetic snippets in a disposable profile.
// Run npm run build first, then node scripts/store-assets.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const EXTENSION = path.join(ROOT, "dist", "chrome");
const OUTPUT = path.join(ROOT, "store", "images");
const SNIPPETS = [
  { trigger: "hello/", expansion: "Hi [[name]],\n\nYour [[item]] is ready for [[day]].\nLet me know what you think, [[name]].\nAlex" },
  { trigger: "followup/", expansion: "Thanks for the update. I will follow up soon." },
  { trigger: "next/", expansion: "Next step: {cursor} — {date}" },
  { trigger: "sig/", expansion: "Best regards,\nAlex" },
];
const FILLED_HELLO = "Hi Morgan,\n\nYour design brief is ready for Friday.\nLet me know what you think, Morgan.\nAlex";

// This is a local demonstration page, not a screenshot of a third-party service.
function demoHtml(template = false) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>actle — writing demo</title><style>
*{box-sizing:border-box}body{margin:0;background:#ffffff;color:#1b1f24;font:18px/28px system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:80px auto}.brand{display:flex;align-items:baseline;gap:12px;padding-bottom:16px;border-bottom:1px solid #d3d8de;color:#1b1f24}
.brand-short{font-size:26px;font-weight:700;letter-spacing:-.02em}.brand-arrow{color:#59636e;font-size:20px}.brand-full{color:#1a5fd0;font-size:24px;font-weight:650;letter-spacing:-.02em}.demo-label{margin-left:12px;color:#59636e;font-size:11px;line-height:16px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}
.layout{display:grid;grid-template-columns:360px 1fr;gap:64px;margin-top:48px}h1{font-size:36px;line-height:40px;font-weight:700;letter-spacing:-.02em;margin:0 0 24px}
p{color:#59636e}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#1a5fd0;background:#e8effc;border-radius:2px;padding:2px 4px}
.editor{background:#f5f6f8;border-radius:0;padding:24px}
label{display:block;font-weight:650;margin-bottom:12px}textarea{display:block;resize:none;width:100%;height:280px;font:18px/28px system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;border:1px solid #7a838e;border-radius:2px;background:#ffffff;color:#1b1f24}
textarea:focus{border-color:#1a5fd0;outline:2px solid #1a5fd0;outline-offset:2px}.caption{font-size:12px;line-height:18px;color:#59636e;margin:12px 0 0}
</style><main><div class="brand"><span class="brand-short">actle</span><span class="brand-arrow">→</span><span class="brand-full">autocompletele</span><span class="demo-label">Writing demo</span></div>
<div class="layout"><section><h1>${template ? "One script.<br>Make it personal." : "The right words,<br>at your fingertips."}</h1>
${template ? "<p>Type <code>hello/</code> and fill in the details that change.</p><p>Preview your message.<br>Press Enter to insert.</p>" : "<p>Type <code>;;</code> in a supported text field to find a saved snippet.</p><p>Choose with the arrow keys.<br>Press Enter to insert.</p>"}</section>
<section class="editor"><label for="message">Your message</label><textarea id="message"></textarea>
<p class="caption">A local demo using fictional text and the running extension.</p></section></div></main></html>`;
}

function promotionalHtml(icon) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>actle</title><style>
*{box-sizing:border-box}body{margin:0;width:440px;height:280px;padding:32px;background:#0f1115;color:#e7eaee;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:16px;padding-bottom:16px;border-bottom:1px solid #2e343c}img{width:48px;height:48px;border-radius:0}.brand{display:flex;align-items:baseline;gap:8px;white-space:nowrap}strong{font-size:24px;font-weight:700;letter-spacing:-.02em}.brand-arrow{color:#a2aab4;font-size:18px}.brand-full{color:#7aa7ff;font-size:20px;font-weight:650;letter-spacing:-.02em}
h1{font-size:32px;line-height:40px;letter-spacing:-.02em;margin:24px 0;font-weight:700}
p{margin:0;color:#e7eaee;font-size:15px}code{font:650 14px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#1a2840;color:#7aa7ff;border-radius:2px;padding:4px 8px}.example-arrow{padding:0 8px;color:#a2aab4}
</style><header><img src="data:image/png;base64,${icon}" alt=""><div class="brand"><strong>actle</strong><span class="brand-arrow">→</span><span class="brand-full">autocompletele</span></div></header>
<h1>Your repeated text,<br>one shortcut away.</h1><p><code>thanks/</code><span class="example-arrow">→</span>Thanks for your help!</p></html>`;
}

async function main() {
  assert.ok(fs.existsSync(path.join(EXTENSION, "manifest.json")), "Run npm run build first.");
  fs.mkdirSync(OUTPUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shorthand-store-"));
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(demoHtml(request.url === "/template"));
  });
  let context;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 30000 });
    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options.html`);
    // Wait for first-install initialization before replacing the example library.
    await options.waitForFunction(() => document.querySelectorAll("#list tbody tr").length > 0);
    await worker.evaluate(async (snippets) => {
      await self.ShorthandStorage.replaceAll(snippets);
      await self.ShorthandStorage.saveSettings({ enabled: true, excludedHosts: [], pickerTrigger: ";;" });
    }, SNIPPETS);
    await options.reload();
    await options.waitForFunction((count) => document.querySelectorAll("#list tbody tr").length === count, SNIPPETS.length);
    await options.locator("#list tbody tr").filter({ hasText: "hello/" }).getByRole("button", { name: "Edit", exact: true }).click();
    await options.waitForFunction(() => document.getElementById("templateFieldCount").textContent === "3 fill-in blanks");
    await options.locator('button[data-actle-brand][data-actle-state="idle"]').waitFor();
    // Keep the product identity and library together in the store capture.
    await options.evaluate(() => window.scrollTo(0, 0));
    await options.screenshot({ path: path.join(OUTPUT, "chrome-library-1280x800.png") });
    await options.emulateMedia({ colorScheme: "dark" });
    await options.screenshot({ path: path.join(OUTPUT, "chrome-library-dark-1280x800.png") });
    await options.emulateMedia({ colorScheme: "light" });

    const demo = await context.newPage();
    await demo.goto(`http://127.0.0.1:${server.address().port}/`);
    const message = demo.locator("#message");
    await message.fill("Hi Morgan,\n\n");
    await message.pressSequentially(";;fol", { delay: 90 });
    await demo.locator("#shorthand-picker-host").waitFor();
    assert.equal(await message.evaluate((element) => document.activeElement === element), true);
    await demo.screenshot({ path: path.join(OUTPUT, "chrome-picker-1280x800.png") });
    await message.press("Enter");
    assert.equal(await message.inputValue(), "Hi Morgan,\n\nThanks for the update. I will follow up soon.");

    await demo.goto(`http://127.0.0.1:${server.address().port}/template`);
    await message.pressSequentially("hello/", { delay: 90 });
    await demo.locator("#shorthand-template-host").waitFor();
    await demo.keyboard.type("Morgan");
    await demo.keyboard.press("Tab");
    await demo.keyboard.type("design brief");
    await demo.keyboard.press("Tab");
    await demo.keyboard.type("Friday");
    // Move from the last answer through Cancel and Insert to the view tabs.
    // Use the real keyboard controls to show linked blue blanks in the email.
    for (let i = 0; i < 3; i++) await demo.keyboard.press("Tab");
    await demo.keyboard.press("ArrowRight");
    await demo.keyboard.press("Tab");
    await demo.screenshot({ path: path.join(OUTPUT, "chrome-template-1280x800.png") });
    await demo.keyboard.press("Enter");
    await demo.locator("#shorthand-template-host").waitFor({ state: "detached" });
    assert.equal(await message.inputValue(), FILLED_HELLO);

    const promo = await context.newPage();
    await promo.setViewportSize({ width: 440, height: 280 });
    await promo.setContent(promotionalHtml(fs.readFileSync(path.join(ROOT, "icons", "icon128.png")).toString("base64")));
    await promo.screenshot({ path: path.join(OUTPUT, "promo-440x280.png") });
    console.log("Store images written to chrome-extension/store/images/ (synthetic snippets, actual Chromium extension UI).");
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

module.exports = { SNIPPETS, FILLED_HELLO, demoHtml };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
