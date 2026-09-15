import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { CodexSessionManager } from '../src/codex.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'codex-lifecycle-'))
  const manager = new CodexSessionManager({ port: 0, host: 'localhost', codexCommand: 'codex', codexStateRoot: join(root, 'state'), workspaceRoot: root, keyFile: join(root, 'keys.json'), models: [], imageModels: [], modelEfforts: {} })
  const session = manager.create(root, 'key_123')
  const controller = new AbortController()
  const request = { message: 'hello', model: 'model', sandbox: 'read-only' as const, images: [], signal: controller.signal }
  return { root, manager, session, controller, request }
}

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new Writable({ write(_chunk, _encoding, callback) { callback() } }),
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 1) })
      return true
    }),
  })
  vi.mocked(spawn).mockReturnValue(child as never)
  return child
}

describe('process cleanup', () => {
  it('waits for an actual process to terminate after malformed output', async () => {
    const { manager, session, request } = await setup()
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const child = actual.spawn(process.execPath, ['-e', "console.log('invalid JSON'); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    vi.mocked(spawn).mockReturnValue(child)
    await expect(manager.run(session, request).next()).rejects.toThrow()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(session.busy).toBe(false)
  })

  it('quarantines a process after its termination deadline until actual close', async () => {
    const { manager, session, request } = await setup()
    const sibling = manager.create(session.cwd, session.apiKeyId)
    const child = childProcess()
    child.kill.mockImplementation(() => true)
    child.stdout.write('invalid JSON\n')
    await expect(manager.run(session, request).next()).rejects.toThrow('Codex CLI did not terminate')
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(session.busy).toBe(true)
    expect(manager.hasUnterminatedProcesses).toBe(true)
    expect(manager.delete(session.id, session.apiKeyId)).toBe(false)
    expect(manager.tryRetireKey(session.apiKeyId)).toBe(false)
    expect(() => manager.create(session.cwd, session.apiKeyId)).toThrow('unterminated process')
    await expect(manager.run(sibling, request).next()).rejects.toThrow('unterminated process')
    child.emit('close', 1)
    expect(session.busy).toBe(false)
    expect(manager.hasUnterminatedProcesses).toBe(false)
    expect(() => manager.create(session.cwd, session.apiKeyId)).not.toThrow()
    expect(manager.tryRetireKey(session.apiKeyId)).toBe(true)
    child.stdout.destroy()
    child.stderr.destroy()
  })

  it('keeps the session busy when a child closes while the consumer is paused', async () => {
    const { manager, session, request } = await setup()
    const child = childProcess()
    child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread' })}\n`)
    const stream = manager.run(session, request)
    await stream.next()
    child.stdout.end()
    child.emit('close', 0)
    expect(session.busy).toBe(true)
    expect(manager.delete(session.id, session.apiKeyId)).toBe(false)
    await stream.next()
    expect(session.busy).toBe(false)
  })

  it('releases busy state after setup fails', async () => {
    const { root, manager, session, request } = await setup()
    await writeFile(join(root, 'state'), 'file blocks directory')
    await expect(manager.run(session, request).next()).rejects.toThrow()
    expect(session.busy).toBe(false)
  })

  it('releases busy state after spawn throws', async () => {
    const { manager, session, request } = await setup()
    vi.mocked(spawn).mockImplementation(() => { throw new Error('spawn failed') })
    await expect(manager.run(session, request).next()).rejects.toThrow('spawn failed')
    expect(session.busy).toBe(false)
  })

  it('does not spawn after cancellation during directory setup', async () => {
    const { manager, session, controller, request } = await setup()
    vi.mocked(spawn).mockClear()
    const pending = manager.run(session, request).next()
    controller.abort()
    await expect(pending).rejects.toThrow('request aborted')
    expect(spawn).not.toHaveBeenCalled()
    expect(session.busy).toBe(false)
  })

  it.each(['invalid JSON', JSON.stringify({ type: 'error', message: 'failed turn' })])('terminates and waits after bad output: %s', async line => {
    const { manager, session, request } = await setup()
    const child = childProcess()
    let closed = false
    child.once('close', () => { closed = true })
    child.stdout.write(`${line}\n`)
    await expect(manager.run(session, request).next()).rejects.toThrow()
    expect(child.kill).toHaveBeenCalled()
    expect(closed).toBe(true)
    expect(session.busy).toBe(false)
  })

  it('terminates on early consumer return', async () => {
    const { manager, session, request } = await setup()
    const child = childProcess()
    child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thread' })}\n`)
    const stream = manager.run(session, request)
    await stream.next()
    await stream.return(undefined)
    expect(child.kill).toHaveBeenCalled()
    expect(session.busy).toBe(false)
    expect(session.threadId).toBeUndefined()
  })

  it.each(['error', 'stdin', 'stdout', 'stderr'])('handles %s failures without an unhandled rejection', async target => {
    const { manager, session, request } = await setup()
    const child = childProcess()
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => (target === 'error' ? child : child[target as 'stdin' | 'stdout' | 'stderr']).emit('error', new Error('broken pipe')))
      return child as never
    })
    await expect(manager.run(session, request).next()).rejects.toThrow('broken pipe')
    expect(child.kill).toHaveBeenCalled()
    expect(session.busy).toBe(false)
  })

  it('cancels a silent process and waits for close', async () => {
    const { manager, session, controller, request } = await setup()
    const child = childProcess()
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => controller.abort())
      return child as never
    })
    await expect(manager.run(session, request).next()).rejects.toThrow('request aborted')
    expect(child.kill).toHaveBeenCalled()
    expect(session.busy).toBe(false)
  })
})
