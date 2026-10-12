// One behavioral contract runs against each browser's actual extension package.
// Only the browser-driving adapter differs; no content-script API is mocked.
const assert = require("node:assert/strict");

const HOST = "#actle-suggestions-host";
const LIBRARY = [
  { trigger: "cool/", expansion: "You got it." },
  { trigger: "coffee/", expansion: "Coffee is ready." },
  { trigger: "contact/", expansion: "Contact information." },
  { trigger: "confirm/", expansion: "Confirmed." },
  { trigger: "copy/", expansion: "Copied <img src=x> literally." },
  { trigger: "courtesy/", expansion: "Thank you." },
  { trigger: "sig/", expansion: "ab{cursor}cd" },
  { trigger: "hello/", expansion: "Hi [[name]]." },
  { trigger: "yg", expansion: "you got it" },
];

function inspectMenu() {
  const root = this.nodeType === 11 ? this : this.getRootNode();
  return {
    closed: root.host.shadowRoot === null,
    active: document.activeElement.id,
    listRole: root.querySelector(".list").getAttribute("role"),
    items: [...root.querySelectorAll(".item")].map((item) => {
      const bounds = item.getBoundingClientRect();
      return {
        trigger: item.querySelector(".trigger").textContent,
        expansion: item.querySelector(".expansion").textContent,
        selected: item.getAttribute("aria-selected"),
        role: item.getAttribute("role"),
        x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2,
      };
    }),
    images: root.querySelectorAll("img").length,
  };
}

