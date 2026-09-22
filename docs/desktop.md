# Desktop app (Tauri)

The desktop build reuses the web dashboard and TypeScript gateway. Rust handles the window, folder picker, saved settings, single-instance protection, and the gateway process. No Electron. Recipients do not install Node, npm, Rust, or create a `.env` file.

## Recipient setup

1. Install the build for your OS and CPU. Open **Codex CLI API**.
2. Choose an existing workspace folder. The app rejects folders that overlap its private application-data directory.
3. Click **Save & start gateway**. Create a project-scoped API key in the embedded dashboard.
4. Click **Login to Codex**, copy the displayed device code, and open the sign-in page. Sign in with your own eligible account; the app does not include the developer's account.
5. Run the dashboard connection test, then use the key in your personal app. For a browser frontend, add its origin (for example `http://127.0.0.1:5500`) in the key's **Browser origins** field during creation or under **Edit policy**. **Connect** provides a JavaScript example and the existing VS Code configuration. The default API base is `http://127.0.0.1:3081/v1`; the chat-completions URL adds `/chat/completions`.

VS Code on the same computer needs no tunnel. Changing the app's port requires updating the client endpoint. Stopping/restarting the gateway interrupts active requests. Closing/quitting the app stops the gateway; it is not an always-on background service.

The Settings button edits workspace and port. Once keys exist, their workspace is locked to prevent silently granting them access to a different folder; the port can still change. Authentication and API-key data survive restarts and app updates, outside the installed application. Replacing the app is not a data reset.

## Application data (not .env)

Tauri's platform app-data directory for `com.codexcliapi.desktop` contains:

- `settings.json`: workspace folder and port only.
- `api-keys.json`: hashed API keys and metadata, including each key's browser origins, never the recoverable API secret.
- `codex-users/`: isolated per-key Codex authentication/session state. Treat this directory as sensitive.

Typical locations are `~/Library/Application Support/com.codexcliapi.desktop` on macOS, `%APPDATA%\com.codexcliapi.desktop` on Windows, and `$XDG_DATA_HOME/com.codexcliapi.desktop` (usually `~/.local/share/...`) on Linux. The actual path is displayed under Advanced settings. Unix private directories use mode 700 and key files mode 600; Windows uses the current user's application-data location and inherited ACLs.

Desktop startup deliberately ignores developer `.env` settings. It bundles its own Codex binary and pins portable Node 22.23.2 (archives checked against committed SHA-256 values). It never copies your existing `.env`, keys, or Codex login. Updates to runtime pins need review, checksum updates, and fresh platform tests.

## Build from the private repository

Build **on the target OS and CPU**. This is one codebase, not one universal executable. Cross-compilation is deliberately unsupported by the runtime preparation script; a macOS universal app is not currently produced.

Install Node 22+, a current stable Rust toolchain, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). macOS requires Xcode Command Line Tools. Windows requires Microsoft's C++ build tools and WebView2 (the installer can provision WebView2). Linux requires the documented WebKitGTK/system packages; Linux binaries are not portable to every distribution.

```sh
npm ci
npm run desktop:prepare
npm run check
npm test
npm run test:browser
npm run desktop:check
npm run desktop:smoke
npm run desktop:dev
```

Rust must be on PATH. After a fresh macOS Rust installation, open a new terminal or run `source "$HOME/.cargo/env"`.

macOS (Apple Silicon build on an Apple Silicon host; Intel build on an Intel host):

```sh
npm run desktop:dmg
```

Windows PowerShell (build on the matching Windows architecture):

```powershell
npm ci
npm run desktop:build -- --bundles nsis
```

Linux:

```sh
npm ci
npm run desktop:build -- --bundles deb,appimage
```

