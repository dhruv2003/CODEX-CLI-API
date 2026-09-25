import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, prepareConfig } from '../src/config.js'
import { isInsideWorkspace } from '../src/security.js'

describe('configuration', () => {
  it('does not advertise models rejected by the current Codex backend', () => {
    expect(loadConfig({}).models).not.toContain('gpt-5.4')
  })

  it('includes GPT-6 Sol and Luna in the default selectable model catalog', () => {
    const config = loadConfig({})

    expect(config.models).toEqual(expect.arrayContaining(['gpt-6-sol', 'gpt-6-luna']))
    expect(config.imageModels).toEqual(expect.arrayContaining(['gpt-6-sol', 'gpt-6-luna']))
    expect(config.modelEfforts['gpt-6-sol']).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(config.modelEfforts['gpt-6-luna']).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('gives custom enabled models the default reasoning efforts', () => {
    const config = loadConfig({ CODEX_MODELS: 'custom-model' })

    expect(config.modelEfforts['custom-model']).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('enables ultra reasoning for models that support it', () => {
    const config = loadConfig({ CODEX_MODELS: 'gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna' })

    expect(config.modelEfforts['gpt-6-astra']).toContain('ultra')
    expect(config.modelEfforts['gpt-6-sol']).toContain('ultra')
    expect(config.modelEfforts['gpt-5.6-sol']).toContain('ultra')
    expect(config.modelEfforts['gpt-5.6-terra']).toContain('ultra')
    expect(config.modelEfforts['gpt-5.6-luna']).not.toContain('ultra')
    expect(config.modelEfforts['gpt-6-luna']).not.toContain('ultra')
  })

  it('keeps Codex credentials outside the default callable workspace', () => {
    const config = loadConfig({})

    expect(isInsideWorkspace(config.workspaceRoot, config.codexStateRoot)).toBe(false)
    expect(isInsideWorkspace(config.workspaceRoot, config.keyFile)).toBe(false)
  })

  it('loads admission and timeout limits with positive-integer fallbacks', () => {
    expect(loadConfig({})).toMatchObject({
      maxConcurrent: 2,
      maxConcurrentPerKey: 1,
      maxQueue: 20,
      requestTimeoutMs: 600_000,
    })
    expect(loadConfig({
      CODEX_MAX_CONCURRENT: '5',
      CODEX_MAX_CONCURRENT_PER_KEY: '3',
      CODEX_MAX_QUEUE: '40',
      CODEX_REQUEST_TIMEOUT_MS: '120000',
    })).toMatchObject({ maxConcurrent: 5, maxConcurrentPerKey: 3, maxQueue: 40, requestTimeoutMs: 120_000 })
    expect(loadConfig({
      CODEX_MAX_CONCURRENT: '0',
      CODEX_MAX_CONCURRENT_PER_KEY: '-1',
      CODEX_MAX_QUEUE: 'nope',
      CODEX_REQUEST_TIMEOUT_MS: '1.5',
    })).toMatchObject({ maxConcurrent: 2, maxConcurrentPerKey: 1, maxQueue: 20, requestTimeoutMs: 600_000 })
  })

  it('rejects configured credential paths inside the callable workspace', () => {
    expect(() => loadConfig({
      CODEX_WORKSPACE_ROOT: join(tmpdir(), 'workspace'),
      CODEX_STATE_ROOT: join(tmpdir(), 'workspace', 'codex-users'),
      CODEX_API_KEY_FILE: join(tmpdir(), 'keys.json'),
    })).toThrow(/must not overlap/)
  })

  it('allows a bounded shutdown grace period to be configured', () => {
    expect(loadConfig({}).shutdownGraceMs).toBe(30_000)
    expect(loadConfig({ CODEX_SHUTDOWN_GRACE_MS: '120000' }).shutdownGraceMs).toBe(120_000)
    expect(loadConfig({ CODEX_SHUTDOWN_GRACE_MS: '-1' }).shutdownGraceMs).toBe(30_000)
  })

  it('rejects a linked credential root that resolves inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-config-'))
    const workspace = join(root, 'workspace')
    const credentialTarget = join(workspace, 'credentials')
    const credentialAlias = join(root, 'credential-alias')
    await mkdir(credentialTarget, { recursive: true })
    await symlink(credentialTarget, credentialAlias, 'junction')
    const config = loadConfig({
      CODEX_WORKSPACE_ROOT: workspace,
      CODEX_STATE_ROOT: credentialAlias,
      CODEX_API_KEY_FILE: join(root, 'keys', 'api-keys.json'),
    })

    await expect(prepareConfig(config)).rejects.toThrow(/must not overlap after resolving links/)
  })
})
