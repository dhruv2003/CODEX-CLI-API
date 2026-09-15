import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { isInsideWorkspace } from './security.js'

export interface MigrationResult { status: 'imported' | 'existing' | 'not_found' | 'needs_workspace' | 'failed'; count: number; message: string }
export interface MigrationOptions { dataDirectory: string; workspaceRoot: string; legacyRoot?: string; legacyWorkspaceRoot?: string }
const exists = async (path: string): Promise<boolean> => { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function plain(path: string, directory: boolean): Promise<void> {
  const entry = await lstat(path)
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) throw new Error('Import refused: expected ordinary files and folders, not symbolic links.')
}
const timestamp = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function validate(value: unknown): asserts value is Array<Record<string, unknown> & { id: string; workspaceRoot?: string }> {
  if (!Array.isArray(value)) throw new Error('Legacy API key data must contain an array.')
  const ids = new Set<string>()
  for (const record of value) {
    if (!record || typeof record !== 'object' || !/^key_[a-f0-9]{16}$/.test(record.id) || ids.has(record.id) || typeof record.name !== 'string' || !/^[a-f0-9]{64}$/.test(record.hash) || !timestamp(record.createdAt)) throw new Error('Legacy API key data contains an invalid or duplicate record.')
    ids.add(record.id)
    if (record.active !== undefined && typeof record.active !== 'boolean') throw new Error('Invalid legacy key state.')
    for (const field of ['expiresAt', 'lastUsedAt']) if (record[field] !== undefined && record[field] !== null && !timestamp(record[field])) throw new Error('Invalid legacy key timestamp.')
    for (const field of ['requestsPerMinute', 'requestCount', 'inputTokens', 'outputTokens', 'failureCount']) if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || record[field] < (field === 'requestsPerMinute' ? 1 : 0))) throw new Error('Invalid legacy key limits or counters.')
    if (record.workspaceRoot !== undefined && (typeof record.workspaceRoot !== 'string' || !record.workspaceRoot || record.workspaceRoot.includes('\0') || record.workspaceRoot.length > 4096 || isAbsolute(record.workspaceRoot))) throw new Error('Invalid legacy relative workspace.')
  }
}
async function copyHome(source: string, target: string): Promise<void> {
  await plain(source, true)
  await mkdir(target, { mode: 0o700 })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Legacy credentials contain a symbolic link; import was cancelled.')
    if (/(?:\.lock|\.tmp|\.pid)$/.test(entry.name) || ['tmp', '.tmp', 'locks'].includes(entry.name)) continue
    const from = join(source, entry.name), to = join(target, entry.name)
    if (entry.isDirectory()) await copyHome(from, to)
    else if (entry.isFile()) { await plain(from, false); await copyFile(from, to, 1); await chmod(to, 0o600) }
    else throw new Error('Legacy credentials contain an unsupported file type.')
  }
}

