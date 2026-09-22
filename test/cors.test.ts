import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'
import { CodexSessionManager } from '../src/codex.js'
import { createApp } from '../src/server.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanups.splice(0).map(close => close())) })

async function fixture(desktop = false) {
  const root = await mkdtemp(join(tmpdir(), 'codex-cors-'))
  const keyFile = join(root, 'keys.json')
  const keys = new ApiKeyStore(keyFile)
  const config = { port: 0, host: '127.0.0.1', codexCommand: 'codex', codexStateRoot: join(root, 'state'), workspaceRoot: root, keyFile,
    models: ['gpt-5.4'], imageModels: [], modelEfforts: {}, ...(desktop ? { desktopAdminToken: 'a'.repeat(64) } : {}) }
  const sessions = new CodexSessionManager(config)
  const server = createServer(createApp({ config, keys, sessions }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return { keys, sessions, root, keyFile, url: `http://127.0.0.1:${address.port}`, desktopToken: config.desktopAdminToken }
}

describe('per-key browser origins', () => {
  it.each([false, true])('permits allowed browser calls and isolates other keys (desktop=%s)', async desktop => {
    const { keys, sessions, url } = await fixture(desktop)
    const allowed = await keys.create('allowed', { allowedOrigins: ['https://app.example'] })
    const other = await keys.create('other', { allowedOrigins: ['https://other.example'] })
    const headers = { Authorization: `Bearer ${allowed.key}`, Origin: 'https://app.example', 'Content-Type': 'application/json' }
    const models = await fetch(`${url}/v1/models`, { headers })
    expect(models.status).toBe(200)
    expect(models.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(models.headers.get('vary')).toContain('Origin')
    expect(models.headers.get('access-control-allow-credentials')).toBeNull()
    const session = await fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: '{}' })
    expect(session.status).toBe(201)
    const create = vi.spyOn(sessions, 'create')
    for (const deniedHeaders of [{ ...headers, Authorization: `Bearer ${other.key}` }, { ...headers, Origin: 'https://evil.example' }]) {
      const denied = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: deniedHeaders, body: '{}' })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    }
    expect(create).not.toHaveBeenCalled()
    expect((await keys.list()).map(key => key.requestCount)).toEqual([0, 0])
    const invalid = await fetch(`${url}/v1/models`, { headers: { ...headers, Authorization: 'Bearer invalid' } })
    expect(invalid.status).toBe(401)
    expect(invalid.headers.get('access-control-allow-origin')).toBeNull()
    const error = await fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: '{' })
    expect(error.status).toBe(400)
    expect(error.headers.get('access-control-allow-origin')).toBe('https://app.example')
  })

  it('preserves legacy no-Origin and same-origin clients while rejecting foreign origins', async () => {
    const { keys, keyFile, url } = await fixture()
    const created = await keys.create('legacy')
    const stored = JSON.parse(await readFile(keyFile, 'utf8'))
    delete stored[0].allowedOrigins
    await writeFile(keyFile, JSON.stringify(stored))
    for (const origin of [undefined, url]) {
      const response = await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${created.key}`, ...(origin ? { Origin: origin } : {}) } })
      expect(response.status).toBe(200)
    }
    for (const origin of ['https://app.example', 'null', '*', 'https://app.example/path', 'https://app.example https://evil.example']) {
      expect((await fetch(`${url}/v1/models`, { headers: { Authorization: `Bearer ${created.key}`, Origin: origin } })).status).toBe(403)
    }
  })

  it.each([false, true])('handles bounded unauthenticated preflight only for the API (desktop=%s)', async desktop => {
    const { url, desktopToken } = await fixture(desktop)
    const headers = { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' }
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'OPTIONS', headers })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    for (const invalid of [{ Origin: 'null' }, { 'Access-Control-Request-Method': 'TRACE' }, { 'Access-Control-Request-Headers': 'x-codex-admin' }]) {
      const denied = await fetch(`${url}/v1/models`, { method: 'OPTIONS', headers: { ...headers, ...invalid } })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    }
    const admin = await fetch(`${url}/admin/api-keys`, { method: 'OPTIONS', headers })
    expect(admin.status).toBe(403)
    expect(admin.headers.get('access-control-allow-origin')).toBeNull()
    const adminRead = await fetch(`${url}/admin/api-keys`, { headers: { Origin: headers.Origin, 'X-Codex-Admin': 'local', ...(desktopToken ? { 'X-Codex-Desktop-Token': desktopToken } : {}) } })
    expect(adminRead.status).toBe(403)
    expect(adminRead.headers.get('access-control-allow-origin')).toBeNull()
    if (desktop) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(`${url}/v1/models`, { method: 'OPTIONS', headers: { ...headers, Host: 'evil.example' } }, response => {
          response.resume()
          resolve(response.statusCode)
        })
        request.on('error', reject)
        request.end()
      })
      expect(status).toBe(403)
    }
  })

  it('creates and updates normalized policy through admin without clearing omitted origins', async () => {
    const { root, url } = await fixture()
    const headers = { 'Content-Type': 'application/json', 'X-Codex-Admin': 'local' }
    const createdResponse = await fetch(`${url}/admin/api-keys`, { method: 'POST', headers, body: JSON.stringify({ name: 'web', workspaceRoot: root, allowedOrigins: ['https://app.example:443/'] }) })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string; allowedOrigins: string[] }
    expect(created.allowedOrigins).toEqual(['https://app.example'])
    const preserved = await fetch(`${url}/admin/api-keys/${created.id}`, { method: 'PATCH', headers, body: JSON.stringify({ requestsPerMinute: 20 }) })
    expect(await preserved.json()).toMatchObject({ allowedOrigins: ['https://app.example'] })
    for (const allowedOrigins of ['https://app.example', null, ['*'], ['https://app.example/path']]) {
      const rejected = await fetch(`${url}/admin/api-keys/${created.id}`, { method: 'PATCH', headers, body: JSON.stringify({ allowedOrigins }) })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ error: { param: 'allowedOrigins' } })
    }
    const cleared = await fetch(`${url}/admin/api-keys/${created.id}`, { method: 'PATCH', headers, body: JSON.stringify({ allowedOrigins: [] }) })
    expect(await cleared.json()).toMatchObject({ allowedOrigins: [] })
  })
})
