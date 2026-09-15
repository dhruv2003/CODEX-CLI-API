import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyDesktop } from '../src/desktop-migration.js'
import { ApiKeyStore } from '../src/auth.js'

describe('desktop legacy migration', () => {
  let root: string, legacy: string, data: string, workspace: string, project: string, id: string, secret: string
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-import-')))
    legacy = join(root, 'legacy'); data = join(root, 'desktop'); workspace = join(root, 'workspace'); project = join(workspace, 'project')
    await mkdir(project, { recursive: true }); await mkdir(legacy)
    const key = await new ApiKeyStore(join(legacy, 'api-keys.json')).create('Existing key', { workspaceRoot: 'project' })
    id = key.id; secret = key.key
    await mkdir(join(legacy, 'users', id), { recursive: true })
    await writeFile(join(legacy, 'users', id, 'auth.json'), '{"fixture":true}')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const options = () => ({ dataDirectory: data, workspaceRoot: project, legacyRoot: legacy, legacyWorkspaceRoot: workspace })
  it('preserves secrets and exact scope while copying credentials once', async () => {
    const before = await readFile(join(legacy, 'api-keys.json'), 'utf8')
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'imported', count: 1 })
    const store = new ApiKeyStore(join(data, 'api-keys.json'))
    expect(await store.verify(secret)).toBe(true)
    expect((await store.list())[0].workspaceRoot).toBe('.')
    expect(await readFile(join(data, 'codex-users', id, 'auth.json'), 'utf8')).toBe('{"fixture":true}')
    expect(await readFile(join(legacy, 'api-keys.json'), 'utf8')).toBe(before)
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'existing' })
  })
  it('reads migration paths only from selected workspace .env', async () => {
    await writeFile(join(project, '.env'), `CODEX_WORKSPACE_ROOT=${workspace}\nCODEX_API_KEY_FILE=${join(legacy, 'api-keys.json')}\nCODEX_STATE_ROOT=${join(legacy, 'users')}\n`)
    expect(await migrateLegacyDesktop({ ...options(), legacyWorkspaceRoot: undefined })).toMatchObject({ status: 'imported', count: 1 })
  })
  it('backs up an existing empty destination before adding legacy keys', async () => {
    await mkdir(data); await writeFile(join(data, 'api-keys.json'), '[]')
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'imported' })
    const backup = (await readdir(data)).find(name => name.endsWith('.pre-legacy-import.json'))!
    expect(await readFile(join(data, backup), 'utf8')).toBe('[]')
  })
  it('rejects malformed source and symbolic-link credentials without writing keys', async () => {
    await symlink(join(root, 'outside'), join(legacy, 'users', id, 'unsafe'))
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed' })
    await expect(readFile(join(data, 'api-keys.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(legacy, 'api-keys.json'), '[{"id":"../unsafe"}]')
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed' })
  })
  it('never replaces destination credentials or broadens key scope', async () => {
    await mkdir(join(data, 'codex-users', id), { recursive: true })
    await writeFile(join(data, 'codex-users', id, 'auth.json'), 'existing')
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed' })
    expect(await readFile(join(data, 'codex-users', id, 'auth.json'), 'utf8')).toBe('existing')
    const elsewhere = join(workspace, 'other'); await mkdir(elsewhere)
    expect(await migrateLegacyDesktop({ ...options(), workspaceRoot: elsewhere })).toMatchObject({ status: 'failed' })
  })
  it('requires verified original workspace instead of guessing', async () => {
    expect(await migrateLegacyDesktop({ ...options(), legacyWorkspaceRoot: undefined })).toMatchObject({ status: 'needs_workspace' })
    await expect(readFile(join(data, 'api-keys.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('merges missing legacy keys without changing current desktop records', async () => {
    const current = await new ApiKeyStore(join(data, 'api-keys.json')).create('Desktop key', { workspaceRoot: '.' })
    const before = JSON.parse(await readFile(join(data, 'api-keys.json'), 'utf8'))[0]
    const second = await new ApiKeyStore(join(legacy, 'api-keys.json')).create('Second old key', { workspaceRoot: 'project' })
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'imported', count: 2 })
    const store = new ApiKeyStore(join(data, 'api-keys.json'))
    expect(await store.list()).toHaveLength(3)
    expect(JSON.parse(await readFile(join(data, 'api-keys.json'), 'utf8'))[0]).toEqual(before)
    for (const key of [current.key, secret, second.key]) expect(await store.verify(key)).toBe(true)
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'existing', count: 0 })
    expect(await store.list()).toHaveLength(3)
  })
  it('refuses ID collisions and never steals another writer lock', async () => {
    const record = JSON.parse(await readFile(join(legacy, 'api-keys.json'), 'utf8'))[0]
    await mkdir(data)
    const destinationRaw = JSON.stringify([{ ...record, hash: 'b'.repeat(64), workspaceRoot: '.' }])
    await writeFile(join(data, 'api-keys.json'), destinationRaw)
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed', message: expect.stringContaining('conflicts') })
    expect(await readFile(join(data, 'api-keys.json'), 'utf8')).toBe(destinationRaw)
    await mkdir(join(data, 'api-keys.json.lock'))
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed', message: expect.stringContaining('locked') })
    expect(await readdir(data)).toContain('api-keys.json.lock')
  })
  it('never resurrects imported keys that the user subsequently deletes', async () => {
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'imported' })
    const store = new ApiKeyStore(join(data, 'api-keys.json'))
    await store.setActive(id, false)
    await store.deleteInactive(id)
    expect(await store.list()).toHaveLength(0)
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'existing', count: 0 })
    expect(await store.list()).toHaveLength(0)
  })
  it('fails closed when a previous import has a pending marker', async () => {
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'imported' })
    const marker = (await readdir(data)).find(name => /^\.legacy-import-.*\.json$/.test(name))!
    await writeFile(join(data, marker), JSON.stringify({ status: 'pending', count: 1 }))
    const before = await readFile(join(data, 'api-keys.json'), 'utf8')
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed', message: expect.stringContaining('interrupted') })
    expect(await readFile(join(data, 'api-keys.json'), 'utf8')).toBe(before)
  })
  it('refuses linked source key files and traversal scopes without modifying source', async () => {
    const sourceFile = join(legacy, 'api-keys.json')
    const original = await readFile(sourceFile, 'utf8')
    const outsideFile = join(root, 'outside-keys.json')
    await writeFile(outsideFile, original)
    await rm(sourceFile)
    await symlink(outsideFile, sourceFile)
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed' })
    expect(await readFile(outsideFile, 'utf8')).toBe(original)
    await rm(sourceFile)
    const records = JSON.parse(original)
    records[0].workspaceRoot = '../'
    const traversal = JSON.stringify(records)
    await writeFile(sourceFile, traversal)
    expect(await migrateLegacyDesktop(options())).toMatchObject({ status: 'failed' })
    expect(await readFile(sourceFile, 'utf8')).toBe(traversal)
    await expect(readFile(join(data, 'api-keys.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
