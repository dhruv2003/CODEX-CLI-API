import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { validateRelease, assertDraft, assetNames, verifySignature, combinedMetadata, validateMacMetadata } from './release-assets.mjs';

const commit = 'a'.repeat(40);
test('stale Mac archives and other apps are rejected using embedded metadata', () => {
  assert.doesNotThrow(() => validateMacMetadata('0.2.1', 'com.codexcliapi.desktop', '0.2.1'));
  assert.throws(() => validateMacMetadata('0.2.1', 'com.codexcliapi.desktop', '0.2.0'));
  assert.throws(() => validateMacMetadata('0.2.1', 'com.other.desktop', '0.2.1'));
});
test('release validation rejects malformed tags and mismatched versions or commits', () => {
  assert.equal(validateRelease('v0.2.1', ['0.2.1', '0.2.1'], commit, commit), '0.2.1');
  for (const tag of ['0.2.1', 'v01.2.1', 'v0.2.1/evil', 'v0.2.1-rc1'])
    assert.throws(() => validateRelease(tag, ['0.2.1'], commit, commit));
  assert.throws(() => validateRelease('v0.2.1', ['0.2.0'], commit, commit));
  assert.throws(() => validateRelease('v0.2.1', ['0.2.1'], commit, 'b'.repeat(40)));
});
test('published releases and tag confusion are refused', () => {
  assert.doesNotThrow(() => assertDraft({ isDraft: true, tagName: 'v0.2.1' }, 'v0.2.1'));
  assert.throws(() => assertDraft({ isDraft: false, tagName: 'v0.2.1' }, 'v0.2.1'));
  assert.throws(() => assertDraft({ isDraft: true, tagName: 'v0.2.0' }, 'v0.2.1'));
});

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.alloc(8, 7);
  const key = Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]);
  const pubkey = Buffer.from(`untrusted comment: test\n${key.toString('base64')}\n`).toString('base64');
  const data = Buffer.from('signed installer');
  const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey);
  const packet = Buffer.concat([Buffer.from('ED'), keyId, sig]);
  const comment = 'timestamp:123';
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey);
  const signature = Buffer.from(`untrusted comment: test\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
  return { data, signature, pubkey };
}
test('updater signatures authenticate artifact bytes and committed public key', () => {
  const f = fixture();
  assert.doesNotThrow(() => verifySignature(f.data, f.signature, f.pubkey));
  assert.throws(() => verifySignature(Buffer.from('tampered'), f.signature, f.pubkey));
  assert.throws(() => verifySignature(f.data, f.signature, fixture().pubkey));
  assert.throws(() => verifySignature(f.data, 'placeholder', f.pubkey));
  const commentTampered = Buffer.from(Buffer.from(f.signature, 'base64').toString().replace('timestamp:123', 'timestamp:456')).toString('base64');
  assert.throws(() => verifySignature(f.data, commentTampered, f.pubkey));
});
test('combined manifest requires both complete platforms with matching provenance and hashes', () => {
  const f = fixture();
  const files = new Map();
  for (const platform of ['darwin-aarch64', 'windows-x86_64']) {
    const names = assetNames('0.2.1', platform);
    for (const name of names) files.set(name, name.endsWith('.sig') ? Buffer.from(f.signature) : f.data);
    files.set(`${platform}.provenance.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, version: '0.2.1', commit, platform,
      artifacts: names.map(name => ({ name, sha256: createHash('sha256').update(files.get(name)).digest('hex') })) })));
  }
  const result = combinedMetadata({ tag: 'v0.2.1', version: '0.2.1', commit, repo: 'owner/repo', files, pubkey: f.pubkey });
  assert.equal(result.latest.platforms['windows-x86_64'].url, 'https://github.com/owner/repo/releases/download/v0.2.1/codex-cli-api_0.2.1_x64-setup.exe');
  assert.equal(result.latest.platforms['darwin-aarch64'].signature, f.signature);
  assert.match(result.checksums, /codex-cli-api_0.2.1_aarch64.dmg/);
  const stale = new Map(files);
  stale.set('darwin-aarch64.provenance.json', Buffer.from(JSON.stringify({ schemaVersion: 1, version: '0.2.0', commit, platform: 'darwin-aarch64', artifacts: [] })));
  assert.throws(() => combinedMetadata({ tag: 'v0.2.1', version: '0.2.1', commit, repo: 'owner/repo', files: stale, pubkey: f.pubkey }), /provenance/);
  const missing = new Map(files);
  missing.delete('codex-cli-api_0.2.1_x64-setup.exe.sig');
  assert.throws(() => combinedMetadata({ tag: 'v0.2.1', version: '0.2.1', commit, repo: 'owner/repo', files: missing, pubkey: f.pubkey }), /Missing release asset/);
  const tampered = new Map(files);
  tampered.set('codex-cli-api_0.2.1_aarch64.dmg', Buffer.from('replaced image'));
  assert.throws(() => combinedMetadata({ tag: 'v0.2.1', version: '0.2.1', commit, repo: 'owner/repo', files: tampered, pubkey: f.pubkey }), /checksum mismatch/);
});
