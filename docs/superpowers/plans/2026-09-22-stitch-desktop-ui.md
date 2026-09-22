# Stitch Desktop UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved Stitch desktop UI across the dashboard and native shell, preserve all existing gateway workflows, and produce a verified macOS DMG.

**Architecture:** Keep the existing server-rendered dashboard entry point and API contracts, but reorganize the dashboard into a client-side view shell with a persistent sidebar and independently addressable Overview, API Keys, Connect, Requests, Diagnostics, Settings, and onboarding views. Keep the Tauri wrapper responsible for workspace/port persistence, gateway lifecycle, native settings, login invocation, and updates; the dashboard communicates with it only through the existing login message plus a narrowly scoped settings message.

**Tech Stack:** TypeScript/JavaScript, Express static dashboard, semantic HTML/CSS, Vitest, Playwright, Tauri 2/Rust, macOS `hdiutil` DMG packaging.

**Spec:** `docs/superpowers/specs/2026-09-22-stitch-desktop-ui.md`

## Global Constraints

- Preserve the warm cream background, cobalt-blue accents, deep navy text, thin warm-gray borders, rounded cards, and existing angular gateway logo.
- Preserve existing server routes, API-key security behavior, one-time secret handling, Tauri lifecycle, updater boundary, and local-only desktop networking.
- Preserve the user’s pre-existing `.gitignore` change (`brag-output*/`); do not revert or reformat unrelated files.
- Do not add a runtime dependency for the visual redesign; use the existing static dashboard stack.
- The packaged app must continue to support macOS 11.0 or newer and the existing arm64/x64 build targets.

## Review Focus

- A dashboard loaded with no keys must still render all navigation views and give an actionable Create key path; pin in the dashboard UI contract test.
- A selected key that is inactive, expired, missing credentials, or has a failed test must show the correct next action; pin in the API-key/connect rendering test.
- Request history with mixed keys/models/results must filter independently without losing duration/token columns; pin in the history filtering test.
- Health and diagnostics failures must include recovery guidance and keep the report sanitized; pin in the diagnostics behavior test.
- The embedded dashboard must not receive the Tauri bridge and its settings request must be origin/source checked; pin in the desktop message test.

### Task 1: Establish dashboard view contract with failing tests

**Files:**
- Create: `test/dashboard-ui.test.ts`
- Modify: `package.json` only if a test script alias is needed (prefer existing `npm test`)
- Read: `src/public/index.html`, `src/public/app.js`, `src/public/styles.css`

**Interfaces:**
- Consumes: Existing dashboard DOM IDs and route contracts in `src/public/app.js`.
- Produces: A stable contract for `data-view` navigation, view containers, required legacy IDs, and filter controls that later UI work must satisfy.

- [ ] **Step 1: Write the failing contract test**

  Add tests that read `src/public/index.html` and assert:

  ```ts
  expect(html).toContain('data-view="overview"');
  expect(html).toContain('data-view="api-keys"');
  expect(html).toContain('data-view="connect"');
  expect(html).toContain('data-view="requests"');
  expect(html).toContain('data-view="diagnostics"');
  expect(html).toContain('data-view="settings"');
  expect(html).toContain('id="history-key-filter"');
  expect(html).toContain('id="history-model-filter"');
  expect(html).toContain('id="history-result-filter"');
  for (const id of ['keys','create-form','setup-key','test-connection','health-check','diagnostic-check','request-history']) expect(html).toContain(`id="${id}"`);
  ```

  Add a CSS contract assertion that the stylesheet declares the Stitch shell tokens `--cream`, `--cobalt`, and `.app-sidebar`.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node node_modules/vitest/vitest.mjs run test/dashboard-ui.test.ts`

  Expected: FAIL because the current dashboard does not yet have the view shell, navigation, history filters, and Stitch tokens.

- [ ] **Step 3: Keep the contract minimal**

  Do not assert generated copy, exact pixel values, or implementation-private class names beyond the shell and required controls. This keeps the test focused on workflow coverage.

### Task 2: Implement the Stitch dashboard shell and visual system

**Files:**
- Modify: `src/public/index.html`
- Modify: `src/public/styles.css`
- Test: `test/dashboard-ui.test.ts`

**Interfaces:**
- Consumes: Task 1’s required IDs and the existing `app.js` event targets.
- Produces: A semantic sidebar shell and view containers that keep all legacy workflow controls available to the existing controller code.

- [ ] **Step 1: Add the shell markup**

  Add a `.app-shell` wrapper with a `.app-sidebar`, a `data-view` navigation list for Overview, API Keys, Connect, Requests, Diagnostics, and Settings, a compact gateway status block, and a `.app-main` region. Keep `/admin/logo.png` and existing footer credit.

- [ ] **Step 2: Group existing workflow sections into views**

  Move the current metric cards and setup checklist into `#view-overview`; the key creation, secret, key list, and key detail region into `#view-api-keys`; the current setup wizard/snippets into `#view-connect`; the history table into `#view-requests`; health/report controls into `#view-diagnostics`; and a dashboard settings summary plus a button that asks the wrapper to open native settings into `#view-settings`.

  Preserve these IDs exactly: `status`, `migration-notice`, `setup-checklist`, `health-results`, `diagnostic-report`, `diagnostic-copy`, `metric-active-keys`, `metric-total-keys`, `metric-requests`, `metric-tokens`, `metric-capacity-active`, `metric-capacity-queued`, `create-form`, `key-search`, `key-filter`, `keys`, `setup-platform`, `setup-workspace-root`, `setup-key`, `setup-model`, `setup-reasoning`, `setup-secret`, `setup-progress`, `login-codex`, `login-cancel`, `login-status`, `login-link`, `login-code`, `login-copy`, `test-connection`, `test-result`, all snippet IDs, `request-history`, and `history-status`.

