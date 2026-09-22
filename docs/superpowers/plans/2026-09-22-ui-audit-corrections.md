# Stitch audit corrections and dark theme

User authorized all audit corrections, requested parallel implementation where useful, and requested only a final DMG. Do not update the installed application.

Reference: Stitch project 3608752727796523352, all 10 screens inspected during the audit. Retain the original app logo; reference imagery and sample activity are illustrative only.

## Scope

- One light sidebar, compact page header, consistent footer/status and independent content scrolling.
- Native Settings inline in the content region, preserving the privileged native boundary and sidebar navigation.
- Four actual onboarding stages: workspace, scoped key, sign-in, explicit connection test. Persist non-secret UI choices only.
- Key creation drawer, accessible selection and clear empty/expiry states.
- Two-column Connect, recent requests/health Overview, searchable/refreshable Requests with metadata details and CSV export.
- Structured local diagnostics, recent runs, truthful recovery actions and verification states.
- Sidebar light/dark controls, persistent theme applied to native setup, Settings and dashboard.

## Parallel ownership

- Main: dashboard markup/styles, integration, visual review, packaging.
- Native worker: desktop shell, inline native Settings, first run, native tests.
- Behavior worker: dashboard controller, onboarding/state, requests/diagnostics/theme behavior.
- Test worker: dashboard/embedded browser regression coverage and screenshots.

## Verification and delivery

Run syntax/type checks, relevant browser workflow and security regressions, unit/release tests. Review light/dark screenshots at desktop and compact sizes, including native Settings using browser fixture shell. Build Tauri app and verified macOS DMG. Remove only generated redundant app bundles and stale installer artifacts after successful packaging. Keep one final installer in release; leave /Applications unchanged. Distinguish fixture testing from live provider authentication/inference.

## Verified delivery: 0.1.3 (2026-09-22)

- JavaScript syntax and TypeScript checks passed.
- 107 unit tests, 34 browser tests, 5 native tests, and 13 release checks passed.
- Light/dark desktop and compact screenshots reviewed, including inline native Settings, onboarding, and populated request details.
- Review regressions cover Gateway default reset, Settings restoration, current-health readiness, and fast gateway restart iframe replacement.
- Exact packaged runtime smoke passed: protected admin, key creation, API authentication, persistence, shutdown, restart; no paid generation.
- Tauri app built, locally ad-hoc signed with `codesign --force --sign -`, and verified with `codesign --verify --deep --strict`. This is not an Apple-notarized release.
- DMG created and mounted read-only; app, Applications shortcut, and creator README verified. Dashboard source matches bundled assets.
- Final installer: `release/Codex CLI API_0.1.3_arm64.dmg` (173618138 bytes).
- SHA-256: `c4b11d0d9698d541c8cca64319704ce43385936f0cf4c4ff4104936e5a3371c8`.
- Removed generated loose app bundles and the superseded 0.1.2 installer after verification. No installation or changes to user app data; user performs final native/provider acceptance testing.

## Sign-in feedback follow-up: 0.1.4

- Completed sign-in uses a disabled, neutral-grey "Signed in" button in light and dark themes. A separate "Sign in again" action preserves account switching and recovery.
- Pending sign-in remains disabled with "Signing in…"; changing keys or removing credentials restores the appropriate actionable state.
- Regression reproduced the original enabled-button defect before implementation. Final checks: 35 browser tests, 107 unit tests, 13 release checks, syntax/type checks, and exact bundled-runtime smoke passed.
- Installer remains a local ad-hoc-signed development build, not Apple-notarized. No automatic installation or user-account changes.
- Verified DMG: `release/Codex CLI API_0.1.4_arm64.dmg`; SHA-256 `f6584ac32cf0cb6955fc1839aa2e66a1949eaf5aa74dfdbeb151cd46ea65615d`. Removed superseded generated 0.1.3 installer and loose build app copies; latest app is retained inside the DMG.
