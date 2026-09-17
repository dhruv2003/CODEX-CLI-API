import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'
import { createApp } from '../src/server.js'

it('rejects removed export and import routes without changing stored keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'removed-admin-routes-'))
  const keyFile = join(root, 'keys.json')
  const keys = new ApiKeyStore(keyFile)
  const key = await keys.create('Retained key', { workspaceRoot: '.', requestsPerMinute: 12 })
  const before = await readFile(keyFile, 'utf8')
  const config = { port: 0, host: '127.0.0.1', codexCommand: 'codex', codexStateRoot: root, workspaceRoot: root, keyFile, models: ['test'], imageModels: [], modelEfforts: {} }
  const server = createServer(createApp({ config, keys }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    for (const route of ['backup', 'restore/preview', 'restore']) {
      const response = await fetch(`${base}/admin/${route}`, { method: 'POST', headers: { 'X-Codex-Admin': 'local', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a long fixture password' }) })
      expect(response.status).toBe(404)
    }
    expect(await readFile(keyFile, 'utf8')).toBe(before)
    expect(await keys.verify(key.key)).toBe(true)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