- [ ] **Step 3: Add the key detail and request filter markup**

  Add `#key-detail-panel` with fields `#detail-key-name`, `#detail-key-scope`, `#detail-key-rate-limit`, `#detail-key-expiry`, `#detail-key-auth`, and `#detail-key-last-test`. Add `#history-key-filter`, `#history-model-filter`, and `#history-result-filter` above the requests table. Keep empty states visible and actionable.

- [ ] **Step 4: Add the onboarding view markers**

  Add `#view-onboarding` with four progress items, a `data-onboarding-step` attribute, and links/buttons that route to API Keys or Connect. This view is used when the dashboard has no selected key and is also the visual contract for the native first-run flow.

- [ ] **Step 5: Replace the stylesheet with the Stitch visual system**

  Define the cream/cobalt/navy tokens, 240px sidebar, responsive collapse, card hierarchy, badges, table treatment, selected-key detail panel, focus states, modal styling, and reduced-motion behavior. Keep the existing selectors used by `app.js` and the existing responsive minimum widths.

- [ ] **Step 6: Run the contract test**

  Run: `node node_modules/vitest/vitest.mjs run test/dashboard-ui.test.ts`

  Expected: PASS.

### Task 3: Add navigation, detail rendering, and history filtering

**Files:**
- Modify: `src/public/app.js`
- Test: `test/dashboard-ui.test.ts` or a focused `test/dashboard-behavior.test.ts`

**Interfaces:**
- Consumes: Task 2 view IDs and existing `setupData`, `dashboardKeys`, `healthData`, and request history response shape.
- Produces: `showView(viewName)`, `renderKeyDetail(key)`, and `renderHistoryFilters(rows)` behavior while preserving current API calls.

- [ ] **Step 1: Add a focused behavior test for pure helpers**

  Extract small pure helpers where practical and test that history filtering applies key, model, and result independently, and that the selected key detail maps workspace, rate limit, expiry, authentication, and last test fields.

- [ ] **Step 2: Implement view navigation**

  Add a `showView(viewName)` function that toggles `[data-view-panel]`, updates `aria-current`, updates the page heading/context, and stores only the current view in memory. Wire sidebar buttons and `[data-route]` action links. Default to onboarding for an empty setup, otherwise Overview.

- [ ] **Step 3: Add key selection and detail rendering**

  Make key cards set `setupKeyId`, refresh setup choices, and render the detail panel. Use existing `isExpired`, setup auth state, and last test data; display recovery actions that route to Connect or Diagnostics.

- [ ] **Step 4: Add request filters without changing the route**

  Keep the existing `/admin/history` request, populate distinct filter options from its rows, and render rows matching all selected filters. Preserve duration and token usage formatting and the existing empty/error status copy.

- [ ] **Step 5: Make diagnostics actionable**

  Render each health check with status text and a recovery action link/button: choose workspace/restart for gateway issues, sign in for credential issues, and select an active key for key issues. Keep the sanitized report endpoint and copy button unchanged.

- [ ] **Step 6: Add safe native settings handoff**

  Post `{type: "codex-desktop-open-settings"}` only from the embedded dashboard. Keep the existing login message unchanged. Non-embedded dashboard pages should show a local settings explanation instead of attempting `postMessage`.

- [ ] **Step 7: Run focused tests and syntax checks**

  Run: `node node_modules/vitest/vitest.mjs run test/dashboard-ui.test.ts test/dashboard-behavior.test.ts` and `node --check src/public/app.js`.

  Expected: PASS with no syntax errors.

### Task 4: Align the native desktop wrapper with the Stitch workflow

**Files:**
- Modify: `desktop/index.html`
- Modify: `desktop/styles.css`
- Modify: `desktop/branding.css`
- Modify: `desktop/app.js`
- Test: `test/desktop-ui.test.ts`

