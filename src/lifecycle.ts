import type { Server } from 'node:http'

export class RequestLifecycle {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private stopping?: Promise<void>

  get signal(): AbortSignal { return this.controller.signal }
  get isStopping(): boolean { return this.stopping !== undefined }
  get pendingCount(): number { return this.pending.size }

  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation))
    return operation
  }

  shutdown(server: Server, graceMs = 30_000, cleanupMs = 10_000): Promise<void> {
    this.stopping ??= this.stop(server, graceMs, cleanupMs)
    return this.stopping
  }

  private async stop(server: Server, graceMs: number, cleanupMs: number): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())
    })
    // Include handlers still persisting usage after a client disconnected.
    const finished = closed.then(async () => {
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
    })
    if (await completesWithin(finished, graceMs)) return
    this.controller.abort()
    server.closeAllConnections()
    if (!await completesWithin(finished, cleanupMs)) throw new Error('shutdown cleanup timed out')
  }
}

async function completesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
