import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseConfig, verifyAppMetadata } from './release-policy.mjs';

const credentials = {
  TAURI_SIGNING_PRIVATE_KEY: 'private-test-fixture',
};
const committed = { plugins: { updater: { pubkey: 'public-test-fixture', endpoints: ['https://github.com/example/app/releases/latest/download/latest.json'] } } };

test('artifact builds need no signing credentials and disable updater artifacts', () => {
  assert.deepEqual(releaseConfig('artifacts', {}), { bundle: { createUpdaterArtifacts: false } });
});
test('signed release fails closed for every missing required credential', () => {
  for (const name of Object.keys(credentials)) {
    const env = { ...credentials, [name]: '' };
    assert.throws(() => releaseConfig('signed-draft', env, committed), new RegExp(name));
  }
});
test('signed release emits only public updater configuration', () => {
  const config = releaseConfig('signed-draft', credentials, committed);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config, { bundle: { createUpdaterArtifacts: true } });
  assert.ok(!JSON.stringify(config).includes(credentials.TAURI_SIGNING_PRIVATE_KEY));
});
test('release rejects unknown modes and missing or insecure committed updater configuration', () => {
  assert.throws(() => releaseConfig('publish', credentials), /mode/);
  assert.throws(() => releaseConfig('signed-draft', credentials, {}), /pubkey/);
  assert.throws(() => releaseConfig('signed-draft', credentials, { plugins: { updater: { pubkey: 'key', endpoints: [] } } }), /endpoint/);
  for (const endpoint of ['http://example.com/latest.json', 'https://user:password@example.com/latest.json', 'invalid']) {
    assert.throws(() => releaseConfig('signed-draft', credentials, { plugins: { updater: { pubkey: 'key', endpoints: [endpoint] } } }), /HTTPS/);
  }
});
test('packaging refuses stale or unrelated prebuilt apps', () => {
  const expected = { identifier: 'com.example.app', version: '0.2.0' };
  assert.doesNotThrow(() => verifyAppMetadata(expected, 'com.example.app', '0.2.0'));
  assert.throws(() => verifyAppMetadata(expected, 'other.app', '0.2.0'), /identifier/);
  assert.throws(() => verifyAppMetadata(expected, 'com.example.app', '0.1.0'), /version/);
});
