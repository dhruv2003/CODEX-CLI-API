import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A headless DMG builder: no Finder automation or AppleScript permissions needed.
if (process.platform !== 'darwin') throw new Error('DMG packaging must run on macOS.');
if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`Unsupported architecture: ${process.arch}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(config.version)) throw new Error('Unsafe application version.');
const release = join(root, 'release');
const cache = join(root, '.desktop-cache');
const appName = 'Codex CLI API.app';
const builtApp = join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', appName);
const finalApp = join(release, appName);
const dmg = join(release, `Codex CLI API_${config.version}_${process.arch}.dmg`);
const env = { ...process.env, PATH: [join(homedir(), '.cargo', 'bin'), process.env.PATH || ''].join(delimiter) };
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
}
async function existing(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
for (const folder of [release, cache]) {
  const info = await existing(folder);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Refusing unsafe build directory: ${folder}`);
  await mkdir(folder, { recursive: true });
}
const previousDmg = await existing(dmg);
if (previousDmg && (!previousDmg.isFile() || previousDmg.isSymbolicLink())) throw new Error(`Refusing unsafe image output: ${dmg}`);

run(process.execPath, [join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build', '--bundles', 'app']);
if (!(await lstat(builtApp)).isDirectory()) throw new Error(`App bundle not found: ${builtApp}`);
const previousApp = await existing(finalApp);
if (previousApp) {
  if (!previousApp.isDirectory() || previousApp.isSymbolicLink()) throw new Error(`Refusing unsafe app output: ${finalApp}`);
  const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(finalApp, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (identifier !== config.identifier) throw new Error('The existing release app belongs to another application; refusing to replace it.');
  await rm(finalApp, { recursive: true });
}
// ditto preserves the app bundle's modes, resources, and signing metadata.
run('/usr/bin/ditto', [builtApp, finalApp]);
const stage = await mkdtemp(join(cache, 'dmg-stage-'));
const mount = await mkdtemp(join(cache, 'dmg-check-'));
let attached = false;
try {
  run('/usr/bin/ditto', [finalApp, join(stage, appName)]);
  await copyFile(join(root, 'packaging', 'README.txt'), join(stage, 'README.txt'));
  await symlink('/Applications', join(stage, 'Applications'));
  run('/usr/bin/hdiutil', ['create', '-volname', 'Codex CLI API', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
  run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount]);
  attached = true;
  if (!(await lstat(join(mount, appName))).isDirectory()) throw new Error('DMG verification failed: app missing.');
  if (!(await lstat(join(mount, 'Applications'))).isSymbolicLink()) throw new Error('DMG verification failed: Applications shortcut missing.');
  const readme = await readFile(join(mount, 'README.txt'), 'utf8');
  if (!readme.includes('Dhruv') || !readme.includes('https://thisisdhruv.in')) throw new Error('DMG verification failed: creator information missing.');
  if (readme !== await readFile(join(root, 'packaging', 'README.txt'), 'utf8')) throw new Error('DMG verification failed: README differs.');
  console.log(`Verified installer: ${dmg}\nDirect app: ${finalApp}`);
} finally {
  if (attached) run('/usr/bin/hdiutil', ['detach', mount]);
  // These are unique temporary directories created by this invocation only.
  await rm(stage, { recursive: true, force: true });
  await rm(mount, { recursive: true, force: true });
}
