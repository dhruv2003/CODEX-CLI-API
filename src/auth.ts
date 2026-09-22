import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { normalizeAllowedOrigins } from './origins.js'

interface StoredKey {
  id: string
  name: string
  hash: string
  createdAt: string
  active?: boolean
  expiresAt?: string | null
  requestsPerMinute?: number
  requestCount?: number
  inputTokens?: number
  outputTokens?: number
  failureCount?: number
  lastUsedAt?: string | null
  workspaceRoot?: string
  allowedOrigins?: string[]
}

export interface CreatedApiKey {
  id: string
  name: string
  key: string
  createdAt: string
  active: boolean
  allowedOrigins: string[]
  workspaceRoot?: string
}

export interface ApiKeyIdentity {
  id: string
  name: string
  requestsPerMinute: number
  allowedOrigins: string[]
  workspaceRoot?: string
}

export interface ApiKeyMetadata extends ApiKeyIdentity {
  createdAt: string
  active: boolean
  expiresAt: string | null
  requestsPerMinute: number
  requestCount: number
  inputTokens: number
  outputTokens: number
  failureCount: number
  lastUsedAt: string | null
}

export interface ApiKeyPolicy {
  expiresAt?: string | null
  requestsPerMinute?: number
  allowedOrigins?: string[]
}

export interface ApiKeyCreateOptions extends ApiKeyPolicy {
  workspaceRoot?: string
}

export interface ApiKeyUpdate extends ApiKeyPolicy {
  active?: boolean
}

export interface ApiKeyUsage {
  inputTokens?: number
  outputTokens?: number
  failed?: boolean
}

export type DeleteApiKeyResult = 'deleted' | 'active' | 'not_found'

