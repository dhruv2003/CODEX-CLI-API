import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Build on the target OS/architecture; never copy a Homebrew/system Node binary
// (it may depend on libraries absent on the recipient's machine).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.desktop-cache');
const output = join(root, 'desktop-runtime');
const nodeVersion = '22.23.2';
const targets = {
  'darwin-arm64': ['aarch64-apple-darwin', '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6'],
  'darwin-x64': ['x86_64-apple-darwin', '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026'],
  'linux-arm64': ['aarch64-unknown-linux-musl', '013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30'],
  'linux-x64': ['x86_64-unknown-linux-musl', 'b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3'],
  'win32-x64': ['x86_64-pc-windows-msvc', '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'],
};
const target = `${process.platform}-${process.arch}`;
if (!targets[target]) throw new Error(`Unsupported desktop target ${target}`);
const [triple, checksum] = targets[target];
const exe = process.platform === 'win32' ? '.exe' : '';
const nodeFolder = `node-v${nodeVersion}-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const archiveName = `${nodeFolder}.${exe ? 'zip' : 'tar.gz'}`;
await mkdir(cache, { recursive: true });

async function download(url, destination, expectedHash) {
  let bytes;
  try { bytes = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash)) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error(`Checksum mismatch: ${url}`);
    await writeFile(destination, bytes);
  }
  return bytes;
}

const archive = join(cache, archiveName);
await download(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, archive, checksum);
const staging = await mkdtemp(join(cache, 'stage-'));
try {
  // Both macOS and supported Windows versions ship tar with zip support.
  execFileSync('tar', ['-xf', archive, '-C', staging], { stdio: 'inherit' });
  const runtime = join(staging, 'runtime');
  await mkdir(join(runtime, 'licenses'), { recursive: true });
  await copyFile(join(staging, nodeFolder, exe ? 'node.exe' : 'bin/node'), join(runtime, `node${exe}`));
  if (!exe) await chmod(join(runtime, 'node'), 0o755);
  await copyFile(join(staging, nodeFolder, 'LICENSE'), join(runtime, 'licenses', 'Node-LICENSE.txt'));

  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve(`@openai/codex-${target}/package.json`));
  const codexPackage = JSON.parse(await readFile(require.resolve('@openai/codex/package.json'), 'utf8'));
  await cp(join(packageDir, 'vendor', triple), join(runtime, 'codex'), { recursive: true });
  await stat(join(runtime, 'codex', 'bin', `codex${exe}`));
  // Ship upstream notices with redistributable binaries; never package ~/.codex.
  for (const name of ['LICENSE', 'NOTICE']) {
    const dest = join(cache, `codex-${codexPackage.version}-${name}.txt`);
    await download(`https://raw.githubusercontent.com/openai/codex/rust-v${codexPackage.version}/${name}`, dest);
    await copyFile(dest, join(runtime, 'licenses', `Codex-${name}.txt`));
  }
  await cp(join(root, 'src', 'public'), join(runtime, 'public'), { recursive: true });
  const bundle = await build({ entryPoints: [join(root, 'src', 'desktop.ts')], outfile: join(runtime, 'gateway.mjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: true, sourcemap: false, metafile: true,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    legalComments: 'eof',
  });
  const packages = new Set();
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const parts = input.replaceAll('\\', '/').split('/node_modules/').pop().replace(/^node_modules\//, '').split('/');
    if (!input.includes('node_modules/')) continue;
    packages.add(parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  for (const name of packages) {
    const directory = join(root, 'node_modules', name);
    for (const license of (await readdir(directory)).filter(file => /^(license|copying|notice)(\.|$)/i.test(file))) {
      if ((await stat(join(directory, license))).isFile()) await copyFile(join(directory, license), join(runtime, 'licenses', `${name.replaceAll('/', '-')}-${license}`));
    }
  }
  const appPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ target, node: nodeVersion, codex: codexPackage.version, gateway: appPackage.version }, null, 2));
  // Only replace our generated, explicitly scoped output. No user data lives here.
  await rm(output, { recursive: true, force: true });
  await rename(runtime, output);
  console.log(`Desktop runtime ready: ${output} (${target}). No .env or personal credentials included.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
