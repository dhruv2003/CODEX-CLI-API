import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platforms = ['darwin-aarch64', 'windows-x86_64'];
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function validateRelease(tag, versions, head, taggedCommit) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag || '')) throw new Error('Release tag must be stable vMAJOR.MINOR.PATCH.');
  const version = tag.slice(1);
  if (!versions.length || versions.some(value => value !== version)) throw new Error('Tag and application versions differ.');
  if (!/^[a-f0-9]{40}$/.test(head) || head !== taggedCommit) throw new Error('Checkout must equal the release tag commit.');
  return version;
}

export function assertDraft(release, tag) {
  if (release.isDraft !== true || release.tagName !== tag) throw new Error('Refusing to change a published release or mismatched tag.');
}

export function validateMacMetadata(version, identifier, bundledVersion) {
  if (identifier !== 'com.codexcliapi.desktop' || bundledVersion !== version) throw new Error('Mac archive application identity or version does not match the release.');
}

function inspectMacArchive(path, version) {
  const members = run('tar', ['-tzf', path]).split('\n');
  const plistName = members.filter(name => /^(?:\.\/)?Sidecar\.app\/Contents\/Info\.plist$/.test(name));
  if (plistName.length !== 1) throw new Error('Mac archive must contain exactly one expected app Info.plist.');
  const plist = execFileSync('tar', ['-xOzf', path, plistName[0]], { maxBuffer: 1024 * 1024 });
  // plistlib handles both XML and binary plists without shell interpolation or extraction.
  const metadata = JSON.parse(execFileSync('python3', ['-c', 'import sys, plistlib, json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { input: plist, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  validateMacMetadata(version, metadata.CFBundleIdentifier, metadata.CFBundleShortVersionString);
}

export function assetNames(version, platform) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid version.');
  if (platform === 'darwin-aarch64') return [`codex-cli-api_${version}_aarch64.dmg`, `codex-cli-api_${version}_aarch64.app.tar.gz`, `codex-cli-api_${version}_aarch64.app.tar.gz.sig`];
  if (platform === 'windows-x86_64') return [`codex-cli-api_${version}_x64-setup.exe`, `codex-cli-api_${version}_x64-setup.exe.sig`];
  throw new Error('Unsupported release platform.');
}

function base64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text.trim())) throw new Error('Invalid base64 signature or public key.');
  return Buffer.from(text.trim(), 'base64');
}