**Interfaces:**
- Consumes: Existing Tauri commands and `state` shape in `desktop/app.js`.
- Produces: Cream/cobalt native shell, four-step first-run progress, and origin/source-checked settings handoff.

- [ ] **Step 1: Add the failing desktop contract test**

  Assert that native markup contains the four onboarding step labels, the settings drawer, gateway status, and `iframe#dashboard`, and that `desktop/app.js` checks the dashboard message type before invoking native commands.

- [ ] **Step 2: Update onboarding markup**

  Add a visible progress rail for Workspace, Create key, Sign in, and Test connection while preserving existing workspace and port controls. Keep the advanced settings disclosure, restart hint, and data directory text.

- [ ] **Step 3: Restyle the native wrapper**

  Use the same tokens and logo treatment as the dashboard. Keep the running state compact so the iframe gets the majority of the window, preserve responsive controls, and keep the settings drawer usable at the minimum window size.

- [ ] **Step 4: Harden settings handoff**

  Extend the existing message listener to accept `codex-desktop-open-settings` only from the dashboard iframe and only when the event origin matches the running dashboard URL. Open the existing native dialog; do not forward arbitrary commands or URLs.

- [ ] **Step 5: Run the desktop contract and syntax tests**

  Run: `node node_modules/vitest/vitest.mjs run test/desktop-ui.test.ts` and `node --check desktop/app.js`.

  Expected: PASS.

### Task 5: Verify the complete workflow in browser and desktop tests

**Files:**
- Modify: `e2e/dashboard.spec.ts` only if selectors need stable `data-testid` attributes.
- Modify: `e2e/desktop.spec.ts` only if native selectors need stable attributes.
- Create/modify: `test/dashboard-behavior.test.ts` as needed by Task 3.

**Interfaces:**
- Consumes: Completed dashboard and native shell behavior from Tasks 2–4.
- Produces: Evidence for setup, key lifecycle, connect, requests, diagnostics, settings handoff, and responsive navigation.

- [ ] **Step 1: Run existing unit and release checks before browser work**

  Run: `npm test`, `npm run check`, `npm run test:release`.

- [ ] **Step 2: Run the dashboard E2E flow**

  Run: `npm run test:browser -- e2e/dashboard.spec.ts`.

  Verify the sidebar routes, API-key create/reveal/delete path, connect controls, history filters, health report generation, and diagnostics recovery copy.

- [ ] **Step 3: Run the desktop E2E flow**

  Run: `npm run test:browser -- e2e/desktop.spec.ts` when the existing harness is available; otherwise run `npm run desktop:smoke` after preparing the packaged runtime.

  Verify first-run workspace selection, start/stop/restart, native settings, dashboard iframe loading, sign-in handoff, and update controls.

- [ ] **Step 4: Run Rust desktop checks**

  Run: `npm run desktop:check`.

- [ ] **Step 5: Review the diff and preserve unrelated changes**

  Run: `git diff --check` and `git status --short`. Confirm `.gitignore` still contains the pre-existing `brag-output*/` line and no unrelated file is modified.

### Task 6: Build and verify the DMG

**Files:**
- Modify: `src-tauri/tauri.conf.json` only if the release version must be incremented for the new build.
- Modify: `packaging/README.txt` only if the existing installer copy needs a UI-specific note.
- Generated: `release/Codex CLI API_<version>_<arch>.dmg` and `release/Codex CLI API.app` (do not commit generated release artifacts unless repository policy requires them).

**Interfaces:**
- Consumes: The verified dashboard/native UI and existing Tauri packaging script.
- Produces: A verified `.dmg` with the app bundle, Applications shortcut, and unchanged creator README.

- [ ] **Step 1: Prepare the runtime**

  Run: `npm run desktop:prepare`.

  Expected: `desktop-runtime/` contains the packaged Node runtime and server assets needed by the Tauri app.

- [ ] **Step 2: Build the macOS app bundle**

  Run: `npm run desktop:build`.

  Expected: `src-tauri/target/release/bundle/macos/Codex CLI API.app` exists and has the configured identifier/version.

- [ ] **Step 3: Build the DMG**

  Run: `npm run desktop:dmg`.

  Expected: the script prints `Verified installer` and creates `release/Codex CLI API_<version>_<arch>.dmg`.

- [ ] **Step 4: Run the packaged smoke check**

  Run: `npm run desktop:smoke`.

  Expected: the packaged app starts, exposes the local dashboard, and exits cleanly after the smoke workflow.

- [ ] **Step 5: Perform final artifact verification**

  Run: `git diff --check`, `git status --short`, and inspect the DMG path with `ls -lh release/`.

  Report exact DMG path, app version, architecture, checks run, and any environment limitation without claiming a test that did not run.
