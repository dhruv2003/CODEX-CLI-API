import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { writeStream } from '../src/streaming.js'

it('waits for a slow consumer before accepting more stream output', async () => {
  const stream = new PassThrough({ highWaterMark: 1 })
  let done = false
  const writing = writeStream(stream, 'payload').then(() => { done = true })
  await Promise.resolve()
  expect(done).toBe(false)
  stream.resume()
  await writing
  expect(done).toBe(true)
  expect(stream.listenerCount('drain')).toBe(0)
  stream.destroy()
})

it.each(['disconnect', 'abort'] as const)('stops waiting on %s and cleans listeners', async outcome => {
  const stream = new PassThrough({ highWaterMark: 1 })
  const controller = new AbortController()
  const writing = writeStream(stream, 'payload', controller.signal)
  const rejection = expect(writing).rejects.toThrow()
  if (outcome === 'disconnect') stream.destroy()
  else controller.abort()
  await rejection
  expect(stream.listenerCount('drain')).toBe(0)
  expect(stream.listenerCount('error')).toBe(0)
  stream.destroy()
})

it('sanitizes session failures and preserves route-specific validation contracts', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createServer } = await import('node:http')
  const { ApiKeyStore } = await import('../src/auth.js')
  const { CodexSessionManager } = await import('../src/codex.js')
  const { createApp } = await import('../src/server.js')
  const { vi } = await import('vitest')
  const root = await mkdtemp(join(tmpdir(), 'stream-contract-'))
  const config = { port: 0, host: '127.0.0.1', codexCommand: 'codex', codexStateRoot: root,
    workspaceRoot: root, keyFile: join(root, 'keys.json'), models: ['test-model'], imageModels: [], modelEfforts: { 'test-model': ['low'] } }
  const keys = new ApiKeyStore(config.keyFile)
  const key = await keys.create('test')
  const sessions = new CodexSessionManager(config)
  const session = sessions.create(root, key.id)
  const run = vi.spyOn(sessions, 'run').mockImplementation(async function* () { throw new Error('secret CLI stderr credential') })
  const server = createServer(createApp({ config, keys, sessions }))
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    const response = await post(`/v1/sessions/${session.id}/messages`, { message: 'hello' })
    expect(await response.text()).toBe('event: error\ndata: {"error":"Codex CLI request failed"}\n\n')
    expect(run.mock.calls[0]?.[1].model).toBe('test-model')
    const cases = [
      [`/v1/sessions/${session.id}/messages`, { message: 'hello', reasoningEffort: 'bad' }, 'reasoningEffort'],
      ['/v1/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'bad' }, 'reasoning_effort'],
      ['/v1/responses', { input: 'hello', reasoning: { effort: 'bad' } }, 'reasoning.effort'],
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }, 'model'],
    ] as const
    for (const [path, body, param] of cases) {
      const invalid = await post(path, body)
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toMatchObject({ error: { param, code: 'invalid_value', type: 'invalid_request_error' } })
    }
  } finally {
    run.mockRestore()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    await rm(root, { recursive: true, force: true })
  }
})

it('does not write after cancellation and propagates a blocked writable error', async () => {
  const controller = new AbortController()
  controller.abort()
  const stream = new PassThrough({ highWaterMark: 1 })
  await expect(writeStream(stream, 'unused', controller.signal)).rejects.toThrow()
  expect(stream.writableLength).toBe(0)
  const writing = writeStream(stream, 'payload')
  const rejection = expect(writing).rejects.toThrow('write failed')
  stream.destroy(new Error('write failed'))
  await rejection
  expect(stream.listenerCount('drain')).toBe(0)
})