// Tauri stores base64-encoded minisign text. Verify both artifact and trusted comment.
export function verifySignature(data, signature, pubkey) {
  const keyLines = base64(pubkey).toString('utf8').trim().split(/\r?\n/);
  const lines = base64(signature).toString('utf8').trim().split(/\r?\n/);
  if (keyLines.length !== 2 || lines.length !== 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('Malformed minisign envelope.');
  const key = base64(keyLines[1]);
  const packet = base64(lines[1]);
  const global = base64(lines[3]);
  if (key.length !== 42 || packet.length !== 74 || global.length !== 64 || key.subarray(0, 2).toString() !== 'Ed' || !key.subarray(2, 10).equals(packet.subarray(2, 10))) throw new Error('Signature key does not match updater key.');
  const algorithm = packet.subarray(0, 2).toString();
  if (!['Ed', 'ED'].includes(algorithm)) throw new Error('Unsupported minisign algorithm.');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const signedData = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const sig = packet.subarray(10);
  if (!verify(null, signedData, publicKey, sig) || !verify(null, Buffer.concat([sig, Buffer.from(lines[2].slice('trusted comment: '.length))]), publicKey, global)) throw new Error('Updater signature verification failed.');
}

export function combinedMetadata({ tag, version, commit, repo, files, pubkey }) {
  validateRelease(tag, [version], commit, commit);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid GitHub repository.');
  const latest = { version, notes: `Sidecar ${version}`, platforms: {} };
  const required = [];
  for (const platform of platforms) {
    const names = assetNames(version, platform);
    const provenanceName = `${platform}.provenance.json`;
    for (const name of [...names, provenanceName]) if (!files.has(name)) throw new Error(`Missing release asset: ${name}`);
    const provenance = JSON.parse(files.get(provenanceName));
    if (provenance.schemaVersion !== 1 || provenance.version !== version || provenance.commit !== commit || provenance.platform !== platform || !Array.isArray(provenance.artifacts) || provenance.artifacts.length !== names.length) throw new Error(`Mismatched ${platform} provenance.`);
    for (const name of names) {
      const entries = provenance.artifacts.filter(entry => entry.name === name);
      if (entries.length !== 1 || entries[0].sha256 !== sha256(files.get(name))) throw new Error(`Provenance checksum mismatch: ${name}`);
    }
    const signatureName = names.find(name => name.endsWith('.sig'));
    const artifactName = signatureName.slice(0, -4);
    const signature = files.get(signatureName).toString('utf8').trim();
    verifySignature(files.get(artifactName), signature, pubkey);
    latest.platforms[platform] = { signature, url: `https://github.com/${repo}/releases/download/${tag}/${artifactName}` };
    required.push(...names, provenanceName);
  }
  files.set('latest.json', Buffer.from(json(latest)));
  const checksums = [...required, 'latest.json'].sort().map(name => `${sha256(files.get(name))}  ${name}\n`).join('');
  return { latest, checksums };
}

async function localRelease(tag) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const cargo = await readFile(join(root, 'src-tauri/Cargo.toml'), 'utf8');
  // Validate the tag before passing it to git, even though execFile never uses a shell.
  validateRelease(tag, [pkg.version, config.version, cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]], '0'.repeat(40), '0'.repeat(40));
  const commit = run('git', ['rev-parse', 'HEAD']);
  const version = validateRelease(tag, [pkg.version, config.version], commit, run('git', ['rev-parse', `${tag}^{commit}`]));
  if (run('git', ['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Release staging requires a clean checkout. Commit release changes and build from the tag first.');
  const committedConfig = JSON.parse(run('git', ['show', `${tag}:src-tauri/tauri.conf.json`]));
  if (committedConfig.plugins?.updater?.pubkey !== config.plugins?.updater?.pubkey) throw new Error('Updater key differs from the committed release configuration.');
  return { version, commit, pubkey: committedConfig.plugins.updater.pubkey };
}

function options(argv) {
  const [command, ...args] = argv;
  if (!['validate', 'stage', 'finalize'].includes(command)) throw new Error('Usage: release-assets.mjs validate|stage|finalize --tag vX.Y.Z [--repo owner/repo] [--platform PLATFORM --artifact FILE ...]');
  const result = { command, artifacts: [] };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!['--tag', '--repo', '--platform', '--artifact'].includes(key) || !value || value.startsWith('--')) throw new Error('Unknown option or missing option value.');
    if (key === '--artifact') result.artifacts.push(value);
    else if (result[key.slice(2)]) throw new Error(`Duplicate option: ${key}`);
    else result[key.slice(2)] = value;
  }
  if (command !== 'stage' && (result.platform || result.artifacts.length)) throw new Error('Artifact options are only valid with stage.');
  return result;
}

