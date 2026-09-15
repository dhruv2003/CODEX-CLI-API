import { access, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'
import { CodexSessionManager } from '../src/codex.js'
import { createApp } from '../src/server.js'

describe('local key admin', () => {
  it('serves the UI and manages key activation without exposing stored secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-admin-'))
    const keyFile = join(root, 'keys.json')
    const keys = new ApiKeyStore(keyFile)
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile,
      models: ['gpt-5.6-sol'],
      imageModels: [],
      modelEfforts: { 'gpt-5.6-sol': ['low', 'medium', 'high'] },
    }
    const sessions = new CodexSessionManager(config)
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const baseUrl = `http://127.0.0.1:${address.port}`

      const page = await fetch(baseUrl)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
      const pageSource = await page.text()
      expect(pageSource).toContain('id="metric-total-keys"')
      expect(pageSource).toContain('id="key-rpm"')
      expect(pageSource).toContain('id="key-workspace-root"')
      expect(pageSource).toContain('type="datetime-local"')
      expect(pageSource).toContain('id="setup-platform"')
      expect(pageSource).toContain('id="setup-workspace-root"')
      expect(pageSource).toContain('id="vscode-example"')
      expect(pageSource).toContain('id="tunnel-example"')
      const appSource = await (await fetch(`${baseUrl}/admin/app.js`)).text()
      expect(appSource).toContain('Promise.all([api(), requestJson("/admin/metrics")])')
      expect(appSource).toContain('unavailableMetrics')
      expect(appSource).toContain('aria-label')
      expect(appSource).toContain('method: "DELETE"')
      expect(appSource).toContain('confirm(')
      expect(appSource).toContain('workspaceRoot')
      expect(appSource).toContain('renderSetup')
      expect(appSource).toContain('setup-platform')
      expect(appSource).not.toContain('innerHTML')

      const forbidden = await fetch(`${baseUrl}/admin/api-keys`)
      expect(forbidden.status).toBe(403)

      const headers = { 'Content-Type': 'application/json', 'X-Codex-Admin': 'local' }
      const adminConfig = await fetch(`${baseUrl}/admin/config`, { headers })
      expect(await adminConfig.json()).toEqual({ codexStateRoot: config.codexStateRoot, workspaceRoot: config.workspaceRoot, defaultModel: 'gpt-5.6-sol' })
      const project = join(root, 'project')
      await mkdir(project)
      const canonicalProject = await realpath(project)
      const missingWorkspace = await fetch(`${baseUrl}/admin/api-keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Missing workspace' }),
      })
      expect(missingWorkspace.status).toBe(400)
      const rejectedWorkspace = await fetch(`${baseUrl}/admin/api-keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Outside', workspaceRoot: tmpdir() }),
      })
      expect(rejectedWorkspace.status).toBe(400)
      const createdResponse = await fetch(`${baseUrl}/admin/api-keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Desktop client', workspaceRoot: project }),
      })
      expect(createdResponse.status).toBe(201)
      const created = await createdResponse.json() as { id: string; key: string; active: boolean; createdAt: string }
      expect(created).toMatchObject({ id: expect.stringMatching(/^key_/), key: expect.stringMatching(/^dsh_live_/), active: true, workspaceRoot: canonicalProject })
      expect(created.createdAt).toEqual(expect.any(String))

      const listResponse = await fetch(`${baseUrl}/admin/api-keys`, { headers })
      expect(listResponse.status).toBe(200)
      const listed = await listResponse.json() as { data: Array<Record<string, unknown>> }
      expect(listed.data).toEqual([{
        id: created.id,
        name: 'Desktop client',
        createdAt: created.createdAt,
        active: true,
        expiresAt: null,
        requestsPerMinute: 60,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        failureCount: 0,
        lastUsedAt: null,
        workspaceRoot: canonicalProject,
      }])
      expect(JSON.stringify(listed)).not.toContain(created.key)
      expect(JSON.stringify(listed)).not.toContain('hash')

      await keys.create('Expired key', { expiresAt: '2020-01-01T00:00:00.000Z' })

      const metricsResponse = await fetch(`${baseUrl}/admin/metrics`, { headers })
      expect(metricsResponse.status).toBe(200)
      expect(await metricsResponse.json()).toMatchObject({
        capacity: { active: 0, queued: 0 },
        keys: { total: 2, active: 1, requestCount: 0, inputTokens: 0, outputTokens: 0, failureCount: 0 },
      })

      const activeDelete = await fetch(`${baseUrl}/admin/api-keys/${created.id}`, { method: 'DELETE', headers })
      expect(activeDelete.status).toBe(409)
      expect(sessions.isKeyRetired(created.id)).toBe(false)

      const disabledResponse = await fetch(`${baseUrl}/admin/api-keys/${created.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ active: false }),
      })
      expect(disabledResponse.status).toBe(200)
      expect(await disabledResponse.json()).toMatchObject({ id: created.id, active: false })

      const keyState = join(config.codexStateRoot, created.id)
      await mkdir(keyState, { recursive: true })
      await writeFile(join(keyState, 'auth.json'), '{}')
      const deletedResponse = await fetch(`${baseUrl}/admin/api-keys/${created.id}`, { method: 'DELETE', headers })
      expect(deletedResponse.status).toBe(204)
      await expect(access(keyState)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await (await fetch(`${baseUrl}/admin/api-keys`, { headers })).json() as { data: unknown[] }).data).toHaveLength(1)

      const missingDelete = await fetch(`${baseUrl}/admin/api-keys/key_0000000000000000`, { method: 'DELETE', headers })
      expect(missingDelete.status).toBe(404)
      const repeatedDelete = await fetch(`${baseUrl}/admin/api-keys/${created.id}`, { method: 'DELETE', headers })
      expect(repeatedDelete.status).toBe(404)
      expect(sessions.isKeyRetired(created.id)).toBe(true)

      const rejected = await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${created.key}` } })
      expect(rejected.status).toBe(401)
    } finally {
      await close(server)
    }
  })
})

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
}
