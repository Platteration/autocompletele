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

async function typeInBody(page, text, delay) {
  await page.click("#padBody");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text, delay ? { delay } : undefined);
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
  assert.equal(await pad.textContent(".pad-tagline"), "Drafts are saved on this device as you type. They are never sent or synced.",
    "the promise is about drafts: shortcuts made from them go to the library");
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
    assert.deepEqual(last.texts, [], "the open draft is passed once, as the draft");
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
    assert.equal(await page.textContent("#suggestToggleHint"), "Off. The pad does not look through your drafts for shortcut ideas or templates.");
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

  await t.test("the switch keeps keyboard focus while its setting saves", async () => {
    const saved = (on) => page.waitForFunction(async (on) => (await chrome.storage.local.get("pad-prefs"))["pad-prefs"].suggestions === on, on);
    await page.focus("#suggestToggle");
    await page.keyboard.press("Space");
    assert.equal(await page.isChecked("#suggestToggle"), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "suggestToggle");
    await saved(true);
    // Quicker than a save: on, off, on, off.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Space");
    assert.equal(await page.evaluate(() => document.activeElement.id), "suggestToggle", "focus stays on the switch");
    assert.equal(await page.isChecked("#suggestToggle"), false);
    await saved(false);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get("pad-prefs"))["pad-prefs"].suggestions), false,
      "the last state chosen is the one saved");
    assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.hidden), true);
    await page.evaluate(() => { window.calls = []; });
  });

  await t.test("on again calls the hook with the open draft and every other draft's text", async () => {
    await page.evaluate(() => self.ActlePadStore.createDraft({ title: "Other", body: "Another draft" }));
    await page.waitForFunction(() => document.getElementById("draftCount").textContent === "2");
    await page.click("#suggestToggle");
    await page.waitForFunction(() => window.calls.length === 1);
    const [call] = await calls();
    assert.equal(call.draft.body, "as you can see. As you can see");
    assert.match(call.draft.id, /^[a-z0-9]+$/);
    assert.deepEqual(call.texts, ["Another draft"]);
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("the suggestions switch follows a change made in another pad tab", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const first = await openPad(app);
  const second = await openPad(app);
  await second.click("#suggestToggle");
  await first.waitForFunction(() => !document.getElementById("suggestToggle").checked && document.getElementById("padSuggestions").hidden);
  await second.click("#suggestToggle");
  await first.waitForFunction(() => document.getElementById("suggestToggle").checked && !document.getElementById("padSuggestions").hidden);
  assert.deepEqual(app.errors, []);
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

test("on narrow windows the drafts list box opens a draft only when chosen", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const seed = await openPad(app);
  await seed.evaluate(async () => {
    // Drafts made in the same millisecond have no newest one, so each gets its own.
    let last = 0;
    for (const title of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      while (Date.now() <= last) await new Promise((resolve) => setTimeout(resolve, 1));
      last = (await self.ActlePadStore.createDraft({ title, body: title + " text" })).createdAt;
    }
  });
  await seed.close();
  const page = await app.context.newPage();
  await page.setViewportSize({ width: 980, height: 800 });
  await openPad(app, page);
  assert.equal(await page.inputValue("#padTitle"), "Delta");
  const select = page.locator("#draftSelect");
  await select.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assert.equal(await select.inputValue(), await page.evaluate(() => document.getElementById("draftSelect").options[2].value), "the list box shows the second draft down");
  await page.waitForTimeout(300);
  assert.equal(await page.inputValue("#padTitle"), "Delta", "stepping through the list opens nothing");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("padTitle").value === "Bravo");
  assert.equal(await page.evaluate(() => document.activeElement.id), "draftSelect");

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Tab");
  assert.equal(await page.inputValue("#padTitle"), "Bravo");
  assert.equal(await page.locator("#draftSelect option:checked").textContent().then((text) => text.startsWith("Bravo")), true,
    "leaving the list box shows the open draft again");

  await select.selectOption({ label: await page.locator("#draftSelect option", { hasText: "Alpha" }).textContent() });
  await page.waitForFunction(() => document.getElementById("padTitle").value === "Alpha", null, { timeout: 5000 });
  assert.deepEqual(app.errors, []);
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

function rescueKeys(items) {
  return Object.keys(items).filter((key) => key.startsWith("pad-rescue:"));
}

test("text typed just before the tab closes or reloads is not lost", async (t) => {
  const app = await launch();
  t.after(() => app.close());

  await t.test("closing within 400 ms and choosing Leave keeps the last words", async () => {
    const page = await openPad(app);
    await typeInBody(page, "First line saved.");
    await waitSaved(page);
    await typeInBody(page, " LAST WORDS");
    page.once("dialog", (dialog) => dialog.accept());
    await page.close({ runBeforeUnload: true });
    await page.waitForEvent("close");
    const again = await openPad(app);
    assert.equal(await again.inputValue("#padBody"), "First line saved. LAST WORDS");
    const drafts = await storedDrafts(app);
    assert.deepEqual(drafts.map((draft) => [draft.body, draft.rev]), [["First line saved. LAST WORDS", 2]], "stored over the same draft, not as a copy");
    assert.deepEqual(rescueKeys(await stored(app)), [], "the rescued text is not kept twice");
    assert.equal(await again.textContent("#padMsg"), "");
    await again.close();
  });

  await t.test("reloading within 400 ms and choosing Leave keeps the last words", async () => {
    const page = await openPad(app);
    await typeInBody(page, " Then a reload.");
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload();
    await waitReady(page);
    assert.equal(await page.inputValue("#padBody"), "First line saved. LAST WORDS Then a reload.");
    assert.equal((await storedDrafts(app)).length, 1);
    await page.close();
  });

  await t.test("a new draft closed before its first save is kept", async () => {
    const page = await openPad(app);
    await page.click("#newDraftBtn");
    await page.keyboard.type("Brand new");
    page.once("dialog", (dialog) => dialog.accept());
    await page.close({ runBeforeUnload: true });
    await page.waitForEvent("close");
    const again = await openPad(app);
    assert.equal(await again.inputValue("#padBody"), "Brand new", "the recovered draft opens");
    assert.deepEqual((await storedDrafts(app)).map((draft) => draft.body).sort(), ["Brand new", "First line saved. LAST WORDS Then a reload."]);
    await again.close();
  });

  await t.test("choosing Stay keeps editing, saves, and leaves nothing to recover", async () => {
    const page = await openPad(app);
    await typeInBody(page, " Stay.");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.close({ runBeforeUnload: true });
    await waitSaved(page);
    assert.equal(page.isClosed(), false);
    await page.waitForFunction(async () => !Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith("pad-rescue:")));
    assert.match((await storedDrafts(app)).map((draft) => draft.body).join("|"), /Brand new Stay\./);
    await page.close();
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("a pad tab that stays open stores the text of one that closed", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const writer = await openPad(app);
  await typeInBody(writer, "Saved part.");
  await waitSaved(writer);
  const other = await openPad(app);
  await other.click("#newDraftBtn");
  // A save held back, as when the tab closes before the lock and read finish.
  await writer.evaluate(() => {
    const setBefore = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items) => Object.keys(items).some((key) => key.startsWith("pad-draft:"))
      ? new Promise(() => {}) : setBefore(items);
  });
  await typeInBody(writer, " Unsaved part.");
  writer.once("dialog", (dialog) => dialog.accept());
  await writer.close({ runBeforeUnload: true });
  await writer.waitForEvent("close");
  await other.waitForFunction(() => [...document.querySelectorAll("#draftList .draft-title")].some((el) => el.textContent === "Saved part. Unsaved part."));
  assert.deepEqual((await storedDrafts(app)).map((draft) => draft.body), ["Saved part. Unsaved part."]);
  assert.deepEqual(rescueKeys(await stored(app)), []);
  assert.deepEqual(app.errors, []);
});

test("steady typing with no pause still saves every 2 seconds", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await typeInBody(page, "Dear Sam,");
  await waitSaved(page);
  const sentence = " the venue is confirmed for Friday and the catering order went in.";
  const typing = typeInBody(page, sentence, 150); // about 10 s, never pausing 400 ms
  await page.waitForTimeout(2600);
  const midway = (await storedDrafts(app))[0].body;
  assert.ok(midway.length > "Dear Sam,".length, `saved while typing: ${JSON.stringify(midway)}`);
  assert.ok(sentence.startsWith(midway.slice("Dear Sam,".length)), midway);
  await typing;
  await waitSaved(page);
  assert.equal((await storedDrafts(app))[0].body, "Dear Sam," + sentence);
  assert.deepEqual(app.errors, []);
});

test("a save that finds its own text already stored makes no copy", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await page.fill("#padTitle", "Venue");
  await typeInBody(page, "Mine");
  await waitSaved(page);
  await page.evaluate(async () => {
    const body = document.getElementById("padBody");
    body.value = "Mine, edited";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    const [draft] = await self.ActlePadStore.listDrafts();
    await self.ActlePadStore.saveDraft(draft.id, { title: "Venue", body: "Mine, edited" }, draft.rev);
  });
  await waitSaved(page);
  await page.waitForTimeout(500);
  assert.deepEqual((await storedDrafts(app)).map((draft) => [draft.title, draft.body]), [["Venue", "Mine, edited"]]);
  assert.equal(await page.textContent("#padMsg"), "");
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
    await page.getByRole("button", { name: "Restore Letter" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("padTitle").value === "Letter");
    assert.equal(await page.isVisible("#padTrashEmpty"), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "padBody", "keyboard focus lands in the restored draft");

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

test("a draft too big to keep a copy of can still be deleted, after a download", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openPad(app);
  await page.fill("#padTitle", "Transcript");
  await typeInBody(page, "A very long transcript");
  await waitSaved(page);
  // Storage is too full for the copy in Recently deleted drafts.
  await page.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items) => "pad-trash" in items
      ? Promise.reject(new Error("Resource::kQuotaBytes quota exceeded")) : set(items);
  });
  const answers = [];
  const answer = (...replies) => {
    page.on("dialog", function reply(dialog) {
      answers.push(dialog.message());
      const accept = replies.shift();
      if (!replies.length) page.off("dialog", reply);
      return accept ? dialog.accept() : dialog.dismiss();
    });
  };
  const notKept = "“Transcript” could not be kept in Recently deleted drafts (Resource::kQuotaBytes quota exceeded), "
    + "so deleting it cannot be undone. Download it as a text file and delete it anyway?";

  await t.test("saying no keeps the draft and says why", async () => {
    answer(true, false);
    await page.click("#deleteBtn");
    await page.waitForFunction(() => /was not deleted/.test(document.getElementById("padMsg").textContent));
    assert.deepEqual(answers.splice(0), ["Delete “Transcript”? It goes to Recently deleted drafts.", notKept]);
    assert.equal(await page.textContent("#padMsg"), "“Transcript” was not deleted: it could not be kept in Recently deleted drafts (Resource::kQuotaBytes quota exceeded).");
    assert.equal((await storedDrafts(app)).length, 1);
  });

  await t.test("saying yes downloads it, then deletes it without a copy", async () => {
    answer(true, true);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#deleteBtn")]);
    assert.equal(download.suggestedFilename(), "Transcript.txt");
    assert.equal(fs.readFileSync(await download.path(), "utf8"), "Transcript\n\nA very long transcript");
    await page.waitForFunction(() => /^Deleted/.test(document.getElementById("padMsg").textContent));
    assert.equal(await page.textContent("#padMsg"), "Deleted “Transcript”. It was not kept in Recently deleted drafts; its text was downloaded as Transcript.txt.");
    assert.equal(await page.isVisible("#padUndo"), false, "there is nothing to undo from");
    assert.deepEqual(await storedDrafts(app), []);
    assert.equal((await stored(app))["pad-trash"], undefined);
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

// ---- the Suggestions panel (pad-suggestions.js) ---------------------------------

const PHRASES = "As you can see, the plan works. Thanks for your patience today. As you can see, it is cheap. "
  + "Thanks for your patience again. As you can see, we are ready. Thanks for your patience, everyone.";
const EMAIL = "Hi Sam,\n\nThanks for meeting on October 20, 2026. I will send the signed contract and the final invoice "
  + "to you by the end of the week, and we can review the rollout plan together.\n\nBest regards,\nAlex";

// A failing suggestion run is only logged as a warning by pad.js; count it.
async function openSuggestPad(app, page) {
  page = page || await app.context.newPage();
  page.on("console", (m) => {
    if (m.type() === "warning" && /suggestions failed/.test(m.text())) app.errors.push("pad: " + m.text());
  });
  return openPad(app, page);
}

function phraseCard(page, phrase) {
  return page.locator(`.suggest-card[data-phrase="${phrase}"]`);
}

function notice(page) {
  return page.locator(".suggest-notice").textContent();
}

async function library(app) {
  return (await app.worker.evaluate(() => self.ShorthandStorage.getAll())).shorthands;
}

// Fills the editor the way pasting does, without typing through actle's
// suggestion list.
async function fillBody(page, text) {
  await page.fill("#padBody", text);
}

test("a phrase written three times becomes a shortcut that works everywhere", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);

  await t.test("twice is not enough", async () => {
    await fillBody(page, "As you can see, the plan works. As you can see, it is cheap.");
    await waitSaved(page);
    await page.waitForTimeout(2000); // past the 1.5 s idle wait
    assert.equal(await page.locator(".suggest-card").count(), 0);
    assert.equal(await page.isVisible(".suggest-empty"), true, "the panel says there is nothing yet");
  });

  await t.test("the third time offers it with an initials trigger", async () => {
    await fillBody(page, "As you can see, the plan works. As you can see, it is cheap. As you can see, we are ready.");
    const card = phraseCard(page, "as you can see");
    await card.waitFor();
    assert.equal(await card.locator(".suggest-text").textContent(), "You've written “As you can see” 3 times.");
    assert.equal(await card.locator(".suggest-trigger").inputValue(), "aycs/");
    const note = "Make shortcut copies this phrase to your library, which Chrome syncs to your other devices when Chrome sync is on.";
    assert.equal(await card.locator(".suggest-note").textContent(), note, "the card says where the phrase goes");
    assert.equal(await card.getByRole("button", { name: /^Make shortcut/ }).getAttribute("aria-describedby"),
      await card.locator(".suggest-note").getAttribute("id"));
    assert.equal(await page.isVisible(".suggest-empty"), false);
    assert.equal(await page.locator(".suggest-root > .sr-only[role=status]").textContent(), "New shortcut idea: “As you can see”.",
      "a new idea is announced in a status line of its own");
  });

  await t.test("Make shortcut saves it to the library and says so", async () => {
    await phraseCard(page, "as you can see").getByRole("button", { name: /^Make shortcut/ }).click();
    await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent.startsWith("Saved"));
    assert.equal(await notice(page), "Saved aycs/. Type it anywhere to insert “As you can see”. Open library");
    const link = page.locator(".suggest-notice a");
    assert.equal(await link.getAttribute("href"), "options.html");
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.equal(await phraseCard(page, "as you can see").count(), 0);
    const saved = (await library(app)).filter((item) => item.trigger === "aycs/");
    assert.deepEqual(saved.map((item) => item.expansion), ["As you can see"]);

    const options = await app.context.newPage();
    await options.goto(`chrome-extension://${app.extensionId}/src/options.html`);
    await options.waitForSelector("#list tbody tr");
    assert.ok((await options.locator("#list td.trigger").allTextContents()).includes("aycs/"), "the library lists it");
    await options.close();
  });

  await t.test("it is not offered again once it is a shortcut", async () => {
    await fillBody(page, "As you can see, the plan works. As you can see, it is cheap. As you can see, we are ready!");
    await page.waitForTimeout(2200);
    assert.equal(await phraseCard(page, "as you can see").count(), 0);
  });

  await t.test("the new shortcut expands on a web page", async () => {
    await app.page.bringToFront();
    await app.page.click("#ta");
    await app.page.keyboard.type("aycs/");
    await app.page.waitForFunction(() => document.getElementById("ta").value === "As you can see");
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("Make shortcut checks the trigger like the library", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, PHRASES);
  const card = phraseCard(page, "as you can see");
  await card.waitFor();
  const input = card.locator(".suggest-trigger");
  const make = card.getByRole("button", { name: /^Make shortcut/ });
  const message = () => card.locator(".suggest-msg").textContent();

  await t.test("a trigger typed in the card does not expand", async () => {
    await input.click();
    await input.press("Control+a");
    await page.keyboard.type("cool/");
    await page.waitForTimeout(300);
    assert.equal(await input.inputValue(), "cool/");
  });

  await t.test("a used trigger is refused", async () => {
    await make.click();
    await card.locator(".suggest-msg.error").waitFor();
    assert.equal(await message(), "That trigger is already used.");
    assert.equal(await input.evaluate((el) => el === document.activeElement), true, "focus goes back to the trigger");
  });

  await t.test("an empty trigger and spaces are refused", async () => {
    await input.fill("   ");
    await make.click();
    assert.equal(await message(), "Trigger cannot be empty.");
    await input.fill("as you");
    await input.press("Enter");
    assert.equal(await message(), "Trigger cannot contain spaces.");
    assert.equal((await library(app)).some((item) => item.expansion === "As you can see"), false);
  });

  await t.test("a trigger the person typed survives the next suggestion run", async () => {
    await input.fill("seeit/");
    await fillBody(page, PHRASES + " As you can see, more.");
    await page.waitForFunction(() => document.querySelector('.suggest-card[data-phrase="as you can see"] .suggest-text')
      .textContent.includes("4 times"));
    assert.equal(await input.inputValue(), "seeit/");
  });

  await t.test("a failing save shows the library's error and keeps the card", async () => {
    await page.evaluate(() => {
      window.realSyncSet = chrome.storage.sync.set;
      chrome.storage.sync.set = () => Promise.reject(new Error("Resource::kQuotaBytesPerItem quota exceeded"));
    });
    await make.click();
    await card.locator(".suggest-msg.error").waitFor();
    assert.equal(await message(), "Could not save: Resource::kQuotaBytesPerItem quota exceeded");
    assert.equal(await input.inputValue(), "seeit/");
    await page.evaluate(() => { chrome.storage.sync.set = window.realSyncSet; });
    await make.click();
    await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent.startsWith("Saved seeit/."));
    assert.deepEqual((await library(app)).filter((item) => item.trigger === "seeit/").map((item) => item.expansion), ["As you can see"]);
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("Make shortcut refuses a trigger that could never fire, and passes on the library's warnings", async (t) => {
  // "ty" has no symbol, so it fires inside words: inside "tyfyp/" too.
  const app = await launch({ shorthands: [{ trigger: "ty", expansion: "thank you" }, { trigger: "cool/", expansion: "That is really cool!" }] });
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, "Thank you for your patience. Thank you for your patience! Thank you for your patience, Sam.");
  const card = phraseCard(page, "thank you for your patience");
  await card.waitFor();
  const input = card.locator(".suggest-trigger");
  assert.equal(await input.inputValue(), "tyfyp/");
  await card.getByRole("button", { name: /^Make shortcut/ }).click();
  await card.locator(".suggest-msg.error").waitFor();
  assert.equal(await card.locator(".suggest-msg").textContent(),
    "\"tyfyp/\" can never fire, because \"ty\" expands as soon as you type it. Choose another trigger.");
  assert.equal(await input.evaluate((el) => el === document.activeElement), true);
  assert.equal((await library(app)).some((item) => item.trigger === "tyfyp/"), false, "nothing is saved");

  // A trigger of letters only is saved, with the library's warning instead of "Type it anywhere".
  await input.fill("patience");
  await card.getByRole("button", { name: /^Make shortcut/ }).click();
  await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent.startsWith("Saved patience."));
  assert.equal(await notice(page), "Saved patience. \"patience\" is only letters and digits, so it fires inside ordinary words. "
    + "Ending it with a symbol, like \"patience/\", avoids that. Open library");
  assert.deepEqual((await library(app)).filter((item) => item.trigger === "patience").map((item) => item.expansion), ["Thank you for your patience"]);
  assert.deepEqual(app.errors, []);
});

test("Not now and Don't suggest this", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  let page = await openSuggestPad(app);
  await fillBody(page, PHRASES);
  await phraseCard(page, "as you can see").waitFor();
  await phraseCard(page, "thanks for your patience").waitFor();

  await t.test("Not now hides a phrase until the pad is opened again", async () => {
    await phraseCard(page, "as you can see").getByRole("button", { name: /^Not now/ }).click();
    assert.equal(await phraseCard(page, "as you can see").count(), 0);
    assert.equal(await notice(page), "“As you can see” is hidden until you open the pad again.");
    assert.equal(await page.evaluate(() => document.activeElement.closest(".suggest-card")?.dataset.phrase),
      "thanks for your patience", "keyboard focus moves to the next idea");
    await fillBody(page, PHRASES + " Again.");
    await page.waitForTimeout(2200);
    assert.equal(await phraseCard(page, "as you can see").count(), 0);
    assert.equal(await phraseCard(page, "thanks for your patience").count(), 1);
    await page.reload();
    await waitReady(page);
    await phraseCard(page, "as you can see").waitFor();
  });

  await t.test("Don't suggest this is remembered on this device", async () => {
    await phraseCard(page, "thanks for your patience").getByRole("button", { name: /^Don't suggest this/ }).click();
    await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent === "“Thanks for your patience” will not be suggested again.");
    assert.deepEqual((await stored(app))["pad-dismissed"], ["thanks for your patience"]);
    await page.waitForFunction(() => document.getElementById("padDismissedText").textContent === "1 phrase you chose not to see again is kept on this device.");
    assert.equal(await page.isVisible("#padClearDismissed"), true);
    const sync = await app.worker.evaluate(() => chrome.storage.sync.get(null));
    assert.equal(Object.keys(sync).some((key) => key.startsWith("pad-")), false);
    await page.close();
    page = await openSuggestPad(app);
    await phraseCard(page, "as you can see").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await phraseCard(page, "thanks for your patience").count(), 0);
  });

  await t.test("at most three ideas show; hiding one makes room for the next", async () => {
    const four = PHRASES + " Keep the receipts safe. Keep the receipts safe. Keep the receipts safe."
      + " Call the front desk. Call the front desk. Call the front desk.";
    await fillBody(page, four);
    await page.waitForFunction(() => document.querySelectorAll(".suggest-card[data-phrase]").length === 3);
    await page.waitForTimeout(500);
    const shown = await page.locator(".suggest-card[data-phrase]").evaluateAll((all) => all.map((li) => li.dataset.phrase));
    assert.equal(shown.length, 3);
    assert.equal(shown.includes("thanks for your patience"), false, "dismissed phrases stay away");
    const hidden = ["as you can see", "keep the receipts safe", "call the front desk"].find((phrase) => !shown.includes(phrase));
    assert.equal(hidden, undefined, "the three remaining ideas all show");
    await fillBody(page, four + " Bring a pen. Bring a pen. Bring a pen. Book the big room. Book the big room. Book the big room.");
    await page.waitForTimeout(2200);
    const before = await page.locator(".suggest-card[data-phrase]").evaluateAll((all) => all.map((li) => li.dataset.phrase));
    assert.equal(before.length, 3);
    await phraseCard(page, before[0]).getByRole("button", { name: /^Not now/ }).click();
    await page.waitForFunction((gone) => {
      const now = [...document.querySelectorAll(".suggest-card[data-phrase]")].map((li) => li.dataset.phrase);
      return now.length === 3 && !now.includes(gone);
    }, before[0]);
    await page.reload();
    await waitReady(page);
    await fillBody(page, PHRASES);
    await page.waitForTimeout(2200);
  });

  await t.test("a shortcut added elsewhere removes its idea without typing", async () => {
    await app.worker.evaluate(() => self.ShorthandStorage.saveShorthand({ trigger: "see/", expansion: "as you can see" }));
    await phraseCard(page, "as you can see").waitFor({ state: "detached" });
    assert.equal(await page.isVisible(".suggest-empty"), true);
  });

  await t.test("Clear forgets the phrases not to suggest, and they come back", async () => {
    await page.click("#suggestToggle"); // the list can be cleared with suggestions off, too
    await page.waitForFunction(() => document.getElementById("padSuggestions").hidden);
    assert.equal(await page.isVisible("#padClearDismissed"), true);
    await page.focus("#padClearDismissed");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("padDismissedText").textContent === "Cleared. Those phrases can be suggested again.");
    assert.equal((await stored(app))["pad-dismissed"], undefined);
    assert.equal(await page.isVisible("#padClearDismissed"), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), "suggestToggle", "focus moves on, not to the page");
    await page.click("#suggestToggle");
    await phraseCard(page, "thanks for your patience").waitFor();
    await page.reload();
    await waitReady(page);
    assert.equal(await page.isVisible("#padDismissed"), false, "nothing to clear, nothing shown");
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("a phrase dismissed in another pad tab leaves this one without typing", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, PHRASES);
  await phraseCard(page, "as you can see").waitFor();
  // Another tab's "Don't suggest this" reaches this one through storage.
  const other = await openSuggestPad(app);
  await other.evaluate(() => self.ActlePadStore.dismissPhrase("As you can see"));
  await phraseCard(page, "as you can see").waitFor({ state: "detached" });
  assert.equal(await phraseCard(page, "thanks for your patience").count(), 1);
  assert.deepEqual(app.errors, []);
});

test("Don't suggest this that cannot be saved says so and keeps the idea", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, PHRASES);
  const card = phraseCard(page, "as you can see");
  await card.waitFor();
  await page.evaluate(() => {
    self.ActlePadStore.dismissPhrase = () => Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
  });
  await card.getByRole("button", { name: /^Don't suggest this/ }).click();
  await card.locator(".suggest-msg.error").waitFor();
  assert.equal(await card.locator(".suggest-msg").textContent(), "Could not save that choice: QUOTA_BYTES quota exceeded");
  assert.equal(await card.count(), 1);
  assert.equal(await notice(page), "");
  assert.deepEqual(app.errors, []);
});

test("a library read that fails after suggestions are turned off shows nothing", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, PHRASES);
  await phraseCard(page, "as you can see").waitFor();
  await page.evaluate(() => {
    self.ShorthandStorage.getAll = () => new Promise((resolve, reject) => setTimeout(() => reject(new Error("Sync is unavailable")), 1000));
  });
  await fillBody(page, PHRASES + " Again.");
  await page.waitForTimeout(1700); // the run has started and waits for the library
  await page.click("#suggestToggle");
  await page.waitForTimeout(1200);
  assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.childElementCount), 0, "no paused notice in a panel that is off");
  assert.deepEqual(app.errors, []);
});

