# Desktop releases on GitHub

GitHub Actions builds macOS Apple Silicon and Windows x64 from the same version tag. GitHub Releases hosts installers, updater signatures, checksums and the combined update feed. Everything is staged in a **draft** by default. Explicitly enabling the workflow's `publish` input publishes only after both builds and signed-asset validation pass; reviewed notes must exist at `docs/releases/TAG.md`. No separate artifact server is needed.

## One-time setup

1. Review and merge the workflow and release scripts into the default branch. GitHub exposes manual workflows after they exist there.
2. In repository **Settings → Secrets and variables → Actions**, add `TAURI_SIGNING_PRIVATE_KEY` containing the existing updater private key, not its path. Add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if encrypted; an unset password is treated as empty. Never commit either value.
3. Keep `src-tauri/updater-public-key.txt` and `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` synchronized. Existing installations trust this identity; do not generate a new key per release. Keep a secure copy of the private key outside this repository.
4. The committed updater endpoint is `https://github.com/dhruv2003/CODEX-CLI-API/releases/latest/download/latest.json`.

Standard hosted Windows and macOS runner compute is free while this repository is public. Temporary Actions artifacts expire after three days; storage has separate allowances. Release assets remain until explicitly removed. See [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Prepare one immutable version

Update versions in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, the root package entry in `src-tauri/Cargo.lock`, and any visible desktop version label. Run checks, commit, then create and push a new tag. Never move/reuse an existing release tag.

For example, after preparing version **0.2.2**:

```sh
npm ci
npm run check
npm test
npm run test:release
npm run test:browser
git tag v0.2.2
git push origin v0.2.2
```

The helper requires a clean tagged checkout and matching source versions. Both builders use the exact tagged commit.

## Run the hosted builds

Open **Actions**, select the desktop installer workflow, then **Run workflow**. Select the reviewed default-branch workflow, enter `v0.2.2`, and choose:

- `artifacts`: build test installers, without creating a release or requiring updater signing credentials.
- `signed-draft`: build updater-signed artifacts, stage both platforms in one draft release, and assemble its combined update manifest and checksums.

Leave `publish` disabled for manual review. Enable it only when publication is already approved; it applies to `signed-draft` and uses the committed release notes. Installer links should be separate from the OTA support-file explanation, which must say users do not need to download those supporting files manually.

Or use the GitHub CLI:

```sh
gh workflow run desktop-release.yml --ref main -f tag=v0.2.2 -f mode=signed-draft
gh run list --workflow desktop-release.yml
```

The workflow runs TypeScript/backend/release/native checks before packaging. Windows uses NSIS (`.exe`). macOS produces a `.dmg` with the app, an Applications shortcut and `README.txt` with Dhruv's creator details; its `.app.tar.gz` is the automatic-update artifact. The staging job requires both builds to succeed. Compilation is not an interactive installer test—test on both operating systems before publication.

## Optional local Mac build

Local builds remain supported. From the same clean tagged checkout, with Node, Rust, Xcode Command Line Tools and `gh` installed:

```sh
node scripts/release-assets.mjs validate --tag v0.2.2
export TAURI_SIGNING_PRIVATE_KEY='/absolute/path/to/existing/updater.key'
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''
npm run desktop:build -- --bundles app --config '{"bundle":{"createUpdaterArtifacts":true}}'
npm run desktop:dmg -- --skip-build
unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Use the real password if encrypted. Do not reuse a stale archive because its filename looks correct. For manual recovery, an existing empty draft can receive platform assets via:

```sh
node scripts/release-assets.mjs stage --tag v0.2.2 --platform darwin-aarch64 \
  --artifact 'release/Codex CLI API_0.2.2_arm64.dmg' \
  --artifact 'src-tauri/target/release/bundle/macos/Codex CLI API.app.tar.gz' \
  --artifact 'src-tauri/target/release/bundle/macos/Codex CLI API.app.tar.gz.sig'
```

Staging validates updater signatures against the committed public key and records artifact hashes plus the selected commit. This provenance records what was staged; it is not independent proof that an arbitrary pre-existing binary was built from that source. Always rebuild from the tag.

After both platforms are staged, manual finalization is:

```sh
node scripts/release-assets.mjs finalize --tag v0.2.2
```

Finalization requires both `darwin-aarch64` and `windows-x86_64`, matching provenance/hashes and valid updater signatures. It uploads `latest.json` and `SHA256SUMS`. Published releases and asset overwrites are refused. For an interrupted draft, inspect and explicitly remove stale draft assets before retrying; never modify a published release. Do not run release operations concurrently.

## Test, then publish manually

Test both installers: launch, workspace choice, key creation, Codex login, an API request, stop/restart, settings persistence, and upgrade from the previous installed version. Confirm existing keys and account state survive. Test signed updater installation separately; a draft is not downloadable by anonymous updater clients.

Review release notes, both installers, updater signatures, provenance files, `SHA256SUMS`, and both platforms in `latest.json`. Publish the reviewed draft in GitHub Releases and mark it latest. Verify the public manifest and both artifact URLs resolve. Fix published problems with a new version/tag, not replacement files.

**Signing distinction:** updater signatures authenticate updates but are not Apple Developer ID signing/notarization or Windows Authenticode. No Apple/Windows signing credentials are configured by this workflow. macOS Gatekeeper/Windows SmartScreen warnings remain possible. Do not describe builds as notarized or Windows-trusted. See [Tauri updater](https://v2.tauri.app/plugin/updater/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/) and [Windows signing](https://v2.tauri.app/distribute/sign/windows/).

## Verification boundary

Local checks do not establish successful hosted builds, Windows installation, Apple notarization, or an installed cross-version update. Track those separately before wider distribution. App-level backup/restore has been removed; normal updates still retain private app data.
