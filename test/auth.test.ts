import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'

describe('ApiKeyStore', () => {
  it('creates, lists, and verifies active keys without persisting the raw secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))

    const created = await store.create('test key')

    expect(created.key).toMatch(/^dsh_live_[A-Za-z0-9_-]+$/)
    expect(await store.verify(created.key)).toBe(true)
    expect(await store.identify(created.key)).toEqual({ id: created.id, name: 'test key', requestsPerMinute: 60 })
    expect(await store.verify(`${created.key}x`)).toBe(false)
    const persisted = await readFile(join(directory, 'keys.json'), 'utf8')
    expect(persisted).not.toContain(created.key)
    expect(JSON.parse(persisted)).toMatchObject([{ active: true, expiresAt: null, requestsPerMinute: 60, requestCount: 0, inputTokens: 0, outputTokens: 0, failureCount: 0, lastUsedAt: null }])
    expect(await store.list()).toEqual([{ id: created.id, name: 'test key', createdAt: expect.any(String), active: true, expiresAt: null, requestsPerMinute: 60, requestCount: 0, inputTokens: 0, outputTokens: 0, failureCount: 0, lastUsedAt: null }])
  })

  it('binds a key to its workspace root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-workspace-'))
    const workspaceRoot = join(directory, 'project')
    const store = new ApiKeyStore(join(directory, 'keys.json'))

    const created = await store.create('project key', { workspaceRoot })

    expect(created.workspaceRoot).toBe(workspaceRoot)
    expect(await store.identify(created.key)).toMatchObject({ id: created.id, workspaceRoot })
    expect(await store.list()).toMatchObject([{ id: created.id, workspaceRoot }])
  })

  it('rejects a deactivated key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))
    const created = await store.create('test key')

    expect(await store.setActive(created.id, false)).toMatchObject({ id: created.id, name: 'test key', createdAt: expect.any(String), active: false })
    expect(await store.verify(created.key)).toBe(false)
    expect(await store.identify(created.key)).toBeUndefined()
  })

  it('accepts a reactivated key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))
    const created = await store.create('test key')

    await store.setActive(created.id, false)
    expect(await store.setActive(created.id, true)).toMatchObject({ id: created.id, name: 'test key', createdAt: expect.any(String), active: true })
    expect(await store.verify(created.key)).toBe(true)
  })

  it('permanently deletes only inactive keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))
    const created = await store.create('old key')

    expect(await store.deleteInactive(created.id)).toBe('active')
    expect(await store.verify(created.key)).toBe(true)
    await store.setActive(created.id, false)
    expect(await store.deleteInactive(created.id)).toBe('deleted')
    expect(await store.deleteInactive(created.id)).toBe('not_found')
    expect(await store.verify(created.key)).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('keeps an inactive key discoverable when state cleanup fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))
    const created = await store.create('old key')
    await store.setActive(created.id, false)

    await expect(store.deleteInactive(created.id, async () => { throw new Error('disk busy') })).rejects.toThrow('disk busy')

    expect(await store.list()).toMatchObject([{ id: created.id, active: false }])
  })

  it('treats legacy keys without active as active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const keyFile = join(directory, 'keys.json')
    const store = new ApiKeyStore(keyFile)
    const created = await store.create('test key')
    const keys = JSON.parse(await readFile(keyFile, 'utf8')) as Array<Record<string, unknown>>
    delete keys[0].active
    await writeFile(keyFile, `${JSON.stringify(keys)}\n`)

    expect(await store.list()).toEqual([{ id: created.id, name: 'test key', createdAt: expect.any(String), active: true, expiresAt: null, requestsPerMinute: 60, requestCount: 0, inputTokens: 0, outputTokens: 0, failureCount: 0, lastUsedAt: null }])
    expect(await store.verify(created.key)).toBe(true)
  })

  it('returns undefined when updating an unknown key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))

    expect(await store.setActive('key_missing', false)).toBeUndefined()
  })

  it('does not lose concurrent key creations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))

    await Promise.all(Array.from({ length: 12 }, (_, index) => store.create(`key ${index}`)))

    expect(await store.list()).toHaveLength(12)
  })

  it('uses safe policy and usage defaults for legacy keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const keyFile = join(directory, 'keys.json')
    const store = new ApiKeyStore(keyFile)
    const created = await store.create('test key')
    const keys = JSON.parse(await readFile(keyFile, 'utf8')) as Array<Record<string, unknown>>
    delete keys[0].active
    delete keys[0].expiresAt
    delete keys[0].requestsPerMinute
    delete keys[0].requestCount
    delete keys[0].inputTokens
    delete keys[0].outputTokens
    delete keys[0].failureCount
    delete keys[0].lastUsedAt
    await writeFile(keyFile, `${JSON.stringify(keys)}\n`)

    expect(await store.list()).toEqual([{ id: created.id, name: 'test key', createdAt: expect.any(String), active: true, expiresAt: null, requestsPerMinute: 60, requestCount: 0, inputTokens: 0, outputTokens: 0, failureCount: 0, lastUsedAt: null }])
  })

  it('rejects expired keys while preserving the dsh_live key format', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))
    const created = await store.create('expiring key', { expiresAt: '2000-01-01T00:00:00.000Z', requestsPerMinute: 12 })

    expect(created.key).toMatch(/^dsh_live_[A-Za-z0-9_-]+$/)
    expect(await store.verify(created.key)).toBe(false)
    expect(await store.list()).toMatchObject([{ id: created.id, expiresAt: '2000-01-01T00:00:00.000Z', requestsPerMinute: 12 }])
  })

  it('updates policy without exposing the hash or raw secret', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))
    const created = await store.create('editable key')

    const updated = await store.update(created.id, { active: false, expiresAt: '2030-01-01T00:00:00.000Z', requestsPerMinute: 30 })

    expect(updated).toEqual({ id: created.id, name: 'editable key', createdAt: expect.any(String), active: false, expiresAt: '2030-01-01T00:00:00.000Z', requestsPerMinute: 30, requestCount: 0, inputTokens: 0, outputTokens: 0, failureCount: 0, lastUsedAt: null })
    expect(updated).not.toHaveProperty('hash')
    expect(updated).not.toHaveProperty('key')
  })

  it('rejects unsafe policy updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const store = new ApiKeyStore(join(directory, 'keys.json'))
    const created = await store.create('test key')

    await expect(store.update(created.id, { requestsPerMinute: 0 })).rejects.toThrow()
    await expect(store.update(created.id, { requestsPerMinute: 1.5 })).rejects.toThrow()
    await expect(store.update(created.id, { expiresAt: 'not-a-date' })).rejects.toThrow()
    await expect(store.update(created.id, { expiresAt: '2030-01-01T00:00:00Z' })).rejects.toThrow()
    await expect(store.update(created.id, { active: 'yes' } as never)).rejects.toThrow()
  })

  it('fails closed when a persisted expiry timestamp is malformed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const keyFile = join(directory, 'keys.json')
    const store = new ApiKeyStore(keyFile)
    const created = await store.create('test key')
    const keys = JSON.parse(await readFile(keyFile, 'utf8')) as Array<Record<string, unknown>>
    keys[0].expiresAt = 'not-a-date'
    await writeFile(keyFile, `${JSON.stringify(keys)}\n`)

    expect(await store.verify(created.key)).toBe(false)
    expect(await store.identify(created.key)).toBeUndefined()
  })

  it('fails closed when a persisted workspace root is malformed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-workspace-'))
    const keyFile = join(directory, 'keys.json')
    const store = new ApiKeyStore(keyFile)
    const created = await store.create('test key', { workspaceRoot: '.' })
    const keys = JSON.parse(await readFile(keyFile, 'utf8')) as Array<Record<string, unknown>>
    keys[0].workspaceRoot = ''
    await writeFile(keyFile, `${JSON.stringify(keys)}\n`)

    expect(await store.identify(created.key)).toBeUndefined()
  })

  it('persists usage counters and the last-used timestamp', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const keyFile = join(directory, 'keys.json')
    const store = new ApiKeyStore(keyFile)
    const created = await store.create('used key')

    await store.recordUsage(created.id, { inputTokens: 7, outputTokens: 11, failed: true })

    const metadata = (await new ApiKeyStore(keyFile).list())[0]
    expect(metadata).toMatchObject({ id: created.id, requestCount: 1, inputTokens: 7, outputTokens: 11, failureCount: 1, lastUsedAt: expect.any(String) })
    expect(new Date(metadata.lastUsedAt!).toISOString()).toBe(metadata.lastUsedAt)
  })

  it('serializes concurrent usage recording', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-auth-'))
    const keyFile = join(directory, 'keys.json')
    const store = new ApiKeyStore(keyFile)
    const otherStore = new ApiKeyStore(keyFile)
    const created = await store.create('busy key')

    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? store : otherStore).recordUsage(created.id, { inputTokens: 2, outputTokens: 3 })))

    expect((await store.list())[0]).toMatchObject({ requestCount: 20, inputTokens: 40, outputTokens: 60, failureCount: 0, lastUsedAt: expect.any(String) })
  })
})