test("an email draft becomes a fill-in template", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  const card = page.locator(".template-card");
  const chips = card.locator(".blank-chip");
  const message = () => card.locator(".suggest-msg").textContent();

  await t.test("a draft under 20 words gets no template", async () => {
    await fillBody(page, "Hi Sam,\n\nSee you on October 20, 2026.\n\nBest regards,\nAlex");
    await waitSaved(page);
    await page.waitForTimeout(2000);
    assert.equal(await card.count(), 0);
  });

  await t.test("the greeting name and the date are offered as blanks", async () => {
    await page.fill("#padTitle", "Follow up with Sam");
    await fillBody(page, EMAIL);
    await card.waitFor();
    assert.equal(await card.locator(".suggest-title").textContent(), "Turn this draft into a fill-in template");
    assert.deepEqual(await chips.allTextContents(), ["name", "date"]);
    assert.deepEqual(await chips.evaluateAll((all) => all.map((chip) => chip.getAttribute("aria-pressed"))), ["true", "true"]);
    assert.equal(await card.locator(".template-preview").textContent(), EMAIL.replace("Sam", "name").replace("October 20, 2026", "date"));
    assert.deepEqual(await card.locator(".blank-name").evaluateAll((all) => all.map((input) => input.value)), ["name", "date"]);
    assert.equal(await card.locator(".suggest-trigger").inputValue(), "fuw/", "initials of the first three title words");
    assert.equal(await card.locator(".suggest-note").textContent(),
      "Save as template copies this draft's text to your library, which Chrome syncs to your other devices when Chrome sync is on.");
    assert.equal(await card.getByRole("button", { name: "Save as template" }).getAttribute("aria-describedby"),
      await card.locator(".suggest-note").getAttribute("id"));
    assert.equal(await page.locator(".template-preview").evaluate((el) => !el.closest("[aria-live], [role=status]")), true,
      "the draft's text is not in a live region, so it is not read out on every change");
  });

  await t.test("Save as template saves [[name]] and [[date]]", async () => {
    await card.getByRole("button", { name: "Save as template" }).click();
    await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent.startsWith("Saved"));
    assert.equal(await notice(page), "Saved fuw/. Typing it opens the fill-in form. Open library");
    const [saved] = (await library(app)).filter((item) => item.trigger === "fuw/");
    assert.equal(saved.expansion, "Hi [[name]],\n\nThanks for meeting on [[date]]. I will send the signed contract and the final invoice "
      + "to you by the end of the week, and we can review the rollout plan together.\n\nBest regards,\nAlex");
    assert.equal(await card.count(), 0, "the card stays away until the draft changes");
  });

  await t.test("on a web page the template asks for each blank and inserts the email", async () => {
    await app.page.bringToFront();
    await app.page.click("#ta");
    await app.page.keyboard.type("fuw/");
    await app.page.waitForSelector("#shorthand-template-host", { timeout: 5000 });
    await app.page.keyboard.type("Ana");
    await app.page.keyboard.press("Tab");
    await app.page.keyboard.type("November 3, 2026");
    await app.page.keyboard.press("Enter");
    await app.page.waitForSelector("#shorthand-template-host", { state: "detached", timeout: 5000 });
    assert.equal(await app.page.inputValue("#ta"), EMAIL.replace("Sam", "Ana").replace("October 20, 2026", "November 3, 2026"));
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("the template's trigger stays clear of the shortcut ideas' triggers", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await page.fill("#padTitle", "See you soon notes");
  await fillBody(page, EMAIL + "\nSee you soon. See you soon. See you soon.");
  await phraseCard(page, "see you soon").waitFor();
  await page.locator(".template-card").waitFor();
  assert.equal(await phraseCard(page, "see you soon").locator(".suggest-trigger").inputValue(), "sys/");
  assert.equal(await page.locator(".template-card .suggest-trigger").inputValue(), "sys2/");
  assert.deepEqual(app.errors, []);
});

test("template chips, blank names and Not now", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, EMAIL);
  const card = page.locator(".template-card");
  await card.waitFor();
  const chips = card.locator(".blank-chip");
  const save = card.getByRole("button", { name: "Save as template" });
  const message = () => card.locator(".suggest-msg").textContent();

  await t.test("the prefilled trigger is draft/ without a title, and avoids used triggers", async () => {
    assert.equal(await card.locator(".suggest-trigger").inputValue(), "draft/");
    await app.worker.evaluate(() => self.ShorthandStorage.saveShorthand({ trigger: "draft/", expansion: "Draft" }));
    await page.waitForFunction(() => document.querySelector(".template-card .suggest-trigger").value === "draft2/");
  });

  await t.test("Space on a chip keeps its value as written", async () => {
    await chips.first().focus();
    await page.keyboard.press("Space");
    assert.equal(await chips.first().getAttribute("aria-pressed"), "false");
    assert.equal(await chips.first().textContent(), "Sam");
    assert.deepEqual(await card.locator(".blank-name").evaluateAll((all) => all.map((input) => input.value)), ["date"]);
    await page.keyboard.press("Enter");
    assert.equal(await chips.first().getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Space");
    assert.equal(await chips.first().evaluate((el) => el === document.activeElement), true, "focus stays on the chip");
  });

  await t.test("a blank name typed in the list does not expand as a trigger", async () => {
    const name = card.locator(".blank-name").first();
    await name.click();
    await name.press("Control+a");
    await page.keyboard.type("cool/");
    await page.waitForTimeout(300);
    assert.equal(await name.inputValue(), "cool/");
  });

  await t.test("the preview is drawn again only when the draft's text changes", async () => {
    await page.evaluate(() => { document.querySelector(".template-card .blank-chip").dataset.mark = "kept"; });
    // A library change elsewhere runs the suggestions again with the same text.
    await app.worker.evaluate(() => self.ShorthandStorage.saveShorthand({ trigger: "elsewhere/", expansion: "Added elsewhere" }));
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".template-card .blank-chip[data-mark=kept]").count(), 1, "the same chip, not a new one");
  });

  await t.test("a blank name is edited in the list and checked", async () => {
    const name = card.locator(".blank-name").first();
    await name.fill("");
    await save.click();
    assert.equal(await message(), "Give every blank a name.");
    assert.equal(await name.evaluate((el) => el === document.activeElement), true);
    await name.fill("[day]");
    await save.click();
    assert.equal(await message(), "A blank name cannot contain [ or ].");
    await name.fill("meeting day");
    assert.equal(await chips.nth(1).textContent(), "meeting day");
  });

  await t.test("the template's trigger is checked like the library's", async () => {
    await card.locator(".suggest-trigger").fill("cool/");
    await save.click();
    await card.locator(".suggest-msg.error").waitFor();
    assert.equal(await message(), "That trigger is already used.");
    await card.locator(".suggest-trigger").fill("sam /");
    await save.click();
    assert.equal(await message(), "Trigger cannot contain spaces.");
    await card.locator(".suggest-trigger").fill("");
    await save.click();
    assert.equal(await message(), "Trigger cannot be empty.");
  });

  await t.test("the saved template has only the chosen blanks, under the chosen names", async () => {
    await card.locator(".suggest-trigger").fill("sam/");
    await save.click();
    await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent.startsWith("Saved sam/."));
    const [saved] = (await library(app)).filter((item) => item.trigger === "sam/");
    assert.match(saved.expansion, /^Hi Sam,\n\nThanks for meeting on \[\[meeting day\]\]\. I will send/);
  });

  await t.test("Not now hides the template for this draft until the pad is opened again", async () => {
    await fillBody(page, EMAIL + "\nP.S. See you there.");
    await card.waitFor();
    await card.getByRole("button", { name: /^Not now/ }).click();
    assert.equal(await card.count(), 0);
    assert.equal(await notice(page), "The fill-in template for this draft is hidden until you open the pad again.");
    await fillBody(page, EMAIL + "\nP.S. See you there!");
    await page.waitForTimeout(2200);
    assert.equal(await card.count(), 0);
    await page.reload();
    await waitReady(page);
    await card.waitFor();
  });

  await t.test("reports no page errors", () => {
    assert.deepEqual(app.errors, []);
  });
});

