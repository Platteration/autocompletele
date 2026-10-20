// The Writing pad: drafts that save on this device as you type.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { launch } = require("./helper.js");

function padUrl(app) {
  return `chrome-extension://${app.extensionId}/src/pad.html`;
}

async function openPad(app, page) {
  page = page || await app.context.newPage();
  page.on("pageerror", (e) => app.errors.push("pad: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") app.errors.push("pad: " + m.text());
  });
  await page.goto(padUrl(app));
  await waitReady(page);
  return page;
}

// The editor is read-only until the pad has loaded its drafts.
function waitReady(page) {
  return page.waitForFunction(() => !document.getElementById("suggestToggle").disabled);
}

function saveState(page) {
  return page.locator("#padSave").textContent();
}

function waitSaved(page) {
  return page.waitForFunction(() => /^Saved\b/.test(document.getElementById("padSave").textContent));
}

function stored(app) {
  return app.worker.evaluate(() => chrome.storage.local.get(null));
}

async function storedDrafts(app) {
  const items = await stored(app);
  return Object.entries(items).filter(([key]) => key.startsWith("pad-draft:")).map(([, value]) => value);
}

async function typeInBody(page, text) {
  await page.click("#padBody");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

test("the toolbar popup opens the Writing pad in a new tab", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const popup = await app.context.newPage();
  popup.on("pageerror", (e) => app.errors.push("popup: " + String(e)));
  await popup.goto(`chrome-extension://${app.extensionId}/src/popup.html`);
  await popup.waitForSelector(".result");
  const [pad] = await Promise.all([app.context.waitForEvent("page"), popup.click("#pad")]);
  await pad.waitForLoadState();
  assert.equal(pad.url(), padUrl(app));
  assert.equal(await pad.title(), "Writing pad · actle");
  assert.deepEqual(app.errors, []);
});

test("the library sidebar links to the Writing pad in a new tab", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const options = await app.context.newPage();
  await options.goto(`chrome-extension://${app.extensionId}/src/options.html`);
  const link = options.locator(".sidebar-nav a", { hasText: "Writing pad" });
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener");
  const [pad] = await Promise.all([app.context.waitForEvent("page"), link.click()]);
  await pad.waitForLoadState();
  assert.equal(pad.url(), padUrl(app));
  assert.equal(await pad.locator(".pad-library-link").getAttribute("href"), "options.html");
});