async function runCases(t, app) {
  const evaluate = app.evaluate;
  const visible = (selector = HOST) => evaluate((selector) => !!document.querySelector(selector), selector);
  const read = (selector) => evaluate((selector) => {
    const field = document.querySelector(selector);
    return "value" in field ? field.value : field.textContent.replace(/\u00a0/g, " ");
  }, selector);
  async function until(check, message) {
    for (let i = 0; i < 60; i++) {
      if (await check()) return;
      await app.pause(50);
    }
    assert.fail(message);
  }
  async function opened() { await until(() => visible(), "The real saved-shortcut suggestion menu must open"); }
  async function closed() { await until(async () => !(await visible()), "The suggestion menu must close"); }
  async function reset() { await app.fixture(); await app.pause(150); }
  async function typeInto(selector, text) { await app.click(selector); await app.type(text); }
  async function assertLiteral(selector, text) {
    await typeInto(selector, text);
    assert.equal(await read(selector), text);
    assert.equal(await visible(), false, "Protected fields must not reveal matching snippets");
    assert.equal(await visible("#shorthand-picker-host"), false, "Protected fields must not open the picker");
  }
  async function chooseFirst() { await opened(); await app.key("ArrowDown"); await app.key("Enter"); }
  async function setupField(markup) {
    await evaluate((markup) => {
      document.querySelector("#guard-fixture")?.remove();
      const host = document.createElement("section");
      host.id = "guard-fixture";
      host.innerHTML = markup;
      document.body.append(host);
    }, markup);
  }

  await t.test("offers up to five saved shortcut previews after two physically typed characters", async () => {
    await reset();
    await typeInto("#inp", "c");
    assert.equal(await visible(), false);
    await app.type("o");
    await opened();
    const menu = await app.menu();
    assert.equal(menu.closed, true);
    assert.equal(menu.active, "inp");
    assert.equal(menu.listRole, "listbox");
    assert.equal(menu.items.length, 5);
    assert.equal(new Set(menu.items.map((item) => item.trigger)).size, 5);
    for (const item of menu.items) {
      assert.ok(item.trigger.startsWith("co"));
      assert.equal(item.expansion, LIBRARY.find((entry) => entry.trigger === item.trigger).expansion);
      assert.equal(item.selected, "false");
      assert.equal(item.role, "option");
    }
    assert.equal(menu.images, 0, "Saved HTML-like text must stay plain preview text");
    assert.equal(await read("#inp"), "co");
  });

  await t.test("ordinary typing, unselected Enter, and Tab retain the page's native behavior", async () => {
    await reset();
    await typeInto("#inp", "co");
    await opened();
    await app.type("x");
    assert.equal(await read("#inp"), "cox");
    await closed();
    await typeInto("#ta", "co");
    await opened();
    await app.key("Enter");
    assert.equal(await read("#ta"), "co\n");
    await closed();
    await reset();
    await typeInto("#inp", "co");
    await opened();
    await app.key("Tab");
    assert.equal(await evaluate(() => document.activeElement.id), "ta");
    assert.equal(await read("#inp"), "co");
    await closed();
  });

  await t.test("Escape suppresses suggestions for the current word, and a new word or blur resets it", async () => {
    await reset();
    await typeInto("#inp", "co");
    await opened();
    await app.key("Escape");
    await app.type("o");
    assert.equal(await visible(), false);
    assert.equal(await read("#inp"), "coo");
    await app.type(" co");
    await opened();
    await app.key("Escape");
    await app.click("#ta");
    await app.click("#inp");
    await app.type("o");
    await opened();
  });

  await t.test("keyboard acceptance preserves surrounding text, cursor markers, and partial-prefix undo in all editors", async () => {
    for (const selector of ["#inp", "#ta", "#ce"]) {
      await reset();
      // Surrounding page text is setup only. The entire eligible prefix is typed
      // physically below, so the extension's trusted-edit grants remain intact.
      await evaluate((selector) => {
        const field = document.querySelector(selector);
        if ("value" in field) field.value = "Before | after";
        else field.textContent = "Before | after";
        field.focus();
        if ("setSelectionRange" in field) field.setSelectionRange(7, 7);
        else {
          const range = document.createRange();
          range.setStart(field.firstChild, 7); range.collapse(true);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }
      }, selector);
      await app.type("si");
      await opened();
      await app.key("ArrowDown");
      assert.equal((await app.menu()).items.filter((item) => item.selected === "true").length, 1);
      await app.key("Enter");
      await until(async () => (await read(selector)) === "Before abcd| after", `${selector}: insert over only the prefix`);
      const caret = await evaluate((selector) => {
        const field = document.querySelector(selector);
        return "selectionStart" in field ? field.selectionStart : getSelection().anchorOffset;
      }, selector);
      assert.equal(caret, 9);
      await app.key("Backspace");
      assert.equal(await read(selector), "Before si| after");
      await closed();
    }
  });

  await t.test("a real pointer click accepts its row while focus stays in the original field", async () => {
    await reset();
    await typeInto("#inp", "co");
    await opened();
    const choice = (await app.menu()).items[1];
    await app.pointer(choice.x, choice.y);
    await until(async () => (await read("#inp")) === choice.expansion, "Clicking a suggestion must insert that saved expansion");
    assert.equal(await evaluate(() => document.activeElement.id), "inp");
    await app.key("Backspace");
    assert.equal(await read("#inp"), "co");
  });

  await t.test("exact shorthands still expand immediately and mid-word fragments do not suggest", async () => {
    await reset();
    await typeInto("#inp", "school/");
    assert.equal(await read("#inp"), "school/");
    assert.equal(await visible(), false);
    await app.type(" cool/");
    assert.equal(await read("#inp"), "school/ You got it.");
    await closed();
  });

  await t.test("a suggested template uses the existing form and restores the partial prefix on undo", async () => {
    await reset();
    await typeInto("#inp", "he");
    await chooseFirst();
    await until(() => visible("#shorthand-template-host"), "Choosing a template should open its form");
    assert.equal(await read("#inp"), "he");
    await app.key("Enter");
    assert.equal(await visible("#shorthand-template-host"), true, "An empty answer must not insert");
    await app.type("Alex");
    await app.key("Enter");
    await until(async () => (await read("#inp")) === "Hi Alex.", "Completed template must insert");
    await app.key("Backspace");
    assert.equal(await read("#inp"), "he");
  });

  await t.test("changed values, selections, and credential metadata invalidate an open suggestion", async () => {
    for (const change of ["value", "selection", "username"]) {
      await reset();
      await typeInto("#inp", "co");
      await opened();
      await app.key("ArrowDown");
      await evaluate((change) => {
        const field = document.querySelector("#inp");
        if (change === "value") field.value = "A newer page draft";
        if (change === "selection") field.setSelectionRange(0, 0);
        if (change === "username") field.autocomplete = "username";
      }, change);
      await app.key("Enter");
      assert.equal(await read("#inp"), change === "value" ? "A newer page draft" : "co");
      await closed();
    }
  });

  await t.test("page-fabricated edits, keys, and prefilled prefixes cannot reveal or accept saved suggestions", async () => {
    await reset();
    await evaluate(() => {
      const field = document.querySelector("#inp");
      field.focus(); field.value = "co"; field.setSelectionRange(2, 2);
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "co" }));
    });
    assert.equal(await visible(), false);
    await evaluate(() => {
      const field = document.querySelector("#inp");
      field.value = ""; field.focus(); document.execCommand("insertText", false, "co");
    });
    assert.equal(await visible(), false);
    await reset();
    await evaluate(() => {
      const field = document.querySelector("#inp");
      field.value = "c"; field.focus(); field.setSelectionRange(1, 1);
    });
    await app.type("o");
    assert.equal(await visible(), false, "The whole suggested prefix must come from real user editing");
    await reset();
    await typeInto("#inp", "co");
    await opened();
    await evaluate(() => {
      const field = document.querySelector("#inp");
      for (const key of ["ArrowDown", "Enter"]) field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    });
    assert.equal(await read("#inp"), "co");
    assert.equal((await app.menu()).items.filter((item) => item.selected === "true").length, 0);
    // Automation can inspect the closed root; this does not open it to the page.
    // Even an event delivered directly to a row must carry real user intent.
    await app.fabricatedPick();
    assert.equal(await read("#inp"), "co");
    assert.equal(await visible(), true);
  });

  await t.test("composition cancels the menu and untrusted composing input never reopens it", async () => {
    await reset();
    await typeInto("#inp", "co");
    await opened();
    await evaluate(() => {
      const field = document.querySelector("#inp");
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "co", isComposing: true }));
    });
    await closed();
    assert.equal(await read("#inp"), "co");
    await evaluate(() => document.querySelector("#inp").dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    assert.equal(await visible(), false);
  });

  await t.test("pause, per-site exclusions, and the suggestion preference stop suggestions", async () => {
    const hostname = await evaluate(() => location.hostname);
    for (const patch of [{ enabled: false }, { excludedHosts: [hostname] }, { suggestionsEnabled: false }]) {
      await app.settings(patch);
      await reset();
      await typeInto("#inp", "co");
      assert.equal(await visible(), false);
      await app.type("ol/");
      assert.equal(await read("#inp"), patch.suggestionsEnabled === false ? "You got it." : "cool/");
      await app.settings({ enabled: true, excludedHosts: [], suggestionsEnabled: true });
    }
    await reset();
    await typeInto("#inp", "co");
    await opened();
  });

  await t.test("the real menu is styled and usable under a strict page CSP", async () => {
    await app.fixture("strict-csp.html");
    await app.pause(150);
    await evaluate(() => {
      window.suggestionViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => window.suggestionViolations.push(event.violatedDirective));
    });
    await typeInto("#inp", "co");
    await opened();
    const box = await evaluate(() => {
      const host = document.querySelector("#actle-suggestions-host");
      const bounds = host.getBoundingClientRect();
      return { position: getComputedStyle(host).position, width: bounds.width, height: bounds.height };
    });
    assert.equal(box.position, "fixed");
    assert.ok(box.width > 200 && box.height > 50, JSON.stringify(box));
    await chooseFirst();
    assert.notEqual(await read("#inp"), "co");
    assert.deepEqual(await evaluate(() => window.suggestionViolations), []);
  });

  await t.test("recognizes username, password, one-time-code, and payment metadata without editing those fields", async () => {
    await reset();
    const fixtures = [
      '<input id="guard" autocomplete="section-login username">',
      '<input id="guard" name="user_name">',
      '<label>Username<input id="guard"></label>',
      '<span id="credential-label">Username</span><input id="guard" aria-labelledby="credential-label">',
      '<input id="guard" aria-label="User name">',
      '<input id="guard" placeholder="Password">',
      '<input id="guard" type="password">',
      '<input id="guard" type="text" name="password">',
      '<input id="guard" autocomplete="current-password">',
      '<input id="guard" autocomplete="new-password">',
      '<input id="guard" autocomplete="one-time-code">',
      '<input id="guard" autocomplete="cc-number">',
      '<input id="guard" autocomplete="cc-name">',
      '<form><input id="guard" name="email"><input type="password"></form>',
      '<form id="sign-in"><input id="guard" name="identifier"></form>',
      '<div id="guard" contenteditable="true" aria-label="Username"></div>',
    ];
    for (const markup of fixtures) {
      await setupField(markup);
      await assertLiteral("#guard", "cool/ ;; co");
    }
  });

  await t.test("protected rich-editor descendants stay literal and invalidate an already open suggestion", async () => {
    for (const classifyAfterTyping of [false, true]) {
      await reset();
      await setupField('<div id="guard" contenteditable="true"><span id="protected-child">Note:</span></div>');
      await evaluate((classifyAfterTyping) => {
        const field = document.querySelector("#guard");
        const child = document.querySelector("#protected-child");
        if (!classifyAfterTyping) child.setAttribute("aria-label", "Username");
        field.focus();
        const range = document.createRange(); range.setStart(child.firstChild, 5); range.collapse(true);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }, classifyAfterTyping);
      if (classifyAfterTyping) {
        await app.type("co");
        await opened();
        await evaluate(() => document.querySelector("#protected-child").setAttribute("aria-label", "Username"));
        await app.key("ArrowDown");
        await app.key("Enter");
        // Enter remains native in rich text, so inspect the original protected
        // descendant instead of making assumptions about browser newline DOM.
        assert.equal(await evaluate(() => document.querySelector("#protected-child").textContent), "Note:co");
      } else {
        await app.type("cool/ ;; co");
        assert.equal(await read("#guard"), "Note:cool/ ;; co");
      }
      assert.equal(await visible(), false);
      assert.equal(await visible("#shorthand-picker-host"), false);
    }
  });

  await t.test("ordinary contact email and message fields remain useful, including messages beside a password", async () => {
    await reset();
    for (const markup of [
      '<label>Contact email<input id="guard" type="text" autocomplete="email" name="email"></label>',
      '<form><textarea id="guard" name="message"></textarea><input type="password"></form>',
      '<input id="guard" name="full_name" aria-label="Your name">',
    ]) {
      await setupField(markup);
      await typeInto("#guard", "co");
      await opened();
      await app.type("ol/");
      assert.equal(await read("#guard"), "You got it.");
    }
  });

  await t.test("reclassifying a field as a username prevents picker insertion and shortcut undo", async () => {
    await reset();
    await typeInto("#inp", ";;");
    assert.equal(await visible("#shorthand-picker-host"), true);
    await evaluate(() => { document.querySelector("#inp").autocomplete = "username"; });
    await app.key("Enter");
    assert.equal(await read("#inp"), ";;");
    await reset();
    await typeInto("#inp", "yg");
    assert.equal(await read("#inp"), "you got it");
    await evaluate(() => { document.querySelector("#inp").autocomplete = "username"; });
    await app.key("Backspace");
    assert.equal(await read("#inp"), "you got i", "Credential fields keep native Backspace instead of restoring the trigger");
  });

  await t.test("a template cannot write into a target that becomes a credential field", async () => {
    await reset();
    await typeInto("#inp", "he");
    await chooseFirst();
    await until(() => visible("#shorthand-template-host"), "A suggested template must open its form");
    await evaluate(() => { document.querySelector("#inp").autocomplete = "username"; });
    await app.type("Alex");
    await app.key("Enter");
    await app.pause(150);
    assert.equal(await read("#inp"), "he");
    assert.equal(await visible("#shorthand-template-host"), true);
    await app.key("Escape");
  });

  await t.test("the suggestions setting defaults on without rewriting legacy settings", async () => {
    await app.options();
    await evaluate(async () => {
      await chrome.storage[self.ShorthandStorage.AREA].set({ settings: {
        enabled: true, excludedHosts: [], pickerTrigger: ";;", animationMode: "off", retained: "keep",
      } });
    });
    const before = await evaluate(() => chrome.storage[self.ShorthandStorage.AREA].get(null));
    await app.reload();
    await until(() => evaluate(() => !!document.querySelector("#suggestionsEnabled")), "The accessible suggestion setting must exist");
    assert.equal(await evaluate(() => document.querySelector("#suggestionsEnabled").checked), true);
    assert.equal(await evaluate(() => document.querySelector("#suggestionsLabel").textContent.trim()), "Suggest saved shortcuts");
    assert.equal(await evaluate(() => document.querySelector("#suggestionsMsg").getAttribute("role")), "status");
    assert.deepEqual(await evaluate(() => chrome.storage[self.ShorthandStorage.AREA].get(null)), before);
  });

  await t.test("toggling suggestions saves immediately, keeps focus, and preserves library data across reload", async () => {
    const before = await evaluate(() => chrome.storage[self.ShorthandStorage.AREA].get(null));
    await app.click("#suggestionsEnabled");
    await until(() => evaluate(() => document.querySelector("#suggestionsMsg").textContent === "Suggestions saved: off."), "The preference save must be announced");
    assert.equal(await evaluate(() => document.activeElement.id), "suggestionsEnabled");
    assert.deepEqual(await evaluate(() => chrome.storage[self.ShorthandStorage.AREA].get(null)), {
      ...before, settings: { ...before.settings, suggestionsEnabled: false },
    });
    await app.reload();
    await until(() => evaluate(() => !document.querySelector("#suggestionsEnabled").checked), "The saved preference must survive reload");
  });

  await t.test("a rejected preference save restores its value with a persistent visible error and sensible focus", async () => {
    const before = await evaluate(() => chrome.storage[self.ShorthandStorage.AREA].get(null));
    await evaluate(() => {
      self.ShorthandStorage.saveSettings = () => new Promise((_resolve, reject) => {
        self.rejectSuggestionSave = () => reject(new Error("Test write rejected"));
      });
    });
    for (const moveFocus of [false, true]) {
      await app.click("#suggestionsEnabled");
      assert.equal(await evaluate(() => document.querySelector("#suggestionsEnabled").disabled), true);
      assert.equal(await evaluate(() => document.querySelector("#suggestionsMsg").textContent), "Saving suggestions…");
      if (moveFocus) await app.click("#pickerTrigger");
      await evaluate(() => self.rejectSuggestionSave());
      await until(() => evaluate(() => !document.querySelector("#suggestionsEnabled").disabled), "A rejected save must re-enable its control");
      assert.equal(await evaluate(() => document.querySelector("#suggestionsEnabled").checked), false);
      assert.equal(await evaluate(() => document.querySelector("#suggestionsMsg").textContent),
        "Could not save suggestions: Test write rejected. Previous preference kept.");
      assert.equal(await evaluate(() => document.querySelector("#suggestionsMsg").classList.contains("error")), true);
      assert.equal(await evaluate(() => document.activeElement.id), moveFocus ? "pickerTrigger" : "suggestionsEnabled");
      assert.deepEqual(await evaluate(() => chrome.storage[self.ShorthandStorage.AREA].get(null)), before);
    }
  });
}

module.exports = { HOST, LIBRARY, inspectMenu, runCases };