test("switching suggestions off removes the cards and stays off", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, PHRASES + "\n\n" + EMAIL);
  await phraseCard(page, "as you can see").waitFor();
  await page.locator(".template-card").waitFor();

  await page.click("#suggestToggle");
  assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.hidden), true);
  assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.childElementCount), 0);
  await page.waitForFunction(async () => (await chrome.storage.local.get("pad-prefs"))["pad-prefs"].suggestions === false);

  await page.reload();
  await waitReady(page);
  assert.equal(await page.isChecked("#suggestToggle"), false);
  await fillBody(page, PHRASES + "\n\n" + EMAIL + " More.");
  await page.waitForTimeout(2200);
  assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.hidden), true);
  assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.childElementCount), 0, "nothing is analyzed or shown");

  await page.click("#suggestToggle");
  await phraseCard(page, "as you can see").waitFor();
  await page.locator(".template-card").waitFor();

  // A run still reading the library when suggestions go off shows nothing.
  await page.evaluate(() => {
    const getAll = self.ShorthandStorage.getAll;
    self.ShorthandStorage.getAll = () => new Promise((resolve) => setTimeout(resolve, 1000)).then(getAll);
  });
  await fillBody(page, PHRASES + "\n\n" + EMAIL + " Once more.");
  await page.waitForTimeout(1700); // the run has started and waits for the library
  await page.click("#suggestToggle");
  await page.waitForTimeout(1200);
  assert.equal(await page.locator("#padSuggestions").evaluate((el) => el.childElementCount), 0);
  assert.deepEqual(app.errors, []);
});

