// Shared setup for the end-to-end tests: launch Chromium with the unpacked
// extension loaded, seed a known list of shorthands, and open the fixture page.
//
// Chromium is pre-installed in CI and in the dev container; CHROMIUM_PATH
// overrides the location if it lives somewhere else.
const { chromium } = require("playwright");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const EXTENSION_DIR = path.join(__dirname, "..");
const FIXTURE = "file://" + path.join(__dirname, "fixtures", "page.html");

const DEFAULT_SHORTHANDS = [
  { trigger: "cool/", expansion: "That is really cool!" },
  { trigger: "verycool/", expansion: "Extremely cool!" },
  { trigger: "brb/", expansion: "be right back" },
  { trigger: "addr/", expansion: "123 Example Street" },
  { trigger: "sig/", expansion: "Regards,\n{cursor}\nAlex" },
  { trigger: "mid/", expansion: "ab{cursor}cd" },
  { trigger: "td/", expansion: "{date}" },
];

/**
 * Start a browser with the extension loaded.
 * @param {{shorthands?: Array, settings?: object}} [options]
 */
async function launch(options = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shorthand-e2e-"));
  const args = [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--headless=new",
    "--no-sandbox",
  ];
  const launchOptions = { headless: true, args };
  const executablePath = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
  if (fs.existsSync(executablePath)) launchOptions.executablePath = executablePath;

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);

  // The service worker owns storage; wait for it, then seed through it.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(async (shorthands) => {
    // Give the install handler time to seed its examples before replacing them.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await self.ShorthandStorage.replaceAll(shorthands);
  }, options.shorthands || DEFAULT_SHORTHANDS);
  if (options.settings) {
    await worker.evaluate((s) => self.ShorthandStorage.saveSettings(s), options.settings);
  }

  const errors = [];
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(FIXTURE);
  // Let the content script pick up the seeded list.
  await page.waitForTimeout(400);

  async function close() {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  return { context, page, worker, errors, close, extensionId: new URL(worker.url()).host };
}

/** True when the picker overlay is present in the page. */
function pickerVisible(page) {
  return page.evaluate(() => !!document.getElementById("shorthand-picker-host"));
}

module.exports = { launch, pickerVisible, DEFAULT_SHORTHANDS, FIXTURE, EXTENSION_DIR };
