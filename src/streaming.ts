import type { Writable } from 'node:stream'

export async function writeStream(stream: Writable, chunk: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (stream.destroyed || stream.writableEnded) throw new Error('stream closed')
  if (stream.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener('drain', drained)
      stream.removeListener('close', closed)
      stream.removeListener('error', errored)
      signal?.removeEventListener('abort', aborted)
    }
    const drained = (): void => { cleanup(); resolve() }
    const errored = (error: Error): void => { cleanup(); reject(error) }
    const closed = (): void => { errored(new Error('stream closed')) }
    const aborted = (): void => { errored(new Error('stream aborted')) }
    stream.once('drain', drained)
    stream.once('close', closed)
    stream.once('error', errored)
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted) aborted()
    else if (stream.destroyed || stream.writableEnded) closed()
  })
}