test("an older suggestion run never replaces a newer one", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, "Nothing repeats here yet.");
  await page.locator(".suggest-empty").waitFor();
  // The next run reads the library slowly; the one after it does not.
  await page.evaluate(() => {
    const getAll = self.ShorthandStorage.getAll;
    let calls = 0;
    self.ShorthandStorage.getAll = () => ++calls === 1
      ? new Promise((resolve) => setTimeout(resolve, 3000)).then(getAll) : getAll();
  });
  await fillBody(page, PHRASES);
  await page.waitForTimeout(1700); // the slow run has started
  await fillBody(page, "Nothing repeats here now.");
  await page.waitForTimeout(3500); // the fast run renders, then the slow one finishes
  assert.equal(await phraseCard(page, "as you can see").count(), 0);
  assert.equal(await page.isVisible(".suggest-empty"), true);
  assert.deepEqual(app.errors, []);
});

test("phrases are looked for in the open draft first, then the newest drafts", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  // A long newest draft with no repeated phrase, and an older one that has one.
  await app.worker.evaluate(async () => {
    let seed = 2463534242;
    const word = () => {
      let text = "";
      for (let i = 0; i < 6; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        text += String.fromCharCode(97 + (seed >>> 0) % 26);
      }
      return text;
    };
    let long = "";
    while (long.length < 110000) long += word() + " ";
    await chrome.storage.local.set({
      "pad-draft:long": { id: "long", title: "Long notes", body: long, createdAt: 2, updatedAt: 2000, rev: 1 },
      "pad-draft:older": { id: "older", title: "Older", body: "As you can see, one. As you can see, two. As you can see, three.", createdAt: 1, updatedAt: 1000, rev: 1 },
    });
  });
  const page = await openSuggestPad(app);
  assert.equal(await page.inputValue("#padTitle"), "Long notes");
  await page.locator(".suggest-empty").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await phraseCard(page, "as you can see").count(), 0, "drafts past the first 100,000 characters are not read");

  await page.locator("#draftList .draft-item", { hasText: "Older" }).click();
  await phraseCard(page, "as you can see").waitFor();
  assert.deepEqual(app.errors, []);
});

