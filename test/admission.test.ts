import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdmissionController, AdmissionError } from '../src/admission.js'

describe('AdmissionController', () => {
  afterEach(() => { vi.useRealTimers() })

  it('queues work until both global and per-key capacity are available', async () => {
    const admission = new AdmissionController({ maxConcurrent: 2, maxConcurrentPerKey: 1, maxQueue: 20 })
    const first = await admission.acquire('key-a', 60, new AbortController().signal)
    const second = await admission.acquire('key-b', 60, new AbortController().signal)
    const queued = admission.acquire('key-a', 60, new AbortController().signal)

    expect(admission.stats()).toEqual({
      active: 2,
      queued: 1,
      limits: { maxConcurrent: 2, maxConcurrentPerKey: 1, maxQueue: 20 },
    })

    second.release()
    expect(admission.stats()).toMatchObject({ active: 1, queued: 1 })
    first.release()
    const lease = await queued
    expect(admission.stats()).toMatchObject({ active: 1, queued: 0 })
    lease.release()
    lease.release()
    expect(admission.stats()).toMatchObject({ active: 0, queued: 0 })
  })

  it('rejects work when the bounded queue is full', async () => {
    const admission = new AdmissionController({ maxConcurrent: 1, maxConcurrentPerKey: 1, maxQueue: 1 })
    const active = await admission.acquire('key-a', 60, new AbortController().signal)
    const queued = admission.acquire('key-b', 60, new AbortController().signal)

    await expect(admission.acquire('key-c', 60, new AbortController().signal)).rejects.toMatchObject({
      code: 'queue_full',
      retryAfterSeconds: 1,
    })

    active.release()
    ;(await queued).release()
  })

  it('enforces a rolling per-key minute and reports when to retry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T00:00:00.000Z'))
    const admission = new AdmissionController({ maxConcurrent: 1, maxConcurrentPerKey: 1, maxQueue: 20 })
    ;(await admission.acquire('key-a', 2, new AbortController().signal)).release()
    ;(await admission.acquire('key-a', 2, new AbortController().signal)).release()

    await expect(admission.acquire('key-a', 2, new AbortController().signal)).rejects.toMatchObject({
      code: 'rate_limit',
      retryAfterSeconds: 60,
    })

    vi.advanceTimersByTime(60_000)
    ;(await admission.acquire('key-a', 2, new AbortController().signal)).release()
  })

  it('removes and rejects queued work when its signal aborts', async () => {
    const admission = new AdmissionController({ maxConcurrent: 1, maxConcurrentPerKey: 1, maxQueue: 20 })
    const active = await admission.acquire('key-a', 60, new AbortController().signal)
    const controller = new AbortController()
    const queued = admission.acquire('key-b', 60, controller.signal)

    controller.abort()

    await expect(queued).rejects.toBeInstanceOf(AdmissionError)
    await expect(queued).rejects.toMatchObject({ code: 'aborted' })
    expect(admission.stats()).toMatchObject({ active: 1, queued: 0 })
    active.release()
  })
})
