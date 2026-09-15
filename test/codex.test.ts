import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { CodexSessionManager } from '../src/codex.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

describe('Codex CLI execution', () => {
  it('retires a key before deleting its captured sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-retire-'))
    const config = {
      port: 0, host: '127.0.0.1', codexCommand: 'codex', codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root, keyFile: join(root, 'keys.json'), models: ['gpt-5.6-sol'], imageModels: [],
      modelEfforts: { 'gpt-5.6-sol': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    const keyId = 'key_0123456789abcdef'
    const session = sessions.create(root, keyId)

    expect(sessions.tryRetireKey(keyId)).toBe(true)
    expect(() => sessions.create(root, keyId)).toThrow('API key is being deleted')
    await expect(sessions.run(session, request('workspace-write')).next()).rejects.toThrow('API key is being deleted')
    sessions.finalizeKeyDeletion(keyId)
    expect(sessions.get(session.id, keyId)).toBeUndefined()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not retire a key with a running session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-retire-'))
    const config = {
      port: 0, host: '127.0.0.1', codexCommand: 'codex', codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root, keyFile: join(root, 'keys.json'), models: ['gpt-5.6-sol'], imageModels: [],
      modelEfforts: { 'gpt-5.6-sol': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    const keyId = 'key_0123456789abcdef'
    const session = sessions.create(root, keyId)
    session.busy = true

    expect(sessions.tryRetireKey(keyId)).toBe(false)
    session.busy = false
    expect(() => sessions.create(root, keyId)).not.toThrow()
  })

  it('does not add the isolated state directory as a writable workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-codex-'))
    const child = new EventEmitter()
    Object.assign(child, {
      stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('close', 0))
      return child as never
    })

    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: 'C:\\api-workspace',
      keyFile: 'C:\\keys.json',
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    const session = sessions.create(config.workspaceRoot, 'key_0123456789abcdef')

    for await (const _event of sessions.run(session, {
      message: 'hello',
      model: 'gpt-5.4',
      sandbox: 'workspace-write',
      images: [],
      signal: new AbortController().signal,
    })) {
      // consume the stream
    }

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[]
    expect(args).toContain('--skip-git-repo-check')
    expect(args).not.toContain('--add-dir')
    expect(spawn).toHaveBeenCalledWith('codex', expect.any(Array), expect.objectContaining({
      env: expect.objectContaining({ CODEX_HOME: join(config.codexStateRoot, 'key_0123456789abcdef') }),
    }))
  })

  it('applies the requested sandbox when resuming a session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-resume-'))
    const children = [
      fakeChild([JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })]),
      fakeChild([]),
    ]
    vi.mocked(spawn).mockImplementation(() => {
      const child = children.shift()
      queueMicrotask(() => child?.emit('close', 0))
      return child as never
    })
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    const session = sessions.create(root, 'key_0123456789abcdef')

    for await (const _event of sessions.run(session, request('workspace-write'))) { /* consume */ }
    for await (const _event of sessions.run(session, request('read-only'))) { /* consume */ }

    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([
      '-c',
      'sandbox_mode="read-only"',
    ]))
  })
})

function request(sandbox: 'read-only' | 'workspace-write') {
  return {
    message: 'hello',
    model: 'gpt-5.4',
    sandbox,
    images: [],
    signal: new AbortController().signal,
  }
}

function fakeChild(lines: string[]) {
  const child = new EventEmitter()
  Object.assign(child, {
    stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
    stdout: Readable.from(lines.map(line => `${line}\n`)),
    stderr: Readable.from([]),
    kill: vi.fn(),
  })
  return child
}