const DEFAULT_REQUESTS_PER_MINUTE = 60
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export class ApiKeyStore {
  private static readonly mutations = new Map<string, Promise<void>>()
  private readonly file: string

  constructor(file: string) {
    this.file = resolve(file)
  }

  async create(name: string, policy: ApiKeyCreateOptions = {}): Promise<CreatedApiKey> {
    const { expiresAt, requestsPerMinute, allowedOrigins } = validatePolicy(policy)
    if (policy.workspaceRoot !== undefined && !validWorkspaceRoot(policy.workspaceRoot)) throw new TypeError('workspaceRoot must be a non-empty relative path')
    const workspaceRoot = validWorkspaceRoot(policy.workspaceRoot) ? policy.workspaceRoot : undefined
    const key = `dsh_live_${randomBytes(32).toString('base64url')}`
    const created: CreatedApiKey = { id: `key_${randomBytes(8).toString('hex')}`, name, key, createdAt: new Date().toISOString(), active: true, allowedOrigins, ...(workspaceRoot ? { workspaceRoot } : {}) }
    const stored: StoredKey = {
      id: created.id,
      name,
      hash: hashKey(key),
      createdAt: created.createdAt,
      active: created.active,
      expiresAt,
      requestsPerMinute,
      allowedOrigins,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      failureCount: 0,
      lastUsedAt: null,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    }
    await this.mutate(async keys => { keys.push(stored) })
    return created
  }

  async verify(key: string): Promise<boolean> {
    return (await this.identify(key)) !== undefined
  }

  async list(): Promise<ApiKeyMetadata[]> {
    return (await this.read()).map(toMetadata)
  }

  async setActive(id: string, active: boolean): Promise<ApiKeyMetadata | undefined> {
    return this.update(id, { active })
  }

  async update(id: string, update: ApiKeyUpdate): Promise<ApiKeyMetadata | undefined> {
    validateUpdate(update)
    let updated: ApiKeyMetadata | undefined
    await this.mutate(async keys => {
      const stored = keys.find((key) => key.id === id)
      if (!stored) return
      if (update.active !== undefined) stored.active = update.active
      if (update.expiresAt !== undefined) stored.expiresAt = update.expiresAt
      if (update.requestsPerMinute !== undefined) stored.requestsPerMinute = update.requestsPerMinute
      if (update.allowedOrigins !== undefined) stored.allowedOrigins = normalizeAllowedOrigins(update.allowedOrigins)
      updated = toMetadata(stored)
    }, () => updated !== undefined)
    return updated
  }

  async recordUsage(id: string, usage: ApiKeyUsage = {}): Promise<ApiKeyMetadata | undefined> {
    validateUsage(usage)
    let updated: ApiKeyMetadata | undefined
    await this.mutate(async keys => {
      const stored = keys.find((key) => key.id === id)
      if (!stored) return
      const metadata = toMetadata(stored)
      stored.requestCount = metadata.requestCount + 1
      stored.inputTokens = metadata.inputTokens + (usage.inputTokens ?? 0)
      stored.outputTokens = metadata.outputTokens + (usage.outputTokens ?? 0)
      stored.failureCount = metadata.failureCount + (usage.failed === true ? 1 : 0)
      stored.lastUsedAt = new Date().toISOString()
      updated = toMetadata(stored)
    }, () => updated !== undefined)
    return updated
  }

  async deleteInactive(id: string, beforeDelete: () => Promise<void> = async () => {}): Promise<DeleteApiKeyResult> {
    let result: DeleteApiKeyResult = 'not_found'
    await this.mutate(async keys => {
      const index = keys.findIndex(key => key.id === id)
      if (index === -1) return
      if (keys[index].active !== false) {
        result = 'active'
        return
      }
      await beforeDelete()
      keys.splice(index, 1)
      result = 'deleted'
    }, () => result === 'deleted')
    return result
  }

  async identify(key: string): Promise<ApiKeyIdentity | undefined> {
    if (!key.startsWith('dsh_live_')) return undefined
    const actual = Buffer.from(hashKey(key), 'hex')
    for (const stored of await this.read()) {
      if (stored.workspaceRoot !== undefined && !validWorkspaceRoot(stored.workspaceRoot)) continue
      let allowedOrigins: string[]
      try { allowedOrigins = normalizeAllowedOrigins(stored.allowedOrigins) } catch { continue }
      const expected = Buffer.from(stored.hash, 'hex')
      if (stored.active !== false && !isExpired(stored.expiresAt) && expected.length === actual.length && timingSafeEqual(expected, actual)) {
        return { id: stored.id, name: stored.name, requestsPerMinute: toMetadata(stored).requestsPerMinute, allowedOrigins, ...(validWorkspaceRoot(stored.workspaceRoot) ? { workspaceRoot: stored.workspaceRoot } : {}) }
      }
    }
    return undefined
  }

  private async read(): Promise<StoredKey[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('key file must contain an array')
      return parsed as StoredKey[]
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async mutate(change: (keys: StoredKey[]) => Promise<void>, shouldWrite: () => boolean = () => true): Promise<void> {
    const previous = ApiKeyStore.mutations.get(this.file) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const lock = await this.acquireFileLock()
      try {
        const keys = await this.read()
        await change(keys)
        if (shouldWrite()) await this.write(keys)
      } finally {
        await rmdir(lock)
      }
    })
    const queued = operation.catch(() => {})
    ApiKeyStore.mutations.set(this.file, queued)
    void queued.finally(() => {
      if (ApiKeyStore.mutations.get(this.file) === queued) ApiKeyStore.mutations.delete(this.file)
    })
    return operation
  }

  private async acquireFileLock(): Promise<string> {
    await mkdir(dirname(this.file), { recursive: true })
    const lock = `${this.file}.lock`
    const deadline = performance.now() + 5_000
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 })
        return lock
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // ponytail: never steal a crash-left lock; stop all writers before removing it manually.
        if (performance.now() >= deadline) throw new Error(`API key store is locked: ${lock}. If a writer crashed, stop all writers before removing the lock directory.`)
        await delay(25)
      }
    }
  }

  private async write(keys: StoredKey[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

function toMetadata(key: StoredKey): ApiKeyMetadata {
  let allowedOrigins: string[] = []
  try { allowedOrigins = normalizeAllowedOrigins(key.allowedOrigins) } catch { /* Invalid stored policy denies authentication; keep admin metadata readable for repair. */ }
  return {
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    active: key.active !== false,
    expiresAt: validExpiresAt(key.expiresAt) ? key.expiresAt : null,
    requestsPerMinute: positiveInteger(key.requestsPerMinute) ? key.requestsPerMinute : DEFAULT_REQUESTS_PER_MINUTE,
    allowedOrigins,
    requestCount: nonNegativeInteger(key.requestCount) ? key.requestCount : 0,
    inputTokens: nonNegativeInteger(key.inputTokens) ? key.inputTokens : 0,
    outputTokens: nonNegativeInteger(key.outputTokens) ? key.outputTokens : 0,
    failureCount: nonNegativeInteger(key.failureCount) ? key.failureCount : 0,
    lastUsedAt: validExpiresAt(key.lastUsedAt) ? key.lastUsedAt : null,
    ...(validWorkspaceRoot(key.workspaceRoot) ? { workspaceRoot: key.workspaceRoot } : {}),
  }
}

function validatePolicy(policy: ApiKeyPolicy): { expiresAt: string | null; requestsPerMinute: number; allowedOrigins: string[] } {
  if (policy.expiresAt !== undefined && !validExpiresAt(policy.expiresAt)) throw new TypeError('expiresAt must be an ISO timestamp or null')
  if (policy.requestsPerMinute !== undefined && !positiveInteger(policy.requestsPerMinute)) throw new RangeError('requestsPerMinute must be a positive integer')
  return { expiresAt: policy.expiresAt ?? null, requestsPerMinute: policy.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE, allowedOrigins: normalizeAllowedOrigins(policy.allowedOrigins) }
}

function validateUpdate(update: ApiKeyUpdate): void {
  if (update.active !== undefined && typeof update.active !== 'boolean') throw new TypeError('active must be a boolean')
  validatePolicy(update)
}

function validateUsage(usage: ApiKeyUsage): void {
  if (usage.inputTokens !== undefined && !nonNegativeInteger(usage.inputTokens)) throw new RangeError('inputTokens must be a non-negative integer')
  if (usage.outputTokens !== undefined && !nonNegativeInteger(usage.outputTokens)) throw new RangeError('outputTokens must be a non-negative integer')
  if (usage.failed !== undefined && typeof usage.failed !== 'boolean') throw new TypeError('failed must be a boolean')
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validExpiresAt(value: unknown): value is string | null {
  return value === null || validTimestamp(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function validWorkspaceRoot(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
}

function isExpired(expiresAt: string | null | undefined): boolean {
  return expiresAt !== undefined && (expiresAt === null ? false : !validTimestamp(expiresAt) || Date.parse(expiresAt) <= Date.now())
}
