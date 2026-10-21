// Everything the desktop app does that does not need Electron: files, the
// engine, metrics, learning and the operations the dashboard calls. main.js
// adds the tray, the windows and the input/output adapters; simulate.js drives
// the same object from a script.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("../core/index.js");
const learning = require("./learning.js");
const { loadCorpusKey } = require("./corpus-key.js");
const { loadApps } = require("./apps/index.js");

function readPolicyFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return null;
  }
}

function createAssistant(options) {
  const settings = Object.assign({ now: () => Date.now(), swallowsTriggerKey: false }, options || {});
  const store = core.store.createStore(settings.dataDir);
  const warnings = [];
  const log = typeof settings.log === "function" ? settings.log : () => {};

  let userSettings = store.loadSettings();

  // Learned text is only ever written encrypted. Without a usable keychain
  // key, sessions are not stored and the dashboard says so.
  const corpusKey = loadCorpusKey({ store, keychain: settings.keychain });
  const learningStorage = !!corpusKey.key;
  if (learningStorage) store.setCorpusBox(core.cryptoBox.createBox(corpusKey.key));
  else warnings.push(corpusKey.message);
  if (corpusKey.status === "created" || corpusKey.status === "replaced") {
    audit({ event: "corpus-key-" + corpusKey.status, aside: corpusKey.aside || null });
  }
  const encryptedNow = store.encryptCorpus();
  if (encryptedNow) audit({ event: "corpus-encrypted", sessions: encryptedNow });
  // Dismissals written as plain text by an earlier version become digests.
  const dismissedBefore = store.loadLearned().dismissed;
  if (dismissedBefore.some((entry) => !entry.startsWith("sha256:"))) {
    store.saveLearned({ dismissed: [...new Set(dismissedBefore.map(learning.dismissalKey))] });
  }

  // A desk is "managed" when IT installed a deployment file naming signed
  // policy sources. Then only signed layers apply; an unsigned local policy
  // file is ignored, so it cannot override what the organisation signed.
  const deploymentRaw = settings.deployment !== undefined ? settings.deployment : store.loadDeployment();
  const policySource = deploymentRaw ? core.policySource.createPolicySource({
    deployment: deploymentRaw,
    cache: { load: store.loadPolicyCache, save: store.savePolicyCache },
    fetch: settings.fetch,
    readFile: settings.readFile,
    now: settings.now,
  }) : null;
  const managed = !!(policySource && policySource.deployment.sources.length);
  if (policySource && !managed) warnings.push(...policySource.deployment.warnings);
  let sourceReport = { sources: [], warnings: [] };

  let rawPolicy = managed ? null : store.loadPolicy();
  if (managed) {
    sourceReport = policySource.loadCached();
    rawPolicy = core.orgPolicy.merge(sourceReport.layers);
    if (store.loadPolicy() != null || settings.policyFile) {
      warnings.push("a local policy file is ignored because this desk receives a signed policy from its deployment settings");
    }
  } else if (rawPolicy == null && settings.policyFile) {
    const text = readPolicyFile(settings.policyFile);
    if (text == null) {
      warnings.push("policy file " + settings.policyFile + " could not be read; running without an organisation policy");
    } else {
      try {
        rawPolicy = JSON.parse(text);
      } catch (error) {
        warnings.push("policy file " + settings.policyFile + " is not valid JSON (" + error.message + "); running without an organisation policy");
      }
    }
  }
  if (!managed && rawPolicy == null && settings.policy) rawPolicy = settings.policy;

  function buildPolicy() {
    const policy = core.orgPolicy.parse(rawPolicy == null ? {} : rawPolicy);
    // The person's own capture rules take precedence over the organisation's.
    const own = core.capturePolicy.createPolicy({ defaultMode: policy.capture.defaultMode, apps: userSettings.captureApps });
    policy.capture = { defaultMode: policy.capture.defaultMode, apps: own.apps.concat(policy.capture.apps), warnings: policy.capture.warnings.concat(own.warnings) };
    if (userSettings.charsPerMinute) policy.typing.charsPerMinute = userSettings.charsPerMinute;
    return policy;
  }

  let policy = buildPolicy();

  const ledger = core.metrics.createLedger({ now: settings.now, charsPerMinute: policy.typing.charsPerMinute });
  ledger.load(store.loadMetrics());
  ledger.onRecord((entry) => store.appendMetric(entry));
  store.pruneMetrics(policy.retention.metricsDays);
  store.pruneSessions(policy.retention.corpusDays);
  warnings.push(...store.warnings());

  const engine = core.engine.createEngine({
    library: store.loadLibrary(),
    policy,
    ledger,
    now: settings.now,
    swallowsTriggerKey: settings.swallowsTriggerKey,
  });
  engine.setEnabled(userSettings.enabled);
  recordPolicyAudit("start");

  // The suite's apps. Each gets the same host; a broken app is logged and
  // skipped so the assistant always starts.
  const host = {
    store,
    engine,
    ledger,
    policy: () => policy,
    settings: () => Object.assign({}, userSettings),
    saveSettings: (next) => saveSettings(next),
    audit: (entry) => audit(entry),
    now: () => settings.now(),
    log,
    recordInsert: (event) => engine.recordInsert(event),
    dataDir: store.root,
    appData: (id) => ({ load: (fallback) => store.loadAppData(id, fallback), save: (value) => store.saveAppData(id, value) }),
  };
  const apps = loadApps(host, { ids: settings.appIds, factories: settings.apps, log: (line) => { warnings.push(line); log(line); } });
  engine.setExtensions(apps.map((app) => app.extension).filter(Boolean));
  const appById = new Map(apps.map((app) => [app.id, app]));

  function notifyApps(hook, value) {
    for (const app of apps) {
      if (typeof app[hook] !== "function") continue;
      try {
        app[hook](value);
      } catch (error) {
        log("app " + app.id + " " + hook + " failed: " + error.message);
      }
    }
  }

  /** Call an app's IPC channel ("guard:summary"). Unknown channels are an error result, never a throw. */
  function invoke(channel, payload) {
    const name = String(channel == null ? "" : channel);
    const app = appById.get(name.split(":")[0]);
    const fn = app && app.ipc[name];
    if (!fn) return { ok: false, error: "unknown channel " + name };
    return fn(payload);
  }

  function appsInfo() {
    return apps.map((app) => ({ id: app.id, title: app.title, tab: app.tab !== false }));
  }

  let cachedCandidates = null;
  const listeners = { session: [], candidates: [] };
  let filingIndex = core.filer.normalizeIndex(store.loadFilingIndex());

  function audit(entry) {
    store.appendAudit(Object.assign({ at: settings.now() }, entry));
  }

  function sourceStatusKey(source) {
    if (source.status === "failed") return "failed: " + (source.error || "");
    if (source.error) return "cached: " + source.error;
    return "ok";
  }

  // Record what the organisation changed, and when a policy source starts or
  // stops failing. Never typed text: hashes, serials, labels and statuses.
  function recordPolicyAudit(origin) {
    const hash = core.policySigning.sha256(JSON.stringify(rawPolicy == null ? {} : rawPolicy));
    const state = store.loadPolicyState() || {};
    const previous = state.sourceStatus && typeof state.sourceStatus === "object" ? state.sourceStatus : {};
    const sourceStatus = {};
    for (const source of sourceReport.sources) {
      const key = sourceStatusKey(source);
      sourceStatus[source.id] = key;
      const before = previous[source.id] || "ok";
      if (key !== before) {
        audit({ event: key === "ok" ? "policy-source-recovered" : "policy-source-problem", source: source.label, location: source.location, status: source.status, error: source.error || null });
      }
    }
    if (state.hash !== hash) {
      audit({
        event: "policy-applied",
        origin,
        hash,
        previousHash: state.hash || null,
        organization: policy.organization,
        paused: policy.paused.active,
        sources: sourceReport.sources.map((source) => ({ label: source.label, status: source.status, serial: source.serial || null, keyId: source.keyId || null })),
        warnings: policy.warnings.length,
      });
    }
    store.savePolicyState({ hash, appliedAt: settings.now(), sourceStatus });
  }

  // Apply a new policy without disturbing the field being typed in: the
  // learning session and the field's rule state survive unless the policy
  // itself ends learning there (then the session is stored).
  function applyEngineSettings() {
    persistSession(engine.setPolicy(policy));
    if (engine.enabled !== userSettings.enabled) persistSession(engine.setEnabled(userSettings.enabled).session);
  }

  function applyPolicy(origin) {
    policy = buildPolicy();
    applyEngineSettings();
    cachedCandidates = null;
    recordPolicyAudit(origin);
    notifyApps("onPolicy", policy);
  }

  /** Fetch the signed policy layers again (managed desks only). */
  async function refreshPolicy() {
    if (!managed) return { ok: false, managed: false, sources: [], warnings: [] };
    sourceReport = await policySource.refresh();
    rawPolicy = core.orgPolicy.merge(sourceReport.layers);
    applyPolicy("refresh");
    return { ok: true, managed: true, sources: sourceReport.sources.slice(), warnings: sourceReport.warnings.slice(), paused: policy.paused.active };
  }

  function emit(name, value) {
    for (const listener of listeners[name]) listener(value);
  }

  function on(name, listener) {
    if (listeners[name]) listeners[name].push(listener);
  }

  function persistSession(session) {
    if (!session || !learningStorage) return;
    store.appendSession(session);
    cachedCandidates = null;
    emit("session", session);
    emit("candidates", candidates());
  }

  function focusChanged(context) {
    const result = engine.focusChanged(context);
    persistSession(result.session);
    notifyApps("onFocus", engine.context);
    return result;
  }

  function endSession() {
    persistSession(engine.endSession());
  }

  function keyTyped(key) {
    return engine.keyTyped(key);
  }

  function candidates() {
    if (!cachedCandidates) {
      cachedCandidates = learning.candidates({
        sessions: store.loadSessions(),
        library: engine.library,
        learning: policy.learning,
        dismissed: store.loadLearned().dismissed,
      });
    }
    return cachedCandidates.slice();
  }

  function corpusInfo() {
    return Object.assign(store.corpusInfo(), {
      storing: learningStorage,
      problem: learningStorage ? null : corpusKey.message,
      retentionDays: policy.retention.corpusDays,
    });
  }

  /** The person deletes everything learned so far (decisions on proposals are kept). */
  function clearLearning() {
    const before = store.corpusInfo();
    store.clearSessions();
    // Everything derived from learned text goes too: dismissals and the
    // suggestions not yet exported.
    store.saveLearned({ dismissed: [] });
    store.saveSuggestions([]);
    cachedCandidates = null;
    audit({ event: "corpus-deleted", by: "person", sessions: before.sessions + before.locked });
    emit("candidates", candidates());
    return corpusInfo();
  }

  function saveShorthand(sh) {
    const trigger = String(sh && sh.trigger == null ? "" : sh.trigger).trim();
    const expansion = String(sh && sh.expansion == null ? "" : sh.expansion);
    if (!trigger) return { ok: false, error: "The trigger cannot be empty." };
    if (/\s/.test(trigger)) return { ok: false, error: "The trigger cannot contain spaces." };
    const list = store.loadLibrary().filter((item) => item.trigger !== trigger && item.trigger !== (sh.previousTrigger || ""));
    list.push({ trigger, expansion });
    store.saveLibrary(list);
    engine.setLibrary(list);
    cachedCandidates = null;
    return { ok: true, library: engine.library };
  }

  function deleteShorthand(trigger) {
    const list = store.loadLibrary().filter((item) => item.trigger !== trigger);
    store.saveLibrary(list);
    engine.setLibrary(list);
    cachedCandidates = null;
    return { ok: true, library: engine.library };
  }

  function acceptCandidate(candidate) {
    let expansion = candidate && candidate.expansion;
    // A template proposal is rebuilt here from its segments, with the
    // person's names for its blanks, rather than trusting text from the page.
    if (candidate && candidate.template != null) {
      const found = candidates().find((c) => c.kind === "template" && c.template === candidate.template);
      if (!found) return { ok: false, error: "This proposal has changed. Look at the Learning tab again." };
      const built = core.variableDetector.templateFrom(found.segments, candidate.names);
      if (!built.ok) return { ok: false, error: built.error };
      expansion = built.template;
    }
    const result = saveShorthand({ trigger: candidate && candidate.trigger, expansion });
    if (result.ok) {
      ledger.record({ kind: "learned", trigger: candidate.trigger, keystrokesSaved: 0, app: "" });
    }
    return result;
  }

  function dismissCandidate(text) {
    const learned = store.loadLearned();
    const value = String(text == null ? "" : text);
    const key = learning.dismissalKey(value);
    if (value && !learned.dismissed.includes(key)) learned.dismissed.push(key);
    store.saveLearned(learned);
    cachedCandidates = null;
    return candidates();
  }

  function saveSettings(next) {
    const merged = Object.assign({}, userSettings, next || {});
    const before = JSON.stringify(userSettings.captureApps || []);
    store.saveSettings(merged);
    userSettings = store.loadSettings();
    if (JSON.stringify(userSettings.captureApps || []) !== before) {
      audit({ event: "capture-rules-changed", by: "person", rules: userSettings.captureApps.map((rule) => ({ label: rule.label || null, mode: rule.mode || null, match: rule.match || { process: rule.process, title: rule.title, bundleId: rule.bundleId } })) });
    }
    policy = buildPolicy();
    applyEngineSettings();
    cachedCandidates = null;
    notifyApps("onSettings", Object.assign({}, userSettings));
    notifyApps("onPolicy", policy);
    return userSettings;
  }

  function setEnabled(value) {
    return saveSettings({ enabled: value !== false });
  }

  // Search palette: find and insert any shortcut or document set without
  // remembering its trigger.
  function paletteSearch(query, limit) {
    if (policy.paused.active) return [];
    let items = core.paletteSearch.items(engine.library, policy.documents, filingIndex);
    for (const app of apps) {
      if (!app.palette || typeof app.palette.items !== "function") continue;
      const extra = app.palette.items() || [];
      items = items.concat(extra.map((item) => Object.assign({ source: "organization", needsInput: false, preview: "" }, item, { kind: "app:" + app.id })));
    }
    return core.paletteSearch.search(items, query, limit).map((item) => ({
      kind: item.kind, trigger: item.trigger, source: item.source, needsInput: item.needsInput, preview: item.preview,
    }));
  }

  /** The action for a palette choice. The query and Enter count as keystrokes spent. */
  function paletteChoose(choice) {
    if (policy.paused.active || !choice) return null;
    const spentKeystrokes = core.metrics.graphemes(String(choice.query == null ? "" : choice.query)) + 1;
    if (choice.kind === "documents") {
      const set = policy.documents.shortcuts.find((s) => s.trigger === choice.trigger);
      return set ? { type: "documents", trigger: set.trigger, label: set.label, documents: set.documents.slice(), backspaces: 0, via: "palette" } : null;
    }
    if (typeof choice.kind === "string" && choice.kind.startsWith("app:")) {
      const app = appById.get(choice.kind.slice(4));
      return app && app.palette && typeof app.palette.choose === "function" ? app.palette.choose(Object.assign({}, choice, { spentKeystrokes })) : null;
    }
    if (choice.kind === "file") {
      // A filed document is offered like a one-file document set, so the
      // same popover copies or reveals it. It is not an organisation shortcut.
      const entry = filingIndex.entries.find((e) => e.name === choice.trigger);
      return entry ? { type: "documents", trigger: "", label: entry.ruleLabel || "Filed document", documents: [{ title: entry.name, path: entry.path, tags: [], description: entry.folder }], backspaces: 0, via: "palette" } : null;
    }
    const sh = engine.library.find((item) => item.trigger === choice.trigger);
    if (!sh) return null;
    const { template } = core.personal;
    if (template.requiresInput(sh.expansion)) {
      return { type: "template", trigger: sh.trigger, expansion: sh.expansion, fields: template.fields(sh.expansion), variables: template.variables(sh.expansion), backspaces: 0, source: sh.source, via: "palette", spentKeystrokes };
    }
    const rendered = template.render(sh.expansion, null, new Date(settings.now()));
    return { type: "expand", trigger: sh.trigger, text: rendered.text, cursorOffset: rendered.cursorOffset, backspaces: 0, source: sh.source, via: "palette", spentKeystrokes };
  }

  /** Record a palette expansion after the shell inserted it. */
  function paletteInserted(action) {
    if (!action || action.type !== "expand") return null;
    return engine.recordInsert({ kind: "palette", trigger: action.trigger, source: action.source, inserted: action.text, typed: "", spentKeystrokes: action.spentKeystrokes });
  }

  // Suggestions to the organisation: proposals the person picked.
  function suggestionText(candidate) {
    if (candidate && candidate.template != null) {
      const found = candidates().find((c) => c.kind === "template" && c.template === candidate.template);
      if (!found) return { ok: false, error: "This proposal has changed. Look at the Learning tab again." };
      const built = core.variableDetector.templateFrom(found.segments, candidate.names);
      return built.ok ? { ok: true, text: built.template, kind: "template", sessions: found.sessions } : built;
    }
    const found = candidates().find((c) => c.kind !== "template" && c.text === (candidate && candidate.text));
    if (!found) return { ok: false, error: "This proposal has changed. Look at the Learning tab again." };
    return { ok: true, text: found.text, kind: found.kind, sessions: found.sessions };
  }

  function suggest(candidate) {
    const resolved = suggestionText(candidate);
    if (!resolved.ok) return resolved;
    const queued = core.suggestions.enqueue(store.loadSuggestions(), { kind: resolved.kind, text: resolved.text, trigger: candidate.trigger, sessions: resolved.sessions });
    store.saveSuggestions(queued);
    return { ok: true, queued };
  }

  function unsuggest(text) {
    const key = core.phraseMiner.normalize(text);
    const queued = store.loadSuggestions().filter((item) => core.phraseMiner.normalize(item.text) !== key);
    store.saveSuggestions(queued);
    return { ok: true, queued };
  }

  function suggestionsExport() {
    if (!userSettings.installId) {
      store.saveSettings(Object.assign({}, userSettings, { installId: crypto.randomUUID() }));
      userSettings = store.loadSettings();
    }
    return core.suggestions.buildExport(store.loadSuggestions(), { now: settings.now(), installId: userSettings.installId, team: policy.reporting.team });
  }

  /** The counts-only report this desk would send to its organisation. */
  function usageReport() {
    if (!userSettings.installId) {
      store.saveSettings(Object.assign({}, userSettings, { installId: crypto.randomUUID() }));
      userSettings = store.loadSettings();
    }
    return core.report.buildReport(ledger.entries(), {
      now: settings.now(),
      period: policy.reporting.period,
      count: policy.reporting.periods,
      charsPerMinute: policy.typing.charsPerMinute,
      installId: userSettings.installId,
      team: policy.reporting.team,
      organization: policy.organization,
      includeApps: policy.reporting.includeApps,
      hourlyRate: policy.reporting.hourlyRate,
      currency: policy.reporting.currency,
    });
  }

  // ---- Document filing ---------------------------------------------------

  function expandHome(folder) {
    return String(folder == null ? "" : folder).replace(/^~(?=$|[\\/])/, os.homedir());
  }

  function saveFilingIndex() {
    store.saveFilingIndex(filingIndex);
  }

  /** Folders watched for new documents: the policy's (unless the person turned one off) and the person's own. */
  function filingFolders() {
    const ignored = new Set(userSettings.ignoredFolders);
    const fromPolicy = policy.filing.watch.map((w) => ({ path: expandHome(w.path), raw: w.path, label: w.label, recursive: w.recursive, source: "organization", ignored: ignored.has(w.path) }));
    const own = userSettings.watchFolders.map((w) => (w && typeof w === "object" ? w : { path: w })).filter((w) => typeof w.path === "string" && w.path.trim())
      .map((w) => ({ path: expandHome(w.path.trim()), raw: w.path.trim(), label: w.label || w.path.trim(), recursive: w.recursive === true, source: "personal", ignored: false }));
    return { policy: fromPolicy, own, active: fromPolicy.filter((f) => !f.ignored).concat(own) };
  }

  function filingInfo() {
    return {
      enabled: !policy.paused.active && (policy.filing.rules.length > 0 || !!policy.filing.fallback),
      rules: policy.filing.rules.map((r) => ({ id: r.id, label: r.label, keywords: r.when.keywords, match: r.when.match, extensions: r.when.extensions, name: r.name, folder: r.folder })),
      fallback: policy.filing.fallback ? { id: "fallback", label: policy.filing.fallback.label, name: policy.filing.fallback.name, folder: policy.filing.fallback.folder } : null,
      indexed: filingIndex.entries.length,
      secondsPerFiling: policy.typing.secondsPerFiling,
      folders: filingFolders(),
    };
  }

  /**
   * What the policy would call a file and where it would put it. Null when
   * nothing applies, the file cannot be read, or it was filed already.
   */
  function filingProposal(filePath, answers) {
    if (policy.paused.active) return null;
    if (!policy.filing.rules.length && !policy.filing.fallback) return null;
    const file = path.resolve(String(filePath == null ? "" : filePath));
    if (filingIndex.entries.some((e) => e.path === file)) return null;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      return null;
    }
    if (!stat.isFile()) return null;
    const read = core.extract.extractText(file);
    const proposal = core.filer.propose({ name: path.basename(file), ext: read.ext, text: read.text, modified: stat.mtimeMs }, policy.filing, answers);
    if (!proposal) return null;
    // A relative folder in a rule is relative to where the document is.
    const folder = proposal.folder ? path.resolve(path.dirname(file), expandHome(proposal.folder)) : path.dirname(file);
    return Object.assign({}, proposal, {
      path: file,
      fileName: path.basename(file),
      ext: read.ext,
      folder,
      folderTemplate: proposal.folderTemplate,
      inPlace: !proposal.folder,
      read: { kind: read.kind, unsupported: read.unsupported, truncated: read.truncated, error: read.error },
    });
  }

  function moveFile(from, to) {
    try {
      fs.renameSync(from, to);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      // Another drive or share: copy without overwriting, then remove the original.
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.unlinkSync(from);
    }
  }

  /**
   * Rename and move a document as proposed. `request` is {path, answers,
   * name}: answers fill blanks the text did not; an edited name may still
   * carry blanks, which the answers fill. A name with blanks left is refused
   * so a file is never called "[[client]]". Never overwrites.
   */
  function applyFiling(request) {
    const data = request && typeof request === "object" ? request : {};
    const proposal = filingProposal(data.path, data.answers);
    if (!proposal) return { ok: false, error: "No filing rule applies to this file, or it was filed already." };
    let name = proposal.name;
    let missing = proposal.missing.slice();
    const edited = typeof data.name === "string" ? data.name.trim() : "";
    if (edited) {
      const filled = core.filer.fillTemplate(edited, proposal.values);
      missing = core.filer.blanksOf(filled);
      name = missing.length ? filled : core.filer.safeName(filled.replace(/\.[^.]*$/, (ext) => (ext.slice(1).toLowerCase() === proposal.ext ? "" : ext)), proposal.ext);
    }
    if (missing.length) return { ok: false, error: "Fill in: " + missing.join(", "), missing };
    const folder = proposal.folder;
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (error) {
      return { ok: false, error: "The folder " + folder + " cannot be created: " + error.message };
    }
    const finalName = core.filer.uniqueName(name, (candidate) => fs.existsSync(path.join(folder, candidate)));
    const target = path.join(folder, finalName);
    if (target === proposal.path) return { ok: false, error: "The file already has this name." };
    try {
      moveFile(proposal.path, target);
    } catch (error) {
      return { ok: false, error: "Could not move the file: " + error.message };
    }
    const entry = {
      id: crypto.randomUUID(),
      path: target,
      name: finalName,
      folder,
      originalPath: proposal.path,
      originalName: proposal.fileName,
      rule: proposal.rule.id,
      ruleLabel: proposal.rule.label,
      values: proposal.values,
      filedAt: settings.now(),
      ext: proposal.ext,
    };
    filingIndex = core.filer.addEntry(filingIndex, entry);
    saveFilingIndex();
    audit({ event: "document-filed", rule: proposal.rule.id, from: proposal.path, to: target });
    engine.recordInsert({ kind: "filed", trigger: proposal.rule.id });
    return { ok: true, id: entry.id, from: proposal.path, to: target, name: finalName, folder, rule: proposal.rule };
  }

  /** Put a filed document back where it came from, under its old name. */
  function undoFiling(id) {
    const entry = filingIndex.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, error: "This filing is no longer in the index." };
    if (!fs.existsSync(entry.path)) {
      filingIndex = core.filer.removeEntry(filingIndex, id);
      saveFilingIndex();
      return { ok: false, error: "The file is no longer at " + entry.path + "; it was removed from the index." };
    }
    const originalDir = entry.originalPath ? path.dirname(entry.originalPath) : entry.folder;
    const originalName = entry.originalName || path.basename(entry.originalPath || entry.name);
    try {
      fs.mkdirSync(originalDir, { recursive: true });
      const name = core.filer.uniqueName(originalName, (candidate) => fs.existsSync(path.join(originalDir, candidate)));
      const target = path.join(originalDir, name);
      moveFile(entry.path, target);
      filingIndex = core.filer.removeEntry(filingIndex, id);
      saveFilingIndex();
      audit({ event: "document-unfiled", rule: entry.rule, from: entry.path, to: target });
      return { ok: true, from: entry.path, to: target };
    } catch (error) {
      return { ok: false, error: "Could not move the file back: " + error.message };
    }
  }

  function filingRecent(limit) {
    const count = Math.floor(Number(limit)) || 50;
    // Newest first; filings made in the same instant keep reverse index order.
    return filingIndex.entries.map((e, i) => [e, i]).sort((a, b) => b[0].filedAt - a[0].filedAt || b[1] - a[1])
      .slice(0, count).map(([e]) => Object.assign({}, e, { values: Object.assign({}, e.values) }));
  }

  function filingSearch(query, limit) {
    return core.filer.search(query, filingIndex, limit).map((r) => Object.assign({ score: r.score }, r.entry, { values: Object.assign({}, r.entry.values) }));
  }

  function filingClear() {
    const count = filingIndex.entries.length;
    filingIndex = core.filer.normalizeIndex(null);
    saveFilingIndex();
    audit({ event: "filing-index-cleared", entries: count });
    return { ok: true, removed: count };
  }

  function filingAddFolder(folder) {
    const value = String(folder == null ? "" : folder).trim();
    if (!value) return { ok: false, error: "No folder given." };
    const own = userSettings.watchFolders.filter((w) => (w && typeof w === "object" ? w.path : w) !== value);
    own.push({ path: value });
    saveSettings({ watchFolders: own });
    return { ok: true, folders: filingFolders() };
  }

  function filingRemoveFolder(folder) {
    const value = String(folder == null ? "" : folder).trim();
    saveSettings({ watchFolders: userSettings.watchFolders.filter((w) => (w && typeof w === "object" ? w.path : w) !== value) });
    return { ok: true, folders: filingFolders() };
  }

  /** Turn a policy watch folder off on this desk, or on again. */
  function filingIgnoreFolder(rawPath, ignore) {
    const value = String(rawPath == null ? "" : rawPath).trim();
    const list = userSettings.ignoredFolders.filter((p) => p !== value);
    if (ignore !== false) list.push(value);
    saveSettings({ ignoredFolders: list });
    return { ok: true, folders: filingFolders() };
  }

  function policyInfo() {
    return {
      organization: policy.organization,
      warnings: policy.warnings.slice(),
      typing: Object.assign({}, policy.typing),
      capture: { defaultMode: policy.capture.defaultMode, apps: policy.capture.apps.map((rule) => Object.assign({}, rule)) },
      keywordRules: policy.keywordRules.map((rule) => Object.assign({}, rule)),
      documents: policy.documents.shortcuts.map((s) => Object.assign({}, s)),
      organizationLibrary: policy.library.slice(),
      learning: Object.assign({}, policy.learning),
      retention: Object.assign({}, policy.retention),
      paused: Object.assign({}, policy.paused),
      reporting: Object.assign({}, policy.reporting),
      managed,
      refreshMinutes: managed ? policySource.deployment.refreshMinutes : null,
      sources: sourceReport.sources.map((source) => Object.assign({}, source)),
    };
  }

  return {
    store,
    engine,
    ledger,
    on,
    focusChanged,
    endSession,
    keyTyped,
    recordInsert: (event) => engine.recordInsert(event),
    candidates,
    acceptCandidate,
    dismissCandidate,
    saveShorthand,
    deleteShorthand,
    importLibrary: (text) => {
      const result = store.importLibraryJson(text);
      if (result.ok) engine.setLibrary(store.loadLibrary());
      cachedCandidates = null;
      return result;
    },
    exportLibrary: () => store.exportLibraryJson(),
    library: () => engine.library,
    settings: () => Object.assign({}, userSettings),
    saveSettings,
    setEnabled,
    policyInfo,
    policy: () => policy,
    summary: (query) => ledger.summary(query),
    series: (query) => ledger.series(query),
    byApp: (query) => ledger.byApp(query),
    warnings: () => warnings.concat(sourceReport.warnings, policy.warnings, store.warnings()),
    refreshPolicy,
    usageReport,
    corpusInfo,
    clearLearning,
    paletteSearch,
    paletteChoose,
    paletteInserted,
    filingInfo,
    filingFolders,
    filingProposal,
    applyFiling,
    undoFiling,
    filingRecent,
    filingSearch,
    filingClear,
    filingAddFolder,
    filingRemoveFolder,
    filingIgnoreFolder,
    apps,
    app: (id) => appById.get(id) || null,
    appsInfo,
    invoke,
    suggest,
    unsuggest,
    suggestions: () => store.loadSuggestions(),
    suggestionsExport,
    audit: (limit) => store.loadAudit(limit),
    get managed() { return managed; },
    get paused() { return policy.paused.active; },
    log,
  };
}

module.exports = { createAssistant };
