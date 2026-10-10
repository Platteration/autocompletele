// Capture the actual Firefox extension using a disposable profile and fictional text.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { launch } = require("../e2e-firefox/helper.js");

async function main() {
  const app = await launch();
  try {
    const { driver } = app;
    await app.openOptions();
    await driver.executeScript((snippets) => self.ShorthandStorage.replaceAll(snippets), [
      { trigger: "thanks/", expansion: "Thanks for your help!" },
      { trigger: "followup/", expansion: "Thanks for the update. I will follow up soon." },
      { trigger: "next/", expansion: "Next step: {cursor} — {date}" },
      { trigger: "sig/", expansion: "Best regards,\nAlex" },
    ]);
    await driver.navigate().refresh();
    await driver.wait(async () => await driver.executeScript(
      "return document.querySelectorAll('#list tbody tr').length === 4"
    ), 5000);
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
    console.log("Firefox light/dark library screenshots written to store/images/");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