test("writing in the pad", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);

  await t.test("opening the pad makes no empty draft", async () => {
    assert.equal(await page.isVisible("#padIntro"), true);
    assert.equal(await page.isVisible("#draftsEmpty"), true);
    await page.waitForTimeout(2500); // past the 2 s editor check
    assert.deepEqual(await storedDrafts(app), []);
  });

  await t.test("typed text is saved on this device and survives a reload", async () => {
    await typeInBody(page, "Dear Sam, the plan is ready");
    await page.fill("#padTitle", "Plan for Sam");
    await waitSaved(page);
    const [draft] = await storedDrafts(app);
    assert.equal(draft.title, "Plan for Sam");
    assert.equal(draft.body, "Dear Sam, the plan is ready");
    const sync = await app.worker.evaluate(() => chrome.storage.sync.get(null));
    assert.equal(Object.keys(sync).some((key) => key.startsWith("pad-")), false, "drafts never reach sync storage");
    assert.equal(await page.textContent("#draftList .draft-title"), "Plan for Sam");
    assert.equal(await page.textContent("#padWords"), "6 words");

    await page.reload();
    await waitReady(page);
    assert.equal(await page.inputValue("#padBody"), "Dear Sam, the plan is ready");
    assert.equal(await page.inputValue("#padTitle"), "Plan for Sam");
    assert.equal(await page.isVisible("#padIntro"), false);
    assert.match(await saveState(page), /^Saved /);
  });

  await t.test("a saved shortcut expands in the pad, and the expansion is saved", async () => {
    await typeInBody(page, ". cool/");
    await page.waitForFunction(() => document.getElementById("padBody").value.endsWith("That is really cool!"));
    await waitSaved(page);
    await page.reload();
    await waitReady(page);
    assert.equal(await page.inputValue("#padBody"), "Dear Sam, the plan is ready. That is really cool!");
  });

  await t.test("Ctrl+S saves at once instead of opening the browser's save dialog", async () => {
    await typeInBody(page, " Thanks");
    await page.keyboard.press("Control+s");
    await waitSaved(page);
    assert.equal((await storedDrafts(app))[0].body.endsWith(" Thanks"), true);
  });

  await t.test("New draft starts empty, and the list keeps both", async () => {
    await page.click("#newDraftBtn");
    assert.equal(await page.inputValue("#padBody"), "");
    assert.equal(await page.inputValue("#padTitle"), "");
    await page.waitForTimeout(600);
    assert.equal((await storedDrafts(app)).length, 1, "a new draft is stored only once it has text");
    await page.keyboard.type("Second note");
    await waitSaved(page);
    assert.deepEqual(await page.locator("#draftList .draft-title").allTextContents(), ["Second note", "Plan for Sam"]);
    await page.locator("#draftList .draft-item", { hasText: "Plan for Sam" }).click();
    await page.waitForFunction(() => document.getElementById("padTitle").value === "Plan for Sam");
    assert.match(await page.inputValue("#padBody"), /^Dear Sam/);
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("the suggestions switch", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await page.evaluate(() => {
    window.calls = [];
    self.ActlePad.onSuggest((draft, texts) => window.calls.push({ draft, texts }));
  });
  const calls = () => page.evaluate(() => window.calls);

  await t.test("is on by default and calls the suggestion hook after idle typing", async () => {
    assert.equal(await page.isChecked("#suggestToggle"), true);
    assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.hidden), false, "the empty panel is shown for cards");
    await page.waitForFunction(() => window.calls.length === 1);
    assert.deepEqual((await calls())[0], { draft: { id: null, title: "", body: "" }, texts: [] });
    await typeInBody(page, "as you can see");
    await page.waitForTimeout(800);
    assert.equal((await calls()).length, 1, "not before 1.5 s of idle typing");
    await page.waitForFunction(() => window.calls.length === 2);
    const last = (await calls())[1];
    assert.equal(last.draft.body, "as you can see");
    assert.deepEqual(last.texts, ["as you can see"]);
  });

  await t.test("off empties the panel, analyzes nothing and stays off after a reload", async () => {
    await page.evaluate(() => {
      const card = document.createElement("p");
      card.textContent = "A suggestion card";
      self.ActlePad.panel.appendChild(card);
    });
    await page.click("#suggestToggle");
    assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.hidden), true);
    assert.equal(await page.evaluate(() => self.ActlePad.panel.childElementCount), 0);
    assert.equal(await page.textContent("#suggestToggleHint"), "Off. Nothing you write is analyzed.");
    const before = (await calls()).length;
    await typeInBody(page, ". As you can see");
    await page.waitForTimeout(2200);
    assert.equal((await calls()).length, before, "nothing is analyzed while suggestions are off");
    await page.waitForFunction(async () => (await chrome.storage.local.get("pad-prefs"))["pad-prefs"].suggestions === false);

    await page.reload();
    await waitReady(page);
    assert.equal(await page.isChecked("#suggestToggle"), false);
    assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.hidden), true);
    await page.evaluate(() => {
      window.calls = [];
      self.ActlePad.onSuggest((draft, texts) => window.calls.push({ draft, texts }));
    });
    await page.waitForTimeout(300);
    assert.deepEqual(await calls(), []);
  });

  await t.test("on again calls the hook with every draft's text", async () => {
    await page.click("#suggestToggle");
    await page.waitForFunction(() => window.calls.length === 1);
    const [call] = await calls();
    assert.equal(call.draft.body, "as you can see. As you can see");
    assert.match(call.draft.id, /^[a-z0-9]+$/);
    assert.deepEqual(call.texts, ["as you can see. As you can see"]);
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("one tab edits a draft at a time", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const first = await openPad(app);
  await typeInBody(first, "Written in the first tab");
  await waitSaved(first);
  const second = await openPad(app);

  await t.test("a second tab opens the draft read-only", async () => {
    assert.equal(await second.inputValue("#padBody"), "Written in the first tab");
    assert.equal(await second.isVisible("#padLockNotice"), true);
    assert.equal(await second.textContent("#padLockText"), "This draft is open in another tab. Editing here is paused.");
    assert.equal(await second.locator("#padBody").evaluate((el) => el.readOnly), true);
    assert.equal(await second.isDisabled("#deleteBtn"), true);
    await second.click("#padBody");
    await second.keyboard.type("ignored");
    assert.equal(await second.inputValue("#padBody"), "Written in the first tab");
  });

  await t.test("Edit here instead moves editing to this tab after the other saves", async () => {
    // Hold back the first tab's 400 ms autosave, so only being taken over
    // saves what it types next. Neither tab changes visibility from here on.
    await first.evaluate(() => {
      const setTimeoutBefore = window.setTimeout;
      window.setTimeout = (callback, delay, ...rest) => delay === 400 ? 0 : setTimeoutBefore(callback, delay, ...rest);
    });
    await typeInBody(first, ", and more");
    await second.click("#padTakeOver");
    await first.waitForSelector("#padLockNotice", { state: "visible" });
    assert.equal(await first.locator("#padBody").evaluate((el) => el.readOnly), true);
    await second.waitForFunction(() => document.getElementById("padBody").value === "Written in the first tab, and more");
    assert.equal(await second.isVisible("#padLockNotice"), false);
    await typeInBody(second, " from the second tab");
    await waitSaved(second);
    await first.waitForFunction(() => document.getElementById("padBody").value === "Written in the first tab, and more from the second tab");
    const drafts = await storedDrafts(app);
    assert.equal(drafts.length, 1, "taking over keeps one draft");
    assert.equal(drafts[0].body, "Written in the first tab, and more from the second tab");
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("Copy text and Download .txt", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await page.fill("#padTitle", "Reply: Sam/Venue");
  await typeInBody(page, "Hi Sam,\nThe room is booked.");
  await waitSaved(page);

  await page.click("#copyBtn");
  await page.waitForFunction(() => document.getElementById("padMsg").textContent === "Copied. Paste it wherever you need it.");
  await app.page.bringToFront();
  await app.page.click("#ta");
  await app.page.keyboard.press("Control+v");
  assert.equal(await app.page.inputValue("#ta"), "Hi Sam,\nThe room is booked.");

  await page.bringToFront();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
  assert.equal(download.suggestedFilename(), "Reply Sam Venue.txt");
  assert.equal(fs.readFileSync(await download.path(), "utf8"), "Reply: Sam/Venue\n\nHi Sam,\nThe room is booked.");
  assert.equal(await page.textContent("#padMsg"), "Downloaded Reply Sam Venue.txt.");
  assert.deepEqual(app.errors, []);
});

test("a save over another tab's newer version keeps both versions", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await page.fill("#padTitle", "Venue");
  await typeInBody(page, "Mine");
  await waitSaved(page);
  // Another writer saves first while this tab's edit waits for its save.
  await page.evaluate(async () => {
    const body = document.getElementById("padBody");
    body.value = "Mine, edited";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    const [draft] = await self.ActlePadStore.listDrafts();
    await self.ActlePadStore.saveDraft(draft.id, { title: "Venue", body: "Theirs" }, draft.rev);
  });
  await page.waitForFunction(() => document.getElementById("padTitle").value === "Venue (copy from another tab)");
  await waitSaved(page);
  const bodies = (await storedDrafts(app)).map((draft) => [draft.title, draft.body]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(bodies, [["Venue", "Theirs"], ["Venue (copy from another tab)", "Mine, edited"]]);
  assert.equal(await page.inputValue("#padBody"), "Mine, edited");
  assert.match(await page.textContent("#padMsg"), /^Another tab changed this draft, so your text was saved as a new draft: “Venue \(copy from another tab\)”/);
  assert.deepEqual(app.errors, []);
});

test("a failing save shows the error and keeps the text", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await typeInBody(page, "Keep me");
  await waitSaved(page);
  await page.evaluate(() => {
    window.realSet = chrome.storage.local.set;
    chrome.storage.local.set = () => Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
  });
  await typeInBody(page, " please");
  await page.waitForFunction(() => document.getElementById("padSave").textContent.startsWith("Not saved"));
  assert.equal(await saveState(page), "Not saved: QUOTA_BYTES quota exceeded. Your text is still here — copy it or download it.");
  assert.equal(await page.inputValue("#padBody"), "Keep me please");
  assert.equal((await storedDrafts(app))[0].body, "Keep me");

  // Leaving the draft is refused while its text is unsaved.
  await page.click("#newDraftBtn");
  await page.waitForFunction(() => /stays open/.test(document.getElementById("padMsg").textContent));
  assert.equal(await page.inputValue("#padBody"), "Keep me please");

  // Closing the tab asks first.
  let asked = false;
  page.once("dialog", (dialog) => {
    asked = dialog.type() === "beforeunload";
    dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(asked, true, "the browser's leave confirmation is shown");
  assert.equal(page.isClosed(), false);

  // The next input retries, and succeeds once storage works again.
  await page.evaluate(() => { chrome.storage.local.set = window.realSet; });
  await typeInBody(page, "!");
  await waitSaved(page);
  assert.equal((await storedDrafts(app))[0].body, "Keep me please!");
  assert.deepEqual(app.errors, []);
});

test("deleting a draft, Undo and Recently deleted drafts", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await page.fill("#padTitle", "Keep");
  await typeInBody(page, "Stays");
  await waitSaved(page);
  await page.click("#newDraftBtn");
  await page.fill("#padTitle", "Letter");
  await typeInBody(page, "Dear Sam");
  await waitSaved(page);
  const accept = (expected) => page.once("dialog", (dialog) => {
    assert.equal(dialog.message(), expected);
    dialog.accept();
  });

  await t.test("delete asks, then offers Undo", async () => {
    accept("Delete “Letter”? It goes to Recently deleted drafts.");
    await page.click("#deleteBtn");
    await page.waitForFunction(() => document.getElementById("padMsg").textContent === "Deleted “Letter”.");
    assert.equal(await page.isVisible("#padUndo"), true);
    assert.equal(await page.inputValue("#padTitle"), "Keep", "the next draft opens");
    assert.deepEqual((await storedDrafts(app)).map((draft) => draft.title), ["Keep"]);
    assert.equal(await page.textContent("#padTrashCount"), "1");
  });

  await t.test("Undo restores it and opens it", async () => {
    await page.click("#padUndo");
    await page.waitForFunction(() => document.getElementById("padTitle").value === "Letter");
    assert.equal(await page.inputValue("#padBody"), "Dear Sam");
    assert.equal(await page.textContent("#padMsg"), "Restored “Letter”.");
    assert.equal(await page.textContent("#padTrashCount"), "0");
    assert.equal((await storedDrafts(app)).length, 2);
  });

  await t.test("Recently deleted drafts restores and deletes for good", async () => {
    accept("Delete “Letter”? It goes to Recently deleted drafts.");
    await page.click("#deleteBtn");
    await page.waitForFunction(() => document.getElementById("padMsg").textContent === "Deleted “Letter”.");
    await page.click("#padTrashSummary");
    assert.deepEqual(await page.locator("#padTrashList .trash-title").allTextContents(), ["Letter"]);
    await page.getByRole("button", { name: "Restore Letter" }).click();
    await page.waitForFunction(() => document.getElementById("padTitle").value === "Letter");
    assert.equal(await page.isVisible("#padTrashEmpty"), true);

    accept("Delete “Letter”? It goes to Recently deleted drafts.");
    await page.click("#deleteBtn");
    await page.waitForFunction(() => document.getElementById("padTrashCount").textContent === "1");
    await page.getByRole("button", { name: "Delete for good: Letter" }).click();
    await page.waitForFunction(() => document.getElementById("padMsg").textContent === "Deleted “Letter” for good.");
    assert.equal(await page.textContent("#padTrashCount"), "0");
    const items = await stored(app);
    assert.equal(items["pad-trash"], undefined);
    assert.deepEqual((await storedDrafts(app)).map((draft) => draft.title), ["Keep"]);
  });

  await t.test("Empty asks first and removes every copy", async () => {
    accept("Delete “Keep”? It goes to Recently deleted drafts.");
    await page.click("#deleteBtn");
    await page.waitForFunction(() => document.getElementById("padTrashCount").textContent === "1");
    assert.equal(await page.isVisible("#padIntro"), true, "an empty pad shows its intro again");
    accept("Empty Recently deleted drafts? The draft in it will be deleted for good.");
    await page.click("#padEmptyTrashBtn");
    await page.waitForFunction(() => document.getElementById("padTrashCount").textContent === "0");
    assert.equal((await stored(app))["pad-trash"], undefined);
    assert.deepEqual(await storedDrafts(app), []);
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});
