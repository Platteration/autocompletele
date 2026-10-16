# Next steps for agents

Handoff written 2026-10-16 after repairing the web extension. Read `AGENTS.md`
first; its rules still apply in full. Owner's direction: the browser extension
is the primary product for now; the Windows (`windows/`) and Android
(`android/`) apps are the next phase, in that order.

## State of the tree

Commit `99422d0` merged `origin/codex/security-audit-2026-10-10` badly and
broke the extension. The repair restored the pre-merge behavior from
`3372a0f` / `2a97039` while keeping the security branch's stricter
grant/consumeEdit input-trust model. Fixed areas:

- `chrome-extension/src/storage.js` and `src/options.js` match `3372a0f`
  exactly (`git diff 3372a0f -- <file>` is empty). This restores the
  Chrome-sync / Firefox-local storage split (`AREA`/`dataStore`), per-area
  quotas, record-by-record import verification, and removes a duplicated
  `let outcome` that made `options.js` a SyntaxError.
- `chrome-extension/src/content.js`: one copy each of
  `grantUserInput`/`consumeEdit`/`typedTrigger` (the NBSP-tolerant copy won;
  a strict duplicate was shadowing it and broke rich-editor expansion),
  `let templateTarget` restored, picker insertion goes through
  `fillTemplate` + `insertExpansion` again, suggestion keyboard routing
  (`suggestions.handleKeyDown`), suggestion dismissal listeners, and the
  template-form input guard are restored.
- `chrome-extension/src/palette.js`: factory returns `{ score, search }`
  instead of referencing an undefined `root`.
- `chrome-extension/package.json` / `package-lock.json`: dropped dev
  dependencies restored (`playwright 1.64.0`, `selenium-webdriver 4.51.0`,
  `web-ext 10.7.0`); the lockfile was regenerated, not hand-edited.
- `.github/workflows/ci.yml`: build, Firefox lint, and browser-install steps
  restored. `.github/dependabot.yml`: nuget and gradle ecosystems restored.
- Three security test harnesses (`test/event-security.test.js`,
  `test/options-security.test.js`, `test/storage-security.test.js`) now load
  the modules the merged content script requires. No assertions were
  weakened; one dropped test (alphabetised Chrome keys still count as
  persisted) was restored.

## Verified (2026-10-16, this machine)

- Extension unit tests: **259/259 pass** (`npm test` in `chrome-extension/`).
  The bad merge had also dropped 4 `event-security` tests (19 -> 15),
  including the two NBSP tests guarding the duplicate `consumeEdit` fix;
  restored verbatim from `3372a0f` on 2026-10-16.
- Chrome e2e: **168/168 pass** (`npm run test:e2e`, `EXTENSION_PATH=dist/chrome`).
- Firefox core e2e file: **16/16 pass** (`e2e-firefox/extension.e2e.js`).
- `npm ci`, `npm run build`, and `npm run lint:firefox` all succeed
  (lint: 0 errors, 0 warnings, 0 notices). `node --check` is clean on every
  JS file in the extension.

## To do next, in order

1. **Confirm the full Firefox e2e suite in CI.** DONE 2026-10-16: CI run
   38979086683 on `d1a48d6` passed all three jobs, including the full
   Firefox e2e step and the Windows and Android build/test jobs.
2. **Windows app baseline.** Nothing in `windows/` was touched by the bad
   merge, but its suite has not been run since. From `windows/`: build
   `ShorthandExpander.sln` and run `ShorthandExpander.Tests`. Report the
   baseline before editing anything (AGENTS.md section 1). Owner wants a
   native desktop branch-out after the extension.
3. **Android app baseline.** Same instruction for `android/`:
   `./gradlew testDebugUnitTest` and `assembleDebug`.
4. **Keep the shared conformance contract.** Any matching/placeholder rule
   change starts as a case in `shared/conformance.json`, then is implemented
   per platform (see `shared/SPEC.md`).

## Local run notes (Windows sandbox quirks, not repo requirements)

- Some tests create temp dirs; point `TEMP`/`TMP` at a workspace folder or
  they fail with `EPERM` under the Muse sandbox. Playwright browsers and
  the npm cache may need the same treatment (`PLAYWRIGHT_BROWSERS_PATH`,
  `npm --cache <local dir>`).
- Firefox e2e locally needs an unsandboxed shell (loopback listener plus
  Selenium Manager driver download). Do not treat either sandbox failure as
  a test result.

## Do not redo

- Do not reintroduce the security branch's duplicate strict `consumeEdit`;
  rich editors rewrite trailing spaces as U+00A0 and the tolerant comparison
  in `sameText` is deliberate (see commit `0b3143e`).
- Do not weaken, skip, or delete tests to get green (AGENTS.md section 4).
- Premium remains a preview: `enforceDailyLimit` stays `false` in
  `src/premium-config.js` until the owner configures a checkout and a real
  public key. No purchases are open.