test("other drafts are cut where the 100,000-character budget ends", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  // The phrase twice in the open draft, and a third time past the budget at
  // the end of a long other draft.
  await app.worker.evaluate(async () => {
    let seed = 2463534242;
    const word = () => {
      let text = "";
      for (let i = 0; i < 6; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        text += String.fromCharCode(97 + (seed >>> 0) % 26);
      }
      return text;
    };
    let long = "";
    while (long.length < 120000) long += word() + " ";
    long += "As you can see, three.";
    await chrome.storage.local.set({
      "pad-draft:long": { id: "long", title: "Long notes", body: long, createdAt: 1, updatedAt: 1000, rev: 1 },
      "pad-draft:open": { id: "open", title: "Open", body: "As you can see, one. As you can see, two.", createdAt: 2, updatedAt: 2000, rev: 1 },
    });
  });
  const page = await openSuggestPad(app);
  assert.equal(await page.inputValue("#padTitle"), "Open");
  await page.locator(".suggest-empty").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await phraseCard(page, "as you can see").count(), 0, "the third time is past the budget");
  assert.deepEqual(app.errors, []);
});

test("a long open draft counts once, even when it is cut to the budget", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  // 60,000 characters with the phrase twice near the start: once in the
  // editor and once more in a cut copy would make it look like 4 times.
  await app.worker.evaluate(async () => {
    let seed = 88172645;
    const word = () => {
      let text = "";
      for (let i = 0; i < 6; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        text += String.fromCharCode(97 + (seed >>> 0) % 26);
      }
      return text;
    };
    let body = "As you can see, one. As you can see, two. ";
    while (body.length < 60000) body += word() + " ";
    await chrome.storage.local.set({ "pad-draft:long": { id: "long", title: "Report", body, createdAt: 1, updatedAt: 1000, rev: 1 } });
  });
  const page = await openSuggestPad(app);
  assert.equal(await page.inputValue("#padTitle"), "Report");
  await page.locator(".suggest-empty").waitFor();
  await page.waitForTimeout(500);
  assert.equal(await phraseCard(page, "as you can see").count(), 0, "written twice is not enough");
  assert.deepEqual(app.errors, []);
});

