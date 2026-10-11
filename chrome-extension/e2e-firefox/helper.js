// Firefox's extension pages require WebDriver; Playwright's Firefox driver does
// not support them. Install the real staged add-on in a disposable profile.
const { Builder, By, Key, until } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");
const { firefox: playwrightFirefox } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const EXTENSION_DIR = path.join(__dirname, "..", "dist", "firefox");
const DEFAULT_SHORTHANDS = [
  { trigger: "cool/", expansion: "That is really cool!" },
  { trigger: "brb/", expansion: "be right back" },
  { trigger: "sig/", expansion: "Regards,\n{cursor}\nAlex" },
  { trigger: "mid/", expansion: "ab{cursor}cd" },
  { trigger: "td/", expansion: "{date}" },
];

async function launch() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
  const id = manifest.browser_specific_settings.gecko.id;
  const uuid = randomUUID();
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "shorthand-firefox-"));
  const downloads = path.join(temporaryDir, "downloads");
  fs.mkdirSync(downloads);
  const fixtures = new Map(["page.html", "strict-csp.html"].map((file) => [
    "/" + file, fs.readFileSync(path.join(__dirname, "..", "e2e", "fixtures", file)),
  ]));
  const server = http.createServer((request, response) => {
    const body = fixtures.get(request.url);
    response.writeHead(body ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body || "Not found");
  });
  let driver;
  async function close() {
    try { if (driver) await driver.quit(); }
    finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const options = new firefox.Options()
      .addArguments("-headless")
      .setBinary(process.env.FIREFOX_PATH || playwrightFirefox.executablePath())
      .setPreference("extensions.webextensions.uuids", JSON.stringify({ [id]: uuid }))
      .setPreference("browser.download.folderList", 2)
      .setPreference("browser.download.dir", downloads)
      .setPreference("browser.download.useDownloadDir", true)
      .setPreference("browser.helperApps.neverAsk.saveToDisk", "application/json");
    // Recent Firefox versions require this for automation of moz-extension
    // pages. It applies only to this disposable WebDriver browser session.
    const service = new firefox.ServiceBuilder(process.env.GECKODRIVER_PATH)
      .addArguments("--allow-system-access")
      .setEnvironment({
        ...process.env,
        XDG_CONFIG_HOME: path.join(temporaryDir, "config"),
        XDG_CACHE_HOME: path.join(temporaryDir, "cache"),
      });
    driver = await new Builder().forBrowser("firefox")
      .setFirefoxOptions(options).setFirefoxService(service).build();
    await driver.manage().setTimeouts({ pageLoad: 15000, script: 10000 });
    const installed = await driver.installWebExtension(EXTENSION_DIR, { permanent: false });
    const extensionURL = `moz-extension://${uuid}`;
    await driver.get(`${extensionURL}/src/options.html`);
    const optionsHandle = await driver.getWindowHandle();
    await driver.wait(async () => (await driver.executeScript(
      "return self.ShorthandStorage.getAll()"
    )).shorthands.length === 3, 10000, "The real installation handler must seed three examples");
    const initialData = await driver.executeScript("return self.ShorthandStorage.getAll()");
    const initialSync = await driver.executeScript("return chrome.storage.sync.get(null)");
    await driver.executeScript((list) => self.ShorthandStorage.replaceAll(list), DEFAULT_SHORTHANDS);
    await driver.switchTo().newWindow("tab");
    const fixtureHandle = await driver.getWindowHandle();
    const fixtureURL = `http://127.0.0.1:${server.address().port}`;

    const element = (selector) => driver.findElement(By.css(selector));
    const value = async (selector) => (await element(selector)).getAttribute("value");
    const text = async (selector) => (await element(selector)).getText();
    const fill = async (selector, value) => {
      const field = await element(selector);
      await field.clear();
      if (value) await field.sendKeys(value);
      return field;
    };
    const waitValue = (selector, expected) => driver.wait(async () =>
      await value(selector) === expected, 5000, `${selector} should contain ${JSON.stringify(expected)}`);
    async function openOptions() {
      await driver.switchTo().window(optionsHandle);
      await driver.get(`${extensionURL}/src/options.html`);
      await driver.wait(until.elementLocated(By.css("#list tbody tr")), 5000);
    }
    async function openFixture(file = "page.html") {
      await driver.switchTo().window(fixtureHandle);
      await driver.get(`${fixtureURL}/${file}`);
    }
    async function settings(patch) {
      await driver.switchTo().window(optionsHandle);
      return driver.executeScript((p) => self.ShorthandStorage.saveSettings(p), patch);
    }
    await openFixture();
    return {
      driver, installed, id, initialData, initialSync, extensionURL,
      temporaryDir, downloads, fixtureHandle, optionsHandle,
      element, value, text, fill, waitValue, openOptions, openFixture, settings, close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { launch, Key, By, until, DEFAULT_SHORTHANDS };