/** Merge missing IDs once; source and existing records/credentials are never modified. */
export async function migrateLegacyDesktop(options: MigrationOptions): Promise<MigrationResult> {
  const source = resolve(options.legacyRoot ?? join(homedir(), '.codex-cli-api'))
  let sourceKeys = join(source, 'api-keys.json')
  let sourceUsers = join(source, 'users')
  let legacyRoot = options.legacyWorkspaceRoot
  const destination = resolve(options.dataDirectory)
  const targetKeys = join(destination, 'api-keys.json')
  let stage: string | undefined
  const createdHomes: string[] = []
  let committed = false
  let locked = false
  const lock = `${targetKeys}.lock`
  try {
    const hasDestination = await exists(targetKeys)
    const envFile = join(options.workspaceRoot, '.env')
    if (!legacyRoot && await exists(envFile)) {
      await plain(envFile, false)
      const legacyEnv = parseEnv(await readFile(envFile, 'utf8'))
      if (legacyEnv.CODEX_WORKSPACE_ROOT && isAbsolute(legacyEnv.CODEX_WORKSPACE_ROOT)) legacyRoot = legacyEnv.CODEX_WORKSPACE_ROOT
      if (legacyEnv.CODEX_API_KEY_FILE) {
        if (!isAbsolute(legacyEnv.CODEX_API_KEY_FILE)) throw new Error('The previous setup key file must be an absolute path for safe import.')
        sourceKeys = legacyEnv.CODEX_API_KEY_FILE
      }
      if (legacyEnv.CODEX_STATE_ROOT) {
        if (!isAbsolute(legacyEnv.CODEX_STATE_ROOT)) throw new Error('The previous setup credential folder must be an absolute path for safe import.')
        sourceUsers = legacyEnv.CODEX_STATE_ROOT
      }
    }
    if (!(await exists(sourceKeys))) return hasDestination ? { status: 'existing', count: 0, message: 'Using existing desktop API keys.' } : { status: 'not_found', count: 0, message: 'No previous local setup found. Create your first API key below.' }
    await plain(sourceKeys, false)
    if (await realpath(sourceKeys) !== resolve(sourceKeys)) throw new Error('Legacy key file paths must not contain symbolic links.')
    const raw = await readFile(sourceKeys, 'utf8')
    const records: unknown = JSON.parse(raw)
    validate(records)
    // The old file stores relative scopes. Guessing its original root could grant
    // keys access to unrelated projects, so require a verified root from setup.
    if (!legacyRoot) return hasDestination ? { status: 'existing', count: 0, message: 'Using existing desktop keys. Select the old project folder with its .env to import previous keys.' } : { status: 'needs_workspace', count: 0, message: 'Previous keys found. Select your old project folder containing its .env configuration to import safely; the original workspace cannot be guessed.' }
    const legacyWorkspace = await realpath(legacyRoot)
    const workspace = await realpath(options.workspaceRoot)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    await plain(destination, true)
    const canonicalDestination = await realpath(destination)
    try { await mkdir(lock, { mode: 0o700 }); locked = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Desktop API key store is locked by another writer. Stop other gateway instances before retrying the import; do not remove an active lock.')
      throw error
    }
    const sourceId = createHash('sha256').update(await realpath(sourceKeys)).update('\0').update(legacyWorkspace).digest('hex')
    const completionFile = join(destination, `.legacy-import-${sourceId}.json`)
    if (await exists(completionFile)) {
      await plain(completionFile, false)
      const marker = JSON.parse(await readFile(completionFile, 'utf8'))
      if (marker.status !== 'completed') throw new Error('A previous legacy import was interrupted. Automatic import is paused to avoid restoring deleted keys. Review the import and backup files before manually recovering it.')
      return { status: 'existing', count: 0, message: 'This previous setup has already been imported. Desktop key changes and deletions are preserved.' }
    }
    const existingRaw = await exists(targetKeys) ? (await plain(targetKeys, false), await readFile(targetKeys, 'utf8')) : null
    const existing: unknown = existingRaw === null ? [] : JSON.parse(existingRaw)
    validate(existing)
    for (const record of records) {
      const scope = resolve(legacyWorkspace, record.workspaceRoot ?? '.')
      if (!isInsideWorkspace(legacyWorkspace, scope)) throw new Error('An existing key points outside the original workspace.')
      const canonicalScope = await realpath(scope)
      if (!isInsideWorkspace(workspace, canonicalScope)) throw new Error('Some existing keys belong to folders outside this workspace. Choose a common parent workspace to import all keys without changing their access.')
      if (scope !== canonicalScope || isInsideWorkspace(canonicalScope, canonicalDestination) || isInsideWorkspace(canonicalDestination, canonicalScope)) throw new Error('An existing key workspace is unsafe or overlaps private desktop data.')
      await plain(scope, true)
      record.workspaceRoot = relative(workspace, canonicalScope) || '.'
    }
    const missing = records.filter(record => {
      const current = existing.find(entry => entry.id === record.id)
      if (!current) return true
      if (current.hash !== record.hash || resolve(workspace, current.workspaceRoot ?? '.') !== resolve(workspace, record.workspaceRoot ?? '.')) throw new Error('An existing desktop key ID conflicts with a legacy key. Import refused to change either key.')
      return false
    })
    if (!missing.length) {
      await writeFile(completionFile, JSON.stringify({ status: 'completed', count: 0 }), { mode: 0o600, flag: 'wx' })
      return { status: 'existing', count: 0, message: 'All previous API keys are already available in this desktop app.' }
    }
    stage = await mkdtemp(join(destination, '.legacy-import-'))
    await writeFile(join(stage, 'marker.json'), JSON.stringify({ state: 'staging', count: missing.length }), { mode: 0o600, flag: 'wx' })
    const homes = join(destination, 'codex-users')
    await mkdir(homes, { recursive: true, mode: 0o700 }); await plain(homes, true)
    for (const record of missing) {
      const from = join(sourceUsers, record.id)
      if (!(await exists(from))) continue
      await plain(sourceUsers, true)
      if (await realpath(sourceUsers) !== resolve(sourceUsers)) throw new Error('Legacy credential paths must not contain symbolic links.')
      const to = join(homes, record.id)
      if (await exists(to)) throw new Error('Desktop credentials already exist for a legacy key. Import refused to overwrite them.')
      await copyHome(from, join(stage, record.id))
    }
    await writeFile(join(stage, 'api-keys.json'), JSON.stringify([...existing, ...missing], null, 2), { mode: 0o600, flag: 'wx' })
    // A pending marker precedes every persistent mutation. A process crash fails
    // closed rather than silently rerunning an import and resurrecting removals.
    await writeFile(completionFile, JSON.stringify({ status: 'pending', count: missing.length }), { mode: 0o600, flag: 'wx' })
    for (const record of missing) {
      if (!(await exists(join(stage, record.id)))) continue
      const target = join(homes, record.id)
      // Reserve the destination before moving children so existing data can never
      // be replaced. Rollback below only removes directories reserved here.
      await mkdir(target, { mode: 0o700 }); createdHomes.push(target)
      for (const entry of await readdir(join(stage, record.id))) await rename(join(stage, record.id, entry), join(target, entry))
    }
    if (existingRaw !== null) {
      await writeFile(join(destination, `api-keys.${randomUUID()}.pre-legacy-import.json`), existingRaw, { mode: 0o600, flag: 'wx' })
      await rename(join(stage, 'api-keys.json'), targetKeys)
    } else {
      // First import refuses EEXIST; merges are serialized by the store lock.
      await link(join(stage, 'api-keys.json'), targetKeys)
    }
    committed = true
    await writeFile(join(stage, 'completion.json'), JSON.stringify({ status: 'completed', count: missing.length }), { mode: 0o600, flag: 'wx' })
    await rename(join(stage, 'completion.json'), completionFile)
    return { status: 'imported', count: missing.length, message: `Imported ${missing.length} existing API key${missing.length === 1 ? '' : 's'} and available Codex sign-ins. Your previous setup and current desktop keys are unchanged.` }
  } catch (error) {
    if (!committed) for (const home of createdHomes) await rm(home, { recursive: true, force: true }).catch(() => {})
    return { status: 'failed', count: 0, message: error instanceof Error ? error.message : 'Existing setup could not be imported. Your original files are unchanged.' }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {})
    if (locked) await rmdir(lock).catch(() => {})
  }
}
