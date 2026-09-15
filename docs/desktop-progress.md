# Tauri desktop progress

## v0.1.1 deletion fix and installation

- [x] Replace unsupported browser confirm with an accessible in-page confirmation dialog.
- [x] Regression test Confirm, Cancel and Escape using disposable keys; preserve other keys and remove only selected key state.
- [x] Build and verify v0.1.1 DMG, including README.txt.
- [x] Install at `/Applications/Codex CLI API.app`; packaged-runtime smoke passed and installed dashboard opened.
- [x] Remove v0.1.0 installer, duplicate release app, Rust build output and generated runtime/downloads. User application data untouched by installation/cleanup.

Current installer: `release/Codex CLI API_0.1.1_arm64.dmg`. The installed app is in Applications; rebuilding regenerates the direct release app. Earlier checks below describe v0.1.0.

Branch: `feat/tauri-desktop`. No Electron; existing TypeScript gateway and dashboard reused.

- [x] Create development branch without changing unrelated projects.
- [x] Native first-run settings UI; no user-managed .env.
- [x] Bundle portable Node and Codex; exclude personal credentials.
- [x] Protect desktop administration with a per-launch token.
- [x] Packaged gateway smoke: start, key creation, API auth, persistence, stop/restart.
- [x] Desktop launcher browser tests (mocked native bridge).
- [x] Native Rust compilation and workspace/settings validation test.
- [x] Actual desktop window verification: settings, dashboard, restart and stop.
- [x] macOS app/DMG; Windows build instructions.
- [x] Fix duplicate branding and add Dhruv creator credit/website.
- [x] Generate and integrate gateway logo and native app icons.
- [x] Implement safe one-time import/merge of previous keys and logins (11 tests).
- [x] Verify imported existing setup in final packaged app: 2 legacy + 1 desktop = 3 active keys; hashes and available auth files preserved.
- [x] Verify README.txt in final DMG by mounting it read-only.
- [x] Final regression checks and scoped build-cache cleanup.

Final checks: 102 backend tests, 6 browser tests, 2 native tests passed. Exact release app runtime passed startup/auth/key creation/persistence/stop/restart smoke test. Native window verified branding, saved workspace, dashboard, restart/stop, and imported keys. Live provider sign-in/inference remains user account testing; no paid generation was invoked.

Deliverables: `release/Codex CLI API.app` and `release/Codex CLI API_0.1.0_arm64.dmg` (Apple Silicon development build; not notarized). README at DMG root contains Dhruv and https://thisisdhruv.in. Rebuild: `npm ci` then `npm run desktop:dmg` with Node/Rust/Xcode prerequisites installed.

Cleanup: removed Rust target artifacts (1.5 GiB earlier plus 1.9 GiB final), generated runtime (~403 MB), temporary downloads (~48 MB), and unused mobile icons. Release artifacts, build tools/dependencies, source, user settings, original keys and copied sign-ins retained. Next build regenerates artifacts and has a cold Rust build cache.

Release limitations: Windows/Linux require their own host builds and tests. Public macOS distribution requires signing/notarization credentials. A bundled JavaScript backend is not strong source-code concealment.
