import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractionCommand, extractRuntime } from './extract-runtime.mjs';

test('Windows extraction bypasses Git Bash tar and preserves drive paths with spaces', () => {
  const command = extractionCommand('D:\\a\\App Name\\node.zip', 'D:\\a\\App Name\\stage', 'win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(command.file, 'C:\\Windows\\System32\\tar.exe');
  assert.deepEqual(command.args, ['-xf', 'D:\\a\\App Name\\node.zip', '-C', 'D:\\a\\App Name\\stage']);
  assert.throws(() => extractionCommand('node.zip', 'stage', 'win32', {}), /SystemRoot/);
  assert.throws(() => extractionCommand('node.zip', 'stage', 'win32', { SystemRoot: 'relative' }), /SystemRoot/);
});

test('runtime extraction unpacks a real archive to a directory containing spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-extract-'));
  try {
    const source = join(root, 'source');
    const destination = join(root, 'target with spaces');
    await mkdir(source); await mkdir(destination);
    await writeFile(join(source, 'LICENSE'), 'fixture license');
    const archive = join(root, 'runtime.tar.gz');
    const tar = extractionCommand(archive, destination).file;
    execFileSync(tar, ['-czf', archive, '-C', source, 'LICENSE']);
    extractRuntime(archive, destination);
    assert.equal(await readFile(join(destination, 'LICENSE'), 'utf8'), 'fixture license');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime extraction supports the ZIP format shipped by Node for Windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-zip-'));
  try {
    const archive = join(root, 'node runtime.zip');
    const destination = join(root, 'stage with spaces');
    await mkdir(destination);
    // Stored ZIP containing LICENSE with the text "fixture license".
    await writeFile(archive, Buffer.from('UEsDBBQAAAAAALR4MV0z0WgKDwAAAA8AAAAHAAAATElDRU5TRWZpeHR1cmUgbGljZW5zZVBLAQIUAxQAAAAAALR4MV0z0WgKDwAAAA8AAAAHAAAAAAAAAAAAAACAAQAAAABMSUNFTlNFUEsFBgAAAAABAAEANQAAADQAAAAAAA==', 'base64'));
    extractRuntime(archive, destination);
    assert.equal(await readFile(join(destination, 'LICENSE'), 'utf8'), 'fixture license');
  } finally { await rm(root, { recursive: true, force: true }); }
});
