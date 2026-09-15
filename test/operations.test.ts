import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'
import { CodexSessionManager } from '../src/codex.js'
import { createApp } from '../src/server.js'
import { RequestLifecycle } from '../src/lifecycle.js'

describe('production controls', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('honors valid client request IDs and replaces invalid ones', async () => {
    const fixture = await startFixture()
    try {
      const valid = await fetch(`${fixture.url}/healthz`, { headers: { 'x-client-request-id': 'client_ABC-123' } })
      expect(valid.headers.get('x-request-id')).toBe('client_ABC-123')
      const invalid = await fetch(`${fixture.url}/healthz`, { headers: { 'x-client-request-id': 'bad request id' } })
      expect(invalid.headers.get('x-request-id')).toMatch(/^req_[0-9a-f-]{36}$/)
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('rate-limits generation requests and records successful usage', async () => {
    const fixture = await startFixture({ requestsPerMinute: 1 })
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* () {
      yield { type: 'usage', inputTokens: 7, outputTokens: 11 }
      yield { type: 'done' }
    })
    try {
      const first = await chat(fixture, 'hello')
      expect(first.status).toBe(200)
      const limited = await chat(fixture, 'again')
      expect(limited.status).toBe(429)
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
      expect(await limited.json()).toEqual({
        error: { message: 'rate limit exceeded', type: 'rate_limit_error', param: null, code: 'rate_limit_exceeded' },
      })
      expect((await fixture.keys.list())[0]).toMatchObject({ requestCount: 1, inputTokens: 7, outputTokens: 11, failureCount: 0 })
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('records admitted failures and returns a pre-stream timeout as 504', async () => {
    const fixture = await startFixture({ requestTimeoutMs: 10 })
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* (_session, request) {
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    })
    try {
      const response = await chat(fixture, 'timeout')
      expect(response.status).toBe(504)
      expect(await response.json()).toEqual({
        error: { message: 'request timed out', type: 'server_error', param: null, code: 'timeout' },
      })
      expect((await fixture.keys.list())[0]).toMatchObject({ requestCount: 1, failureCount: 1 })
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('reports readiness and sanitized aggregate admin metrics', async () => {
    const fixture = await startFixture()
    try {
      expect(await (await fetch(`${fixture.url}/readyz`)).json()).toEqual({
        ok: true,
        capacity: { active: 0, queued: 0, limits: { maxConcurrent: 2, maxConcurrentPerKey: 1, maxQueue: 20 } },
      })
      const response = await fetch(`${fixture.url}/admin/metrics`, { headers: { 'x-codex-admin': 'local' } })
      expect(response.status).toBe(200)
      const metrics = await response.json()
      expect(metrics).toEqual({
        capacity: { active: 0, queued: 0, limits: { maxConcurrent: 2, maxConcurrentPerKey: 1, maxQueue: 20 } },
        keys: { total: 1, active: 1, requestCount: 0, inputTokens: 0, outputTokens: 0, failureCount: 0 },
      })
      expect(JSON.stringify(metrics)).not.toContain(fixture.created.key)
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('returns 503 readiness when a required writable directory is missing', async () => {
    const fixture = await startFixture({ prepareDirs: false })
    try {
      const response = await fetch(`${fixture.url}/readyz`)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ ok: false })
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('preserves a successful response when durable usage persistence fails', async () => {
    const fixture = await startFixture()
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* () {
      yield { type: 'message', text: 'still works' }
      yield { type: 'done' }
    })
    vi.spyOn(fixture.keys, 'recordUsage').mockRejectedValue(new Error('sensitive registry detail'))
    try {
      const response = await chat(fixture, 'hello')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'still works' } }] })
      expect(fixture.keys.recordUsage).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('releases admission capacity after a runner failure', async () => {
    const fixture = await startFixture({ maxConcurrent: 1 })
    let calls = 0
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* () {
      if (calls++ === 0) throw new Error('runner failed')
      yield { type: 'message', text: 'recovered' }
      yield { type: 'done' }
    })
    try {
      expect((await chat(fixture, 'fail')).status).toBe(502)
      const recovered = await chat(fixture, 'retry')
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toMatchObject({ choices: [{ message: { content: 'recovered' } }] })
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('emits a valid SSE timeout error after streaming starts', async () => {
    const fixture = await startFixture({ requestTimeoutMs: 10 })
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* (_session, request) {
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    })
    try {
      const response = await chat(fixture, 'timeout', fixture.created.key, true)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      expect(await response.text()).toContain('"code":"timeout"')
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('returns 429 when global capacity and the waiting queue are full', async () => {
    const fixture = await startFixture({ maxConcurrent: 1, maxQueue: 1 })
    const secondKey = await fixture.keys.create('second')
    const thirdKey = await fixture.keys.create('third')
    let startFirst!: () => void
    const started = new Promise<void>(resolve => { startFirst = resolve })
    let releaseRuns!: () => void
    const runsReleased = new Promise<void>(resolve => { releaseRuns = resolve })
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* () {
      startFirst()
      await runsReleased
      yield { type: 'done' }
    })
    try {
      const first = chat(fixture, 'first')
      await started
      const second = chat(fixture, 'second', secondKey.key)
      await waitForQueued(fixture.url)
      const rejected = await chat(fixture, 'third', thirdKey.key)
      expect(rejected.status).toBe(429)
      expect(await rejected.json()).toMatchObject({ error: { code: 'queue_full' } })
      releaseRuns()
      expect((await first).status).toBe(200)
      expect((await second).status).toBe(200)
    } finally {
      releaseRuns()
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('removes an aborted queued request and admits later work', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fixture = await startFixture({ maxConcurrent: 1 })
    const queuedKey = await fixture.keys.create('queued')
    let startedFirst!: () => void
    const firstStarted = new Promise<void>(resolve => { startedFirst = resolve })
    let releaseFirst!: () => void
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* () {
      if (calls++ === 0) {
        startedFirst()
        await firstReleased
      }
      yield { type: 'done' }
    })
    const controller = new AbortController()
    try {
      const first = chat(fixture, 'first')
      await firstStarted
      const queued = chat(fixture, 'secret queued prompt', queuedKey.key, false, controller.signal)
      await waitForCapacity(fixture.url, 1, 1)
      controller.abort()
      await expect(queued).rejects.toThrow()
      await waitForCapacity(fixture.url, 1, 0)
      releaseFirst()
      expect((await first).status).toBe(200)
      expect((await chat(fixture, 'later', queuedKey.key)).status).toBe(200)
      await waitForCapacity(fixture.url, 0, 0)
      expectAbortedLog(log, queuedKey.key, 'secret queued prompt')
    } finally {
      releaseFirst()
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('releases a running request on disconnect and admits later work', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixture = await startFixture({ maxConcurrent: 1 })
    let calls = 0
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* (_session, request) {
      if (calls++ === 0) {
        await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      yield { type: 'done' }
    })
    const controller = new AbortController()
    try {
      const running = await chat(fixture, 'secret running prompt', fixture.created.key, true, controller.signal)
      expect(running.status).toBe(200)
      controller.abort()
      await running.text().catch(() => '')
      await waitForCapacity(fixture.url, 0, 0)
      expect((await chat(fixture, 'later')).status).toBe(200)
      await waitForCapacity(fixture.url, 0, 0)
      expectAbortedLog(log, fixture.created.key, 'secret running prompt')
      expect(errors.mock.calls.map(call => JSON.parse(call[0]))).toEqual([
        { event: 'generation_failed', requestId: expect.any(String), category: 'client_aborted' },
      ])
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('accepts and validates key expiry and rate policy in admin routes', async () => {
    const fixture = await startFixture()
    const headers = { 'Content-Type': 'application/json', 'x-codex-admin': 'local' }
    try {
      const created = await fetch(`${fixture.url}/admin/api-keys`, {
        method: 'POST', headers, body: JSON.stringify({ name: 'limited', workspaceRoot: fixture.root, expiresAt: null, requestsPerMinute: 12 }),
      })
      expect(created.status).toBe(201)
      const createdBody = await created.json() as { id: string }
      expect((await fixture.keys.list()).find(key => key.id === createdBody.id)).toMatchObject({ expiresAt: null, requestsPerMinute: 12 })

      const expiresAt = '2030-01-01T00:00:00.000Z'
      const patched = await fetch(`${fixture.url}/admin/api-keys/${createdBody.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ active: false, expiresAt, requestsPerMinute: 30 }),
      })
      expect(await patched.json()).toMatchObject({ active: false, expiresAt, requestsPerMinute: 30 })

      const invalid = await fetch(`${fixture.url}/admin/api-keys/${createdBody.id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ requestsPerMinute: 0 }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('drains an admitted response and persists usage before shutdown completes', async () => {
    const fixture = await startFixture()
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* (_session, request) {
      started()
      await completion
      expect(request.signal.aborted).toBe(false)
      yield { type: 'message', text: 'finished during shutdown' }
      yield { type: 'usage', inputTokens: 2, outputTokens: 3 }
    })
    try {
      const response = chat(fixture, 'hello')
      await running
      const stopping = fixture.lifecycle.shutdown(fixture.server)
      finish()
      expect(await (await response).json()).toMatchObject({ choices: [{ message: { content: 'finished during shutdown' } }] })
      await stopping
      expect((await fixture.keys.list())[0]).toMatchObject({ requestCount: 1, inputTokens: 2, outputTokens: 3, failureCount: 0 })
    } finally {
      finish()
      if (fixture.server.listening) await fixture.lifecycle.shutdown(fixture.server)
    }
  })

  it('cancels running and queued requests at the shutdown deadline', async () => {
    const fixture = await startFixture({ maxConcurrent: 1 })
    const queuedKey = await fixture.keys.create('queued')
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    let cancelled = false
    let calls = 0
    vi.spyOn(fixture.sessions, 'run').mockImplementation(async function* (_session, request) {
      calls++
      started()
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => {
        cancelled = true
        reject(new Error('aborted'))
      }, { once: true }))
    })
    const first = chat(fixture, 'first').catch(() => undefined)
    await running
    const queued = chat(fixture, 'second', queuedKey.key).catch(() => undefined)
    await waitForCapacity(fixture.url, 1, 1)
    try {
      await fixture.lifecycle.shutdown(fixture.server, 10)
      await Promise.all([first, queued])
      expect(cancelled).toBe(true)
      expect(calls).toBe(1)
      expect((await fixture.keys.list()).find(key => key.id === fixture.created.id)).toMatchObject({ requestCount: 1, failureCount: 1 })
      expect((await fixture.keys.list()).find(key => key.id === queuedKey.id)).toMatchObject({ requestCount: 0 })
    } finally {
      if (fixture.server.listening) await fixture.lifecycle.shutdown(fixture.server)
    }
  })
})

async function startFixture(options: { requestsPerMinute?: number; requestTimeoutMs?: number; maxConcurrent?: number; maxQueue?: number; prepareDirs?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-operations-'))
  const keyFile = join(root, 'keys.json')
  const keys = new ApiKeyStore(keyFile)
  const created = await keys.create('test', { requestsPerMinute: options.requestsPerMinute })
  const codexStateRoot = join(root, 'codex-users')
  if (options.prepareDirs !== false) await mkdir(codexStateRoot, { recursive: true })
  const config = {
    port: 0,
    host: '127.0.0.1',
    codexCommand: 'codex',
    codexStateRoot,
    workspaceRoot: root,
    keyFile,
    models: ['gpt-5.4'],
    imageModels: [],
    modelEfforts: { 'gpt-5.4': ['low'] },
    maxConcurrent: options.maxConcurrent ?? 2,
    maxConcurrentPerKey: 1,
    maxQueue: options.maxQueue ?? 20,
    requestTimeoutMs: options.requestTimeoutMs ?? 600_000,
  }
  const sessions = new CodexSessionManager(config)
  const lifecycle = new RequestLifecycle()
  const server = createServer(createApp({ config, keys, sessions, lifecycle }))
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  return { server, url: `http://127.0.0.1:${address.port}`, root, keys, created, sessions, lifecycle }
}

function chat(fixture: Awaited<ReturnType<typeof startFixture>>, message: string, key = fixture.created.key, stream = false, signal?: AbortSignal) {
  return fetch(`${fixture.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: message }], stream }),
    signal,
  })
}

async function waitForQueued(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const metrics = await (await fetch(`${url}/admin/metrics`, { headers: { 'x-codex-admin': 'local' } })).json() as { capacity: { queued: number } }
    if (metrics.capacity.queued === 1) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('request did not enter the admission queue')
}

async function waitForCapacity(url: string, active: number, queued: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const metrics = await (await fetch(`${url}/admin/metrics`, { headers: { 'x-codex-admin': 'local' } })).json() as { capacity: { active: number; queued: number } }
    if (metrics.capacity.active === active && metrics.capacity.queued === queued) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`capacity did not reach active=${active}, queued=${queued}`)
}

function expectAbortedLog(log: ReturnType<typeof vi.spyOn>, rawKey: string, prompt: string): void {
  const aborted = log.mock.calls
    .map(call => typeof call[0] === 'string' ? JSON.parse(call[0]) as Record<string, unknown> : {})
    .filter(entry => entry.outcome === 'aborted')
  expect(aborted).toHaveLength(1)
  expect(Object.keys(aborted[0]!)).toEqual(['requestId', 'method', 'path', 'status', 'durationMs', 'apiKeyId', 'outcome'])
  expect(JSON.stringify(aborted[0])).not.toContain(rawKey)
  expect(JSON.stringify(aborted[0])).not.toContain(prompt)
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
}