async function stageFiles(opts, release, temp) {
  const names = assetNames(release.version, opts.platform);
  if (opts.artifacts.length !== names.length) throw new Error('Supply the complete platform artifact set, including updater signature.');
  const files = new Map();
  for (const input of opts.artifacts) {
    const path = resolve(input);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error('Artifact must be a nonempty regular file, never a symlink.');
    const actual = await realpath(path);
    const allowed = ['release', 'src-tauri/target'].some(folder => {
      const part = relative(join(root, folder), actual);
      return part && part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep);
    });
    if (!allowed) throw new Error('Artifacts must reside in this checkout under release/ or src-tauri/target/.');
    const filename = basename(path);
    const suffix = ['.app.tar.gz.sig', '.app.tar.gz', '.exe.sig', '.exe', '.dmg'].find(ext => filename.endsWith(ext));
    const name = names.find(candidate => candidate.endsWith(suffix || '\0'));
    if (!name || files.has(name)) throw new Error('Unexpected or duplicate artifact type.');
    if ((suffix === '.exe' || suffix === '.dmg') && !filename.includes(`_${release.version}_`)) throw new Error('Installer filename must include the release version.');
    const data = await readFile(path);
    if (suffix === '.exe' && data.subarray(0, 2).toString() !== 'MZ') throw new Error('Invalid Windows executable.');
    if (suffix === '.app.tar.gz' && data.subarray(0, 2).toString('hex') !== '1f8b') throw new Error('Invalid compressed app archive.');
    if (suffix === '.app.tar.gz') inspectMacArchive(path, release.version);
    if (suffix === '.dmg' && data.subarray(-512, -508).toString() !== 'koly') throw new Error('Invalid DMG container.');
    files.set(name, data);
  }
  if (names.some(name => !files.has(name))) throw new Error('Incomplete platform artifact set.');
  const sig = names.find(name => name.endsWith('.sig'));
  verifySignature(files.get(sig.slice(0, -4)), files.get(sig).toString('utf8').trim(), release.pubkey);
  files.set(`${opts.platform}.provenance.json`, Buffer.from(json({ schemaVersion: 1, version: release.version, commit: release.commit, platform: opts.platform,
    artifacts: names.map(name => ({ name, sha256: sha256(files.get(name)) })) })));
  for (const [name, data] of files) await writeFile(join(temp, name), data, { flag: 'wx' });
  return [...files.keys()];
}

async function main(argv) {
  const opts = options(argv);
  const release = await localRelease(opts.tag);
  if (opts.command === 'validate') return console.log(`Validated ${opts.tag} at ${release.commit}.`);
  const repo = opts.repo || run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid GitHub repository.');
  const remoteCommit = run('gh', ['api', `repos/${repo}/commits/${opts.tag}`, '--jq', '.sha']);
  validateRelease(opts.tag, [release.version], release.commit, remoteCommit);
  const draft = () => {
    const value = JSON.parse(run('gh', ['release', 'view', opts.tag, '--repo', repo, '--json', 'isDraft,tagName,assets']));
    assertDraft(value, opts.tag);
    return value;
  };
  draft();
  const temp = await mkdtemp(join(tmpdir(), 'codex-release-assets-'));
  try {
    let upload;
    if (opts.command === 'stage') {
      upload = await stageFiles(opts, release, temp);
    } else {
      const names = platforms.flatMap(platform => [...assetNames(release.version, platform), `${platform}.provenance.json`]);
      const remote = draft();
      for (const name of names) {
        if (remote.assets.filter(asset => asset.name === name).length !== 1) throw new Error(`Missing or duplicate draft asset: ${name}`);
        run('gh', ['release', 'download', opts.tag, '--repo', repo, '--pattern', name, '--dir', temp]);
      }
      const files = new Map(await Promise.all(names.map(async name => [name, await readFile(join(temp, name))])));
      const metadata = combinedMetadata({ ...release, tag: opts.tag, repo, files });
      await writeFile(join(temp, 'latest.json'), json(metadata.latest));
      await writeFile(join(temp, 'SHA256SUMS'), metadata.checksums);
      upload = ['latest.json', 'SHA256SUMS'];
    }
    const current = draft();
    if (current.assets.some(asset => upload.includes(asset.name))) throw new Error('Assets already exist. Review and remove stale draft assets explicitly before retrying; overwrites are refused.');
    run('gh', ['release', 'upload', opts.tag, '--repo', repo, ...upload.map(name => join(temp, name))]);
    draft();
    console.log(`Uploaded ${upload.join(', ')} to draft ${opts.tag}. Publication is a separate manual step.`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