test("a library that cannot be read pauses suggestions and says why", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await fillBody(page, PHRASES);
  await phraseCard(page, "as you can see").waitFor();
  await page.evaluate(() => {
    window.realGetAll = self.ShorthandStorage.getAll;
    self.ShorthandStorage.getAll = () => Promise.reject(new Error("Sync is unavailable"));
  });
  await fillBody(page, PHRASES + " Again.");
  await page.locator(".suggest-notice.error").waitFor();
  assert.equal(await notice(page), "Suggestions are paused: your library could not be read. Sync is unavailable");
  assert.equal(await page.locator(".suggest-card").count(), 0);
  assert.equal(await page.isVisible(".suggest-empty"), false);
  assert.equal(await page.inputValue("#padBody"), PHRASES + " Again.", "the draft is untouched");

  await page.evaluate(() => { self.ShorthandStorage.getAll = window.realGetAll; });
  await fillBody(page, PHRASES + " Again!");
  await phraseCard(page, "as you can see").waitFor();
  assert.equal(await notice(page), "");
  assert.deepEqual(app.errors, []);
});

test("a template save that ends after another draft opens leaves that draft's card alone", async (t) => {
  const app = await launch();
  t.after(() => app.close());
  const page = await openSuggestPad(app);
  await page.fill("#padTitle", "Letter to Sam");
  await fillBody(page, EMAIL);
  await waitSaved(page);
  await page.click("#newDraftBtn");
  await page.fill("#padTitle", "Letter to Ana");
  await fillBody(page, EMAIL.replace("Sam", "Ana"));
  await page.locator(".template-card").waitFor();
  await page.evaluate(() => {
    const save = self.ShorthandStorage.saveShorthand;
    self.ShorthandStorage.saveShorthand = (item) => new Promise((resolve) => setTimeout(resolve, 2000)).then(() => save(item));
  });
  await page.locator(".template-card").getByRole("button", { name: "Save as template" }).click();
  await page.locator("#draftList .draft-item", { hasText: "Letter to Sam" }).click();
  await page.waitForFunction(() => document.getElementById("padTitle").value === "Letter to Sam");
  await page.waitForFunction(() => document.querySelector(".template-card .suggest-trigger")?.value === "lts/");
  // Someone working in the open draft's card while the other save finishes.
  await page.evaluate(() => { document.querySelector(".template-card").dataset.mark = "working"; });
  await page.locator(".template-card .suggest-trigger").fill("mine/");
  await page.waitForFunction(() => document.querySelector(".suggest-notice").textContent.startsWith("Saved lta/."));
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".template-card[data-mark=working]").count(), 1, "the open draft's template card stays as it was");
  assert.equal(await page.evaluate(() => document.activeElement.matches(".template-card .suggest-trigger")), true, "focus stays in it");
  assert.equal(await page.locator(".template-card .suggest-trigger").inputValue(), "mine/");
  assert.deepEqual((await library(app)).filter((item) => item.trigger === "lta/").map((item) => item.expansion.slice(0, 11)), ["Hi [[name]]"]);
  assert.deepEqual(app.errors, []);
});
