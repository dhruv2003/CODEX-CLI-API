import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestLifecycle } from '../src/lifecycle.js'

describe('graceful shutdown', () => {
  afterEach(() => { vi.useRealTimers() })

  it('waits for admitted work and usage persistence without cancelling it', async () => {
    const lifecycle = new RequestLifecycle()
    const server = createServer()
    await listen(server)
    const persistence = deferred()
    const operation = lifecycle.track(persistence.promise)
    let stopped = false
    const stopping = lifecycle.shutdown(server, 30_000).then(() => { stopped = true })
    expect(lifecycle.isStopping).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(stopped).toBe(false)
    expect(lifecycle.signal.aborted).toBe(false)
    persistence.resolve()
    await operation
    await stopping
    expect(lifecycle.signal.aborted).toBe(false)
    expect(server.listening).toBe(false)
  })

  it('cancels remaining work after the grace period and waits for its cleanup', async () => {
    const lifecycle = new RequestLifecycle()
    const server = createServer()
    await listen(server)
    vi.useFakeTimers()
    const persistence = deferred()
    const cancelled = deferred()
    const operation = lifecycle.track((async () => {
      await new Promise<void>(resolve => lifecycle.signal.addEventListener('abort', () => resolve(), { once: true }))
      cancelled.resolve()
      await persistence.promise
    })())
    const stopping = lifecycle.shutdown(server, 100)
    expect(lifecycle.shutdown(server, 100)).toBe(stopping)
    await vi.advanceTimersByTimeAsync(99)
    expect(lifecycle.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await cancelled.promise
    let stopped = false
    void stopping.then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    persistence.resolve()
    await operation
    await stopping
    expect(server.listening).toBe(false)
  })

  it('reports cleanup that exceeds the hard deadline', async () => {
    const lifecycle = new RequestLifecycle()
    const server = createServer()
    await listen(server)
    vi.useFakeTimers()
    const work = deferred()
    void lifecycle.track(work.promise)
    const stopping = lifecycle.shutdown(server, 100, 100)
    const result = expect(stopping).rejects.toThrow('shutdown cleanup timed out')
    await vi.advanceTimersByTimeAsync(200)
    await result
    work.resolve()
  })
})

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
