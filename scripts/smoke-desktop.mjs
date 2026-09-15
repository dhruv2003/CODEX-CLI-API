import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.argv[2] ? resolve(process.argv[2]) : join(root, 'desktop-runtime');
const exe = process.platform === 'win32' ? '.exe' : '';
const temporary = await mkdtemp(join(tmpdir(), 'codex-desktop-smoke-'));
const workspace = join(temporary, "User's projects");
await mkdir(workspace);
const reserved = createServer();
await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
const port = reserved.address().port;
await new Promise(resolve => reserved.close(resolve));
const token = randomBytes(32).toString('hex');
const headers = { 'X-Codex-Admin': 'local', 'X-Codex-Desktop-Token': token, 'Content-Type': 'application/json' };
const base = `http://127.0.0.1:${port}`;
let child;
let exited;
let logs = '';
async function start() {
  child = spawn(join(runtime, `node${exe}`), [join(runtime, 'gateway.mjs'), '--desktop'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', CODEX_DESKTOP_LEGACY_WORKSPACE_ROOT: '', CODEX_DESKTOP_DATA_DIR: join(temporary, 'app-data'),
      CODEX_DESKTOP_WORKSPACE_ROOT: workspace, CODEX_DESKTOP_PORT: String(port), CODEX_DESKTOP_TOKEN: token,
      CODEX_DESKTOP_CODEX_COMMAND: join(runtime, 'codex', 'bin', `codex${exe}`), CODEX_DESKTOP_PUBLIC_DIR: join(runtime, 'public'),
    },
  });
  exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  const lines = createInterface({ input: child.stdout });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Gateway not ready: ${logs}`)), 10_000);
    const cleanup = () => { clearTimeout(timeout); lines.close(); };
    lines.on('line', line => {
      try { if (JSON.parse(line).event === 'desktop_ready') { cleanup(); resolve(); } } catch { /* request logs */ }
    });
    exited.then(code => { cleanup(); reject(new Error(`Gateway exited ${code}: ${logs}`)); }, reject);
  });
}
async function stop() {
  child.stdin.end('shutdown\n');
  let timeout;
  try { assert.equal(await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Gateway did not stop')), 10_000); })]), 0); }
  finally { clearTimeout(timeout); }
  child = undefined;
}
try {
  assert.match(execFileSync(join(runtime, 'codex', 'bin', `codex${exe}`), ['--version'], { encoding: 'utf8' }), /codex/i);
  await start();
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/admin/config`, { headers: { 'X-Codex-Admin': 'local' } })).status, 403);
  assert.equal((await fetch(`${base}/admin/config`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  const config = await (await fetch(`${base}/admin/config`, { headers })).json();
  assert.equal(config.workspaceRoot, workspace);
  const created = await fetch(`${base}/admin/api-keys`, { method: 'POST', headers, body: JSON.stringify({ name: 'Packaged smoke', workspaceRoot: workspace, requestsPerMinute: 60 }) });
  assert.equal(created.status, 201);
  const credential = await created.json();
  assert.ok(credential.key);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${credential.key}` } })).status, 200);
  assert.ok(!(await readFile(join(temporary, 'app-data', 'api-keys.json'), 'utf8')).includes(credential.key));
  await stop();
  await start();
  assert.equal((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${credential.key}` } })).status, 200);
  await stop();
  assert.ok(!logs.includes(token));
  assert.ok(!logs.includes(credential.key));
  console.log('Packaged smoke passed: bundled Codex/Node, protected admin, key creation, API auth, persistence, shutdown and restart. No paid generation invoked.');
} finally {
  if (child) { child.kill(); await exited.catch(() => {}); }
  await rm(temporary, { recursive: true, force: true });
}