The macOS command creates `release/Codex CLI API.app` and `release/Codex CLI API_0.1.0_arm64.dmg` (or `_x64.dmg` on Intel). Opening the DMG shows the app, an Applications shortcut, and `README.txt` with Dhruv's creator details and https://thisisdhruv.in. The build script mounts the image read-only to verify these contents. Other Tauri artifacts appear in `src-tauri/target/release/bundle/`. Keep installers, not the entire repository or `node_modules`. The preparation script packages an explicit allowlist: gateway bundle, dashboard assets, portable Node, Codex vendor tree, and dependency licenses. `desktop-runtime/`, `.desktop-cache/`, build output, and release artifacts are ignored by Git.

## Release checklist

- Test first-run folder selection, key creation, login with a test account, inference, restart, and uninstall/reinstall on each supported OS/CPU.
- Test port conflicts, lost network, expired authentication, shutdown during inference, and workspaces containing spaces/non-ASCII characters.
- Sign all embedded executables plus the app, then notarize the macOS build with your Apple Developer credentials. Use a Windows signing certificate for public Windows distribution. An unsigned/ad-hoc development build is **not** a notarized public release. See [Tauri signing and distribution](https://v2.tauri.app/distribute/).
- Include bundled licenses/notices and review any additional third-party runtime notice requirements before public release. This app is independent software, not an official OpenAI product.
- Keep this repository private if you do not want to publish source. Bundled/minified JavaScript can still be inspected or reverse-engineered; Tauri is not source encryption. Truly private logic must remain on a server or be rewritten as native code (also not immune to reverse engineering).
- Automatic updates use signed artifacts hosted on GitHub Releases. The manual GitHub Actions workflow builds macOS Apple Silicon and Windows x64; local builds remain supported. Review both platforms before publishing. See [the release guide](releasing.md) for signing, draft uploads, and the combined update manifest. Until a compatible manifest is published, update checks cannot offer a release.

## Bringing an existing local setup into the app

Select the old project folder containing its `.env`. On startup, migration reads only that file's original workspace/key/state paths, copies missing keys and available Codex homes into private desktop storage, and adjusts relative workspace paths without changing which folders each key can access. Originals remain untouched. Existing desktop records are preserved; matching IDs with different secrets or scopes are rejected. A locked, atomic merge creates a private backup before updating an existing store, and existing credential folders are never overwritten. Repeated launches do not duplicate imported keys. The dashboard displays the import result. A folder without usable migration configuration starts a fresh setup or explains what is missing; the app never guesses a key's old workspace. Close the old server before importing. API secrets cannot be recovered from hashes, so continue using the previously saved secrets in VS Code.

## Security boundary

A durable completed-import record ensures deleting an imported key does not restore it from the old installation on restart. Interrupted imports fail closed with a recovery message; do not delete import markers to retry unless you have reviewed the saved keys and credential directories.

The gateway listens only on loopback. API requests require issued API keys. Desktop administration additionally requires a random per-launch capability token, never placed in query strings or logs. The embedded dashboard carries this token in its URL fragment and request headers; Codex subprocesses do not inherit it. Foreign Host values remain rejected. Cross-origin browser API requests require an origin allowed by the authenticated key; administration routes continue to reject foreign origins. Empty browser-origin policies preserve same-origin and server/CLI clients.

Only the bundled launcher has native IPC permissions. The dashboard iframe cannot launch arbitrary programs. Its one message bridge opens a fixed Codex device-login URL after checking the sender window and origin. Runtime process cleanup is owned by the native shell, including a process-tree fallback.

Public tunnels are not enabled by the desktop app. Do not expose this entire listener through a tunnel: desktop Host/Origin checks intentionally reject forwarded public origins. Use the separately documented API-only deployment if a remote client needs public access.

## Disk usage and cleanup

The first Rust build creates a sizeable developer-only cache; it is not included in installers. `cargo clean --manifest-path src-tauri/Cargo.toml` removes build outputs **including installers under target**, so copy any installer you want to keep to `release/` first. `.desktop-cache/` holds reproducible downloads; `desktop-runtime/` is generated and can be rebuilt with `npm run desktop:prepare`. Never remove the application-data directory to free build-cache space: that contains the user's keys and login.
