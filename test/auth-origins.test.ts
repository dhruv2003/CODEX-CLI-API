import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'

describe('stored origin policy', () => {
  it('normalizes exact origins, removes duplicates, and persists policy updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auth-origins-'))
    const file = join(root, 'keys.json')
    const store = new ApiKeyStore(file)
    const created = await store.create('web', { allowedOrigins: ['https://APP.example:443/', 'http://localhost:80', 'https://app.example', 'http://[::1]:3100/'] })
    expect(created.allowedOrigins).toEqual(['https://app.example', 'http://localhost', 'http://[::1]:3100'])
    expect(await new ApiKeyStore(file).identify(created.key)).toMatchObject({ allowedOrigins: created.allowedOrigins })
    await store.update(created.id, { allowedOrigins: ['http://localhost:3000/'] })
    expect(await store.identify(created.key)).toMatchObject({ allowedOrigins: ['http://localhost:3000'] })
    await store.update(created.id, { active: true })
    expect((await store.list())[0].allowedOrigins).toEqual(['http://localhost:3000'])
    await store.update(created.id, { allowedOrigins: [] })
    expect((await store.list())[0].allowedOrigins).toEqual([])
  })

  it.each([null, '*', ['*'], ['null'], ['file://example'], ['https://user:pass@app.example'], ['https://app.example/path'], ['https://app.example?'], ['https://app.example#'], ['https://app.example/..'], ['https://app.example\\evil'], ['https://*.example'], [' https://app.example'], ['https://app.example\n'], [7], Array.from({ length: 21 }, (_, i) => `https://app${i}.example`), [`https://${'a'.repeat(2048)}.example`]].map(value => [value]))('rejects malformed origin policy %j', async allowedOrigins => {
    const root = await mkdtemp(join(tmpdir(), 'auth-origins-'))
    const store = new ApiKeyStore(join(root, 'keys.json'))
    await expect(store.create('invalid', { allowedOrigins } as never)).rejects.toThrow('allowedOrigins')
    const created = await store.create('valid')
    await expect(store.update(created.id, { allowedOrigins } as never)).rejects.toThrow('allowedOrigins')
    expect((await store.list())[0].allowedOrigins).toEqual([])
  })

  it.each([null, '*', ['*'], ['https://app.example', 7]].map(value => [value]))('fails closed on malformed stored policy %j', async allowedOrigins => {
    const root = await mkdtemp(join(tmpdir(), 'auth-origins-'))
    const file = join(root, 'keys.json')
    const store = new ApiKeyStore(file)
    const created = await store.create('web')
    const records = JSON.parse(await readFile(file, 'utf8'))
    records[0].allowedOrigins = allowedOrigins
    await writeFile(file, JSON.stringify(records))
    expect(await store.identify(created.key)).toBeUndefined()
    expect((await store.list())[0].allowedOrigins).toEqual([])
  })

  it('rejects a percent-encoded wildcard host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'auth-origins-'))
    const store = new ApiKeyStore(join(root, 'keys.json'))
    await expect(store.create('invalid', { allowedOrigins: ['https://%2a.example'] })).rejects.toThrow('allowedOrigins')
  })
})
