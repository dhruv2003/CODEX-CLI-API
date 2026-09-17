import { mkdtemp, mkdir, writeFile, rmdir } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'
import { createApp } from '../src/server.js'
import { AdmissionController } from '../src/admission.js'
import { RequestLifecycle } from '../src/lifecycle.js'

it('guards health, diagnostics and update draining while keeping diagnostic contents private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-tools-'))
  const keys = new ApiKeyStore(join(root, 'keys.json'))
  const key = await keys.create('SECRET-NAME', { workspaceRoot: root })
  await mkdir(join(root, 'state', key.id), { recursive: true })
  await writeFile(join(root, 'state', key.id, 'auth.json'), JSON.stringify({ tokens: { id_token: `x.${Buffer.from(JSON.stringify({ email: 'test@example.com' })).toString('base64url')}.x`, access_token: 'SECRET-TOKEN' } }))
  const config = { port: 0, host: '127.0.0.1', codexCommand: 'codex', codexStateRoot: join(root, 'state'), workspaceRoot: root, keyFile: join(root, 'keys.json'), models: ['test'], imageModels: [], modelEfforts: {}, desktopAdminToken: 'TEST-CAPABILITY' }
  const admission = new AdmissionController({ maxConcurrent: 2, maxConcurrentPerKey: 1, maxQueue: 4 })
  const lifecycle = new RequestLifecycle()
  const server = createServer(createApp({ config, keys, admission, lifecycle }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const headers = { 'X-Codex-Admin': 'local', 'X-Codex-Desktop-Token': 'TEST-CAPABILITY', 'Content-Type': 'application/json' }
  try {
    for (const path of ['health', 'diagnostics', 'prepare-update']) expect((await fetch(`${base}/admin/${path}`, { method: path === 'health' || path === 'diagnostics' ? 'GET' : 'POST' })).status).toBe(403)
    const healthResponse = await fetch(`${base}/admin/health`, { headers })
    expect(healthResponse.status).toBe(200)
    const health = await healthResponse.json()
    expect(health).toMatchObject({ gateway: { ready: true }, keys: [{ id: key.id, workspaceAccessible: true, authStatus: 'credentials_found', ready: false, account: { email: 'test@example.com', verified: false } }] })
    const diagnostics = await (await fetch(`${base}/admin/diagnostics`, { headers })).text()
    for (const secret of [root, key.key, key.id, 'SECRET', 'test@example.com']) expect(diagnostics).not.toContain(secret)
    await mkdir(`${config.keyFile}.lock`)
    let closed!: Promise<void>
    const parsed = new Promise<void>(resolve => server.once('request', (request, response) => {
      closed = new Promise<void>(resolve => response.once('close', resolve))
      request.once('end', resolve)
    }))
    const controller = new AbortController()
    const updating = fetch(`${base}/admin/api-keys/${key.id}`, { method: 'PATCH', headers, body: JSON.stringify({ requestsPerMinute: 30 }), signal: controller.signal }).catch(() => {})
    await parsed
    controller.abort()
    await closed
    try { expect((await fetch(`${base}/admin/prepare-update`, { method: 'POST', headers, body: '{}' })).status).toBe(409) }
    finally { await rmdir(`${config.keyFile}.lock`); await updating; await fetch(`${base}/admin/cancel-update`, { method: 'POST', headers, body: '{}' }) }
    // Wait for the real store mutation to finish after the disconnected request.
    await expect.poll(() => lifecycle.pendingCount).toBe(0)
    const received = new Promise<void>(resolve => server.once('request', () => resolve()))
    const pending = httpRequest(`${base}/admin/api-keys`, { method: 'POST', headers: { ...headers, 'Content-Length': '100' } })
    pending.on('error', () => {})
    pending.write('{')
    await received
    expect((await fetch(`${base}/admin/prepare-update`, { method: 'POST', headers, body: '{}' })).status).toBe(409)
    pending.end(' '.repeat(99))
    await new Promise<void>(resolve => pending.once('response', response => { response.resume(); response.once('end', resolve) }))
    const lease = await admission.acquire(key.id, 60, new AbortController().signal)
    expect((await fetch(`${base}/admin/prepare-update`, { method: 'POST', headers, body: '{}' })).status).toBe(409)
    lease.release()
    expect((await fetch(`${base}/admin/prepare-update`, { method: 'POST', headers, body: '{}' })).status).toBe(200)
    expect((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` } })).status).toBe(503)
    expect((await fetch(`${base}/admin/cancel-update`, { method: 'POST', headers, body: '{}' })).status).toBe(200)
    expect((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` } })).status).toBe(200)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
