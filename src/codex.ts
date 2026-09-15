import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { codexChildEnv } from './child-env.js'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { AppConfig } from './config.js'
import { isInsideWorkspace } from './security.js'

export interface Session {
  id: string
  cwd: string
  apiKeyId: string
  codexHome: string
  threadId?: string
  busy: boolean
}

export interface RunRequest {
  message: string
  model: string
  reasoningEffort?: string
  sandbox: 'read-only' | 'workspace-write'
  images: string[]
  signal: AbortSignal
}

export type CodexStreamEvent =
  | { type: 'thread'; threadId: string }
  | { type: 'message'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'done' }

function effortArgs(effort: string | undefined): string[] {
  return effort === undefined ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`]
}

function imageArgs(images: string[]): string[] {
  return images.flatMap(image => ['--image', image])
}

function argsFor(session: Session, request: RunRequest): string[] {
  const common = ['--json', '--model', request.model]
  const extras = [...effortArgs(request.reasoningEffort), ...imageArgs(request.images), '-']
  return session.threadId === undefined
    ? ['exec', ...common, '--sandbox', request.sandbox, '--cd', session.cwd, '--skip-git-repo-check', ...extras]
    : ['exec', 'resume', session.threadId, ...common, '-c', `sandbox_mode=${JSON.stringify(request.sandbox)}`, '--skip-git-repo-check', ...extras]
}

export class CodexSessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly retiringKeyIds = new Set<string>()
  private readonly unterminatedSessions = new Set<Session>()

  constructor(private readonly config: AppConfig) {}

  get hasUnterminatedProcesses(): boolean {
    return this.unterminatedSessions.size > 0
  }

  create(cwd: string, apiKeyId: string): Session {
    if (this.retiringKeyIds.has(apiKeyId)) throw new Error('API key is being deleted')
    this.assertNoUnterminatedProcess(apiKeyId)
    const codexHome = resolve(this.config.codexStateRoot, apiKeyId)
    if (!isInsideWorkspace(this.config.codexStateRoot, codexHome) || codexHome === resolve(this.config.codexStateRoot)) throw new Error('invalid API key state directory')
    const session: Session = { id: crypto.randomUUID(), cwd, apiKeyId, codexHome, busy: false }
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string, apiKeyId: string): Session | undefined {
    const session = this.sessions.get(id)
    return session?.apiKeyId === apiKeyId ? session : undefined
  }

  delete(id: string, apiKeyId: string): boolean {
    const session = this.get(id, apiKeyId)
    return session !== undefined && !session.busy && this.sessions.delete(id)
  }

  tryRetireKey(apiKeyId: string): boolean {
    if ([...this.sessions.values()].some(session => session.apiKeyId === apiKeyId && session.busy)) return false
    this.retiringKeyIds.add(apiKeyId)
    return true
  }

  isKeyRetired(apiKeyId: string): boolean {
    return this.retiringKeyIds.has(apiKeyId)
  }

  restoreKey(apiKeyId: string): void {
    this.retiringKeyIds.delete(apiKeyId)
  }

  finalizeKeyDeletion(apiKeyId: string): void {
    for (const [id, session] of this.sessions) if (session.apiKeyId === apiKeyId) this.sessions.delete(id)
  }

  async *run(session: Session, request: RunRequest): AsyncGenerator<CodexStreamEvent> {
    if (this.retiringKeyIds.has(session.apiKeyId)) throw new Error('API key is being deleted')
    this.assertNoUnterminatedProcess(session.apiKeyId)
    if (session.busy) throw new Error('session already has a running request')
    if (request.signal.aborted) throw new Error('request aborted')
    session.busy = true
    let closed = true
    let finished = false
    let cleanup: (() => Promise<void>) | undefined
    try {
      await mkdir(session.codexHome, { recursive: true, mode: 0o700 })
      if (request.signal.aborted) throw new Error('request aborted')
      const child = spawn(this.config.codexCommand, argsFor(session, request), {
        cwd: session.cwd,
        env: { ...codexChildEnv(), CODEX_HOME: session.codexHome },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      closed = false
      let stderr = ''
      let newThreadId: string | undefined
      child.stderr?.on('data', chunk => {
        stderr = `${stderr}${String(chunk)}`.slice(-4_000)
      })
      let fail!: (error: Error) => void
      const failed = new Promise<never>((_resolve, reject) => { fail = reject })
      // Errors may arrive while the consumer is paused at a yielded event.
      void failed.catch(() => {})
      const exited = new Promise<number>(resolveExit => {
        child.once('close', code => {
          closed = true
          this.unterminatedSessions.delete(session)
          if (finished) session.busy = false
          resolveExit(code ?? 1)
        })
      })
      let stopping: Promise<void> | undefined
      const stop = (): Promise<void> => stopping ??= (async () => {
        if (closed) return
        child.kill('SIGTERM')
        if (await waitForExit(exited, 1_000)) return
        child.kill('SIGKILL')
        if (!await waitForExit(exited, 1_000)) throw new Error('Codex CLI did not terminate')
      })()
      const abort = (): void => {
        fail(new Error('request aborted'))
        void stop().catch(fail)
      }
      cleanup = async () => {
        request.signal.removeEventListener('abort', abort)
        await stop()
      }
      child.on('error', fail)
      child.stdin.on('error', fail)
      child.stdout.on('error', fail)
      child.stderr.on('error', fail)
      request.signal.addEventListener('abort', abort, { once: true })
      if (request.signal.aborted) abort()
      else child.stdin.end(request.message)
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
      const iterator = lines[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await Promise.race([iterator.next(), failed])
          if (next.done) break
          const line = next.value
          const event: unknown = JSON.parse(line)
          if (typeof event !== 'object' || event === null || !('type' in event)) continue
          const type = String(event.type)
          if (type === 'thread.started' && 'thread_id' in event && typeof event.thread_id === 'string') {
            newThreadId = event.thread_id
            yield { type: 'thread', threadId: event.thread_id }
          } else if (type === 'item.completed' && 'item' in event && typeof event.item === 'object' && event.item !== null
            && 'type' in event.item && event.item.type === 'agent_message' && 'text' in event.item && typeof event.item.text === 'string') {
            yield { type: 'message', text: event.item.text }
          } else if (type === 'turn.completed') {
            if ('usage' in event && typeof event.usage === 'object' && event.usage !== null) {
              const usage = event.usage as { input_tokens?: unknown; output_tokens?: unknown }
              yield { type: 'usage', inputTokens: numberOrUndefined(usage.input_tokens), outputTokens: numberOrUndefined(usage.output_tokens) }
            }
            yield { type: 'done' }
          } else if (type === 'turn.failed' || type === 'error') {
            throw new Error(errorMessage(event))
          }
        }
      } finally {
        lines.close()
      }
      const code = await Promise.race([exited, failed])
      if (request.signal.aborted) throw new Error('request aborted')
      if (code !== 0) throw new Error(`Codex CLI exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`)
      if (newThreadId !== undefined) session.threadId = newThreadId
    } finally {
      try {
        await cleanup?.()
      } finally {
        finished = true
        session.busy = !closed
        if (!closed) this.unterminatedSessions.add(session)
      }
    }
  }

  private assertNoUnterminatedProcess(apiKeyId: string): void {
    if ([...this.unterminatedSessions].some(session => session.apiKeyId === apiKeyId)) {
      throw new Error('API key has an unterminated process')
    }
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

async function waitForExit(exited: Promise<number>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise<false>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), milliseconds) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function errorMessage(value: object & { message?: unknown }): string {
  return typeof value.message === 'string' ? value.message : 'Codex CLI reported a failed turn'
}
