import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { codexChildEnv } from './child-env.js'
import { resolve } from 'node:path'
import type { AppConfig } from './config.js'

export interface LoginState {
  status: 'idle' | 'starting' | 'waiting' | 'success' | 'failed' | 'cancelled'
  message: string
  url?: string
  code?: string
}

interface Attempt {
  state: LoginState
  child?: ChildProcess
  timer?: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

/** Device login output is transient. Only the official URL and user code leave this class. */
export class CodexLoginManager {
  private readonly attempts = new Map<string, Attempt>()
  constructor(private readonly config: AppConfig) {}

  get hasRunningLogin(): boolean { return [...this.attempts.values()].some(attempt => !attempt.closed) }

  get(keyId: string): LoginState {
    return { ...(this.attempts.get(keyId)?.state ?? { status: 'idle', message: 'Sign in to Codex for this key.' }) }
  }

  isRunning(keyId: string): boolean {
    const attempt = this.attempts.get(keyId)
    return attempt !== undefined && !attempt.closed
  }

  async start(keyId: string): Promise<LoginState> {
    if (!/^key_[0-9a-f]{16}$/.test(keyId)) throw new Error('Invalid key ID')
    if (this.isRunning(keyId)) return this.get(keyId)
    if ([...this.attempts.values()].some(attempt => !attempt.closed)) {
      return { status: 'failed', message: 'Finish or cancel the other Codex sign-in first.' }
    }
    const attempt: Attempt = { state: { status: 'starting', message: 'Starting Codex sign-in…' }, closed: false }
    this.attempts.set(keyId, attempt)
    const home = resolve(this.config.codexStateRoot, keyId)
    try {
      await mkdir(home, { recursive: true, mode: 0o700 })
      if (attempt.state.status === 'cancelled') { attempt.closed = true; return this.get(keyId) }
      const child = spawn(this.config.codexCommand, ['login', '--device-auth'], {
        shell: false, windowsHide: true, cwd: home,
        env: { ...codexChildEnv(), CODEX_HOME: home, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      attempt.child = child
      let output = ''
      const consume = (chunk: Buffer): void => {
        if (!['starting', 'waiting'].includes(attempt.state.status)) return
        output = (output + chunk.toString()).slice(-8192).replace(/\x1b\[[0-9;]*m/g, '')
        const url = output.match(/https:\/\/auth\.openai\.com\/codex\/device\b/)?.[0]
        const code = output.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/)?.[0]
        if (url && code) attempt.state = {
          status: 'waiting', message: 'Open the sign-in page and enter this one-time code.', url, code,
        }
      }
      child.stdout?.on('data', consume)
      child.stderr?.on('data', consume)
      child.once('error', () => {
        attempt.state = { status: 'failed', message: 'Could not start Codex. Check that the CLI is installed and try the terminal command below.' }
      })
      child.once('close', code => {
        attempt.closed = true
        clearTimeout(attempt.timer)
        clearTimeout(attempt.killTimer)
        output = ''
        if (['cancelled', 'failed'].includes(attempt.state.status)) return
        attempt.state = code === 0
          ? { status: 'success', message: 'Codex sign-in completed. Test the connection next.' }
          : { status: 'failed', message: 'Sign-in did not finish. Retry, enable device-code login in your account settings if needed, or use the terminal command below.' }
      })
      attempt.timer = setTimeout(() => {
        attempt.state = { status: 'failed', message: 'Sign-in expired. Start again to get a new code.' }
        this.stop(attempt)
      }, 15 * 60_000)
      attempt.timer.unref()
    } catch {
      attempt.closed = true
      attempt.state = { status: 'failed', message: 'Could not prepare the Codex login directory. Check the server configuration.' }
    }
    return this.get(keyId)
  }

  cancel(keyId: string): LoginState {
    const attempt = this.attempts.get(keyId)
    if (attempt && !attempt.closed) {
      attempt.state = { status: 'cancelled', message: 'Sign-in cancelled.' }
      this.stop(attempt)
    }
    return this.get(keyId)
  }

  dispose(): void {
    for (const keyId of this.attempts.keys()) this.cancel(keyId)
  }

  private stop(attempt: Attempt): void {
    clearTimeout(attempt.timer)
    if (!attempt.child) return
    attempt.child.kill('SIGTERM')
    attempt.killTimer = setTimeout(() => {
      if (!attempt.closed) attempt.child?.kill('SIGKILL')
    }, 1000)
    attempt.killTimer.unref()
  }
}
