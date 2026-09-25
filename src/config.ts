import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isInsideWorkspace } from './security.js'

const defaultModels = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini']
const defaultImageModels = [...defaultModels]
const defaultEfforts = ['low', 'medium', 'high', 'xhigh', 'max']

export interface AppConfig {
  publicDirectory?: string
  desktopAdminToken?: string
  port: number
  host: string
  codexCommand: string
  codexStateRoot: string
  workspaceRoot: string
  keyFile: string
  models: string[]
  imageModels: string[]
  modelEfforts: Record<string, string[]>
  maxConcurrent?: number
  maxConcurrentPerKey?: number
  maxQueue?: number
  requestTimeoutMs?: number
  shutdownGraceMs?: number
}

function csv(value: string | undefined, fallback: string[]): string[] {
  const result = value?.split(',').map(item => item.trim()).filter(Boolean)
  return result && result.length > 0 ? result : fallback
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function modelEfforts(value: string | undefined, models: string[]): Record<string, string[]> {
  if (value === undefined) return Object.fromEntries(models.map(model => [model,
    model === 'gpt-6-astra' || model === 'gpt-6-sol' || model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra' ? [...defaultEfforts, 'ultra']
      : model === 'gpt-6-luna' || model === 'gpt-5.6-luna' ? defaultEfforts
        : defaultEfforts.slice(0, 4),
  ]))
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    return Object.fromEntries(Object.entries(parsed).map(([model, efforts]) => {
      if (!Array.isArray(efforts) || !efforts.every(item => typeof item === 'string' && item.length > 0)) throw new Error(`invalid efforts for ${model}`)
      return [model, efforts]
    }))
  } catch (error: unknown) {
    throw new Error('CODEX_MODEL_EFFORTS must be a JSON object of model ids to non-empty string arrays', { cause: error })
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const models = csv(env.CODEX_MODELS, defaultModels)
  const config = {
    port: numberEnv(env.PORT, 3081),
    host: env.HOST?.trim() || '127.0.0.1',
    codexCommand: env.CODEX_COMMAND?.trim() || 'codex',
    codexStateRoot: resolve(env.CODEX_STATE_ROOT?.trim() || join(process.cwd(), 'data', 'codex-users')),
    workspaceRoot: resolve(env.CODEX_WORKSPACE_ROOT?.trim() || join(process.cwd(), 'workspaces')),
    keyFile: resolve(env.CODEX_API_KEY_FILE?.trim() || 'data/api-keys.json'),
    models,
    imageModels: csv(env.CODEX_IMAGE_MODELS, defaultImageModels).filter(model => models.includes(model)),
    modelEfforts: modelEfforts(env.CODEX_MODEL_EFFORTS, models),
    maxConcurrent: numberEnv(env.CODEX_MAX_CONCURRENT, 2),
    maxConcurrentPerKey: numberEnv(env.CODEX_MAX_CONCURRENT_PER_KEY, 1),
    maxQueue: numberEnv(env.CODEX_MAX_QUEUE, 20),
    requestTimeoutMs: numberEnv(env.CODEX_REQUEST_TIMEOUT_MS, 600_000),
    shutdownGraceMs: numberEnv(env.CODEX_SHUTDOWN_GRACE_MS, 30_000),
  }
  if (isInsideWorkspace(config.workspaceRoot, config.codexStateRoot) || isInsideWorkspace(config.codexStateRoot, config.workspaceRoot)) {
    throw new Error('CODEX_STATE_ROOT and CODEX_WORKSPACE_ROOT must not overlap')
  }
  if (isInsideWorkspace(config.workspaceRoot, config.keyFile)) throw new Error('CODEX_API_KEY_FILE must be outside CODEX_WORKSPACE_ROOT')
  return config
}

export async function prepareConfig(config: AppConfig): Promise<void> {
  await Promise.all([
    mkdir(config.workspaceRoot, { recursive: true }),
    mkdir(config.codexStateRoot, { recursive: true }),
    mkdir(dirname(config.keyFile), { recursive: true }),
  ])
  const [workspaceRoot, codexStateRoot, keyFile] = await Promise.all([
    realpath(config.workspaceRoot),
    realpath(config.codexStateRoot),
    canonicalFile(config.keyFile),
  ])
  if (isInsideWorkspace(workspaceRoot, codexStateRoot) || isInsideWorkspace(codexStateRoot, workspaceRoot)) {
    throw new Error('CODEX_STATE_ROOT and CODEX_WORKSPACE_ROOT must not overlap after resolving links')
  }
  if (isInsideWorkspace(workspaceRoot, keyFile)) throw new Error('CODEX_API_KEY_FILE must be outside CODEX_WORKSPACE_ROOT after resolving links')
}

async function canonicalFile(file: string): Promise<string> {
  try {
    return await realpath(file)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return resolve(await realpath(dirname(file)), basename(file))
  }
}
