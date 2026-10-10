// Capture the actual Firefox extension using a disposable profile and fictional text.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { launch, By, Key, until } = require("../e2e-firefox/helper.js");
const { SNIPPETS, demoHtml } = require("./store-assets.js");

async function main() {
  const app = await launch();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(demoHtml(true));
  });
  try {
    const { driver } = app;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await app.openOptions();
    await driver.executeScript((snippets) => self.ShorthandStorage.replaceAll(snippets), SNIPPETS);
    await driver.navigate().refresh();
    await driver.wait(async () => await driver.executeScript((count) =>
      document.querySelectorAll("#list tbody tr").length === count, SNIPPETS.length
    ), 5000);
    await driver.findElement(By.xpath("//table[@id='list']//tr[td[@class='trigger' and text()='hello/']]//button[text()='Edit']")).click();
    await driver.wait(() => driver.executeScript(
      "return document.getElementById('templateFieldCount').textContent === '3 fill-in blanks'"
    ), 5000);
    await driver.wait(() => driver.executeScript(
      "return document.querySelector('button[data-actle-brand]')?.dataset.actleState === 'idle'"
    ), 10000);
    await driver.manage().window().setRect({ width: 1280, height: 800 });
    const extra = await driver.executeScript(
      "return {width: outerWidth-innerWidth, height: outerHeight-innerHeight}"
    );
    await driver.manage().window().setRect({ width: 1280 + extra.width, height: 800 + extra.height });
    await driver.executeScript("window.scrollTo(0, 0)");
    const png = Buffer.from(await driver.takeScreenshot(), "base64");
    assert.equal(png.readUInt32BE(16), 1280);
    assert.equal(png.readUInt32BE(20), 800);
    const output = path.join(__dirname, "..", "store", "images", "firefox-library-1280x800.png");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, png);
    // The theme override applies only to this disposable screenshot profile.
    await driver.setContext("chrome");
    await driver.executeScript("Services.prefs.setIntPref('ui.systemUsesDarkTheme', 1)");
    await driver.setContext("content");
    await driver.wait(() => driver.executeScript("return matchMedia('(prefers-color-scheme: dark)').matches"), 5000);
    fs.writeFileSync(path.join(path.dirname(output), "firefox-library-dark-1280x800.png"),
      Buffer.from(await driver.takeScreenshot(), "base64"));

    await driver.setContext("chrome");
    await driver.executeScript("Services.prefs.setIntPref('ui.systemUsesDarkTheme', 0)");
    await driver.setContext("content");
    await driver.switchTo().window(app.fixtureHandle);
    await driver.get(`http://127.0.0.1:${server.address().port}/`);
    await driver.findElement(By.css("#message")).sendKeys("hello/");
    await driver.wait(until.elementLocated(By.css("#shorthand-template-host")), 5000);
    await driver.actions().sendKeys("Morgan", Key.TAB, "design brief", Key.TAB, "Friday").perform();
    const templatePng = Buffer.from(await driver.takeScreenshot(), "base64");
    assert.equal(templatePng.readUInt32BE(16), 1280);
    assert.equal(templatePng.readUInt32BE(20), 800);
    fs.writeFileSync(path.join(path.dirname(output), "firefox-template-1280x800.png"), templatePng);
    await driver.actions().sendKeys(Key.ENTER).perform();
    await driver.wait(async () => await driver.findElement(By.css("#message")).getAttribute("value") ===
      "Hi Morgan,\n\nYour design brief is ready for Friday.\nThanks,\nAlex", 5000);
    console.log("Firefox library and fill-in form screenshots written to store/images/");
  } finally {
    try { await app.close(); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
