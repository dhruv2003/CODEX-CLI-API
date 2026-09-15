import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'
import { CodexSessionManager } from '../src/codex.js'
import { createApp } from '../src/server.js'

it('protects setup, detects credentials, runs a read-only test and records only metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'onboarding-'))
  const config = { port: 0, host: '127.0.0.1', codexCommand: 'codex', codexStateRoot: join(root, 'state'), workspaceRoot: root, keyFile: join(root, 'keys.json'), models: ['test-model'], imageModels: [], modelEfforts: { 'test-model': ['low'] } }
  const keys = new ApiKeyStore(config.keyFile)
  const key = await keys.create('test')
  const sessions = new CodexSessionManager(config)
  let fail = false
  sessions.run = async function* (_session, request) {
    expect(request.sandbox).toBe('read-only')
    expect(request.reasoningEffort).toBe('low')
    if (fail) throw new Error('secret-provider-detail')
    yield { type: 'message', text: 'secret-model-output' }
    yield { type: 'usage', inputTokens: 5, outputTokens: 2 }
  }
  const server = createServer(createApp({ config, keys, sessions }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no listener')
  const url = `http://127.0.0.1:${address.port}`
  const headers = { 'X-Codex-Admin': 'local', 'Content-Type': 'application/json' }
  const test = () => fetch(`${url}/admin/api-keys/${key.id}/test`, { method: 'POST', headers, body: JSON.stringify({ model: 'test-model', reasoningEffort: 'low' }) })
  try {
    for (const path of ['/admin/setup', '/admin/requests', `/admin/api-keys/${key.id}/login`]) expect((await fetch(url + path)).status).toBe(403)
    for (const method of ['POST', 'DELETE']) expect((await fetch(`${url}/admin/api-keys/${key.id}/login`, { method })).status).toBe(403)
    expect(await (await fetch(`${url}/admin/api-keys/${key.id}/login`, { headers })).json()).toMatchObject({ status: 'idle' })
    expect((await test()).status).toBe(409)
    expect((await (await fetch(`${url}/admin/setup`, { headers })).json()).keys[0]).toMatchObject({ authStatus: 'missing', ready: false })
    await mkdir(join(config.codexStateRoot, key.id), { recursive: true })
    await writeFile(join(config.codexStateRoot, key.id, 'auth.json'), '{}')
    expect(await (await test()).json()).toMatchObject({ ok: true, code: 'ready' })
    expect((await (await fetch(`${url}/admin/setup`, { headers })).json()).keys[0]).toMatchObject({ authStatus: 'credentials_found', ready: true })
    fail = true
    const failure = await test()
    expect(failure.status).toBe(502)
    expect(await failure.text()).not.toContain('secret-provider-detail')
    const history = await (await fetch(`${url}/admin/requests`, { headers })).json()
    expect(history.data[0]).toMatchObject({ status: 'failed', httpStatus: 502 })
    expect(history.data[1]).toMatchObject({ keyId: key.id, status: 'success', inputTokens: 5, outputTokens: 2 })
    expect(JSON.stringify(history)).not.toContain('secret-')
    expect(JSON.stringify(history)).not.toContain(key.key)
    await keys.setActive(key.id, false)
    expect((await test()).status).toBe(409)
    expect((await fetch(`${url}/admin/api-keys/${key.id}/login`, { headers, method: 'POST' })).status).toBe(409)
    await keys.update(key.id, { active: true, requestsPerMinute: 1 })
    expect((await test()).status).toBe(429)
    const invalidModel = await fetch(`${url}/admin/api-keys/${key.id}/test`, { method: 'POST', headers, body: JSON.stringify({ model: 'secret-unconfigured-model' }) })
    expect(invalidModel.status).toBe(400)
    expect(await (await fetch(`${url}/admin/requests`, { headers })).text()).not.toContain('secret-unconfigured-model')
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
