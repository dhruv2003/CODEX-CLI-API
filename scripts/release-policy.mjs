import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseConfig(mode, env, committed = {}) {
  if (mode === 'artifacts') return { bundle: { createUpdaterArtifacts: false } };
  if (mode !== 'signed-draft') throw new Error('Unknown release mode.');
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error('Signed release requires TAURI_SIGNING_PRIVATE_KEY.');
  const updater = committed.plugins?.updater;
  if (!updater?.pubkey?.trim()) throw new Error('Committed updater pubkey is required.');
  if (!Array.isArray(updater.endpoints) || !updater.endpoints.length) throw new Error('Committed updater endpoint is required.');
  for (const value of updater.endpoints) {
    let endpoint;
    try { endpoint = new URL(value); } catch { throw new Error('Updater endpoint must be an HTTPS URL.'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Updater endpoint must be an HTTPS URL without credentials.');
  }
  return { bundle: { createUpdaterArtifacts: true } };
}

export function verifyAppMetadata(expected, identifier, version) {
  if (identifier !== expected.identifier) throw new Error('Prebuilt app identifier does not match this application.');
  if (version !== expected.version) throw new Error('Prebuilt app version does not match the release configuration.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const committed = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  const config = releaseConfig(process.env.RELEASE_MODE || 'artifacts', process.env, committed);
  await mkdir('.desktop-cache', { recursive: true });
  await writeFile('.desktop-cache/release.conf.json', `${JSON.stringify(config, null, 2)}\n`);
  console.log('Release configuration validated; public configuration written to .desktop-cache/release.conf.json.');
}
