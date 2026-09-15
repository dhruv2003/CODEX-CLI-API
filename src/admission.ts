export interface AdmissionLimits {
  maxConcurrent: number
  maxConcurrentPerKey: number
  maxQueue: number
}

export interface AdmissionLease {
  release(): void
}

type AdmissionErrorCode = 'rate_limit' | 'queue_full' | 'aborted'

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode, readonly retryAfterSeconds?: number) {
    super(code === 'rate_limit' ? 'rate limit exceeded' : code === 'queue_full' ? 'request queue is full' : 'request aborted')
  }
}

interface WaitingRequest {
  keyId: string
  signal: AbortSignal
  resolve: (lease: AdmissionLease) => void
  reject: (error: AdmissionError) => void
  abort: () => void
}

export class AdmissionController {
  private active = 0
  private readonly activeByKey = new Map<string, number>()
  private readonly requestsByKey = new Map<string, number[]>()
  private readonly queue: WaitingRequest[] = []

  constructor(private readonly limits: AdmissionLimits) {}

  acquire(keyId: string, requestsPerMinute: number, signal: AbortSignal): Promise<AdmissionLease> {
    if (signal.aborted) return Promise.reject(new AdmissionError('aborted'))
    const now = Date.now()
    const requests = (this.requestsByKey.get(keyId) ?? []).filter(timestamp => timestamp > now - 60_000)
    this.requestsByKey.set(keyId, requests)
    if (requests.length >= requestsPerMinute) {
      return Promise.reject(new AdmissionError('rate_limit', Math.max(1, Math.ceil((requests[0]! + 60_000 - now) / 1000))))
    }
    if (this.canRun(keyId)) {
      requests.push(now)
      return Promise.resolve(this.grant(keyId))
    }
    if (this.queue.length >= this.limits.maxQueue) return Promise.reject(new AdmissionError('queue_full', 1))

    requests.push(now)
    return new Promise((resolve, reject) => {
      const waiting: WaitingRequest = {
        keyId,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiting)
          if (index >= 0) this.queue.splice(index, 1)
          reject(new AdmissionError('aborted'))
        },
      }
      signal.addEventListener('abort', waiting.abort, { once: true })
      this.queue.push(waiting)
    })
  }

  stats() {
    return { active: this.active, queued: this.queue.length, limits: { ...this.limits } }
  }

  private canRun(keyId: string): boolean {
    return this.active < this.limits.maxConcurrent && (this.activeByKey.get(keyId) ?? 0) < this.limits.maxConcurrentPerKey
  }

  private grant(keyId: string): AdmissionLease {
    this.active++
    this.activeByKey.set(keyId, (this.activeByKey.get(keyId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active--
        const keyActive = (this.activeByKey.get(keyId) ?? 1) - 1
        if (keyActive === 0) this.activeByKey.delete(keyId)
        else this.activeByKey.set(keyId, keyActive)
        this.drain()
      },
    }
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length && this.active < this.limits.maxConcurrent;) {
      const waiting = this.queue[index]!
      if (!this.canRun(waiting.keyId)) {
        index++
        continue
      }
      this.queue.splice(index, 1)
      waiting.signal.removeEventListener('abort', waiting.abort)
      waiting.resolve(this.grant(waiting.keyId))
    }
  }
}
