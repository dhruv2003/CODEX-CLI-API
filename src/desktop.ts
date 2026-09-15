import { chmod, mkdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { loadConfig, prepareConfig, type AppConfig } from './config.js'
import { createApp } from './server.js'
import { CodexSessionManager } from './codex.js'
import { RequestLifecycle } from './lifecycle.js'
import type { CodexLoginManager } from './login.js'
import { migrateLegacyDesktop } from './desktop-migration.js'

export function loadDesktopConfig(env: NodeJS.ProcessEnv): AppConfig {
  const absolute = (name: string): string => {
    const value = env[name]
    if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
    return value
  }
  const data = absolute('CODEX_DESKTOP_DATA_DIR')
  const port = Number(env.CODEX_DESKTOP_PORT ?? '3081')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid desktop port')
  const token = env.CODEX_DESKTOP_TOKEN ?? ''
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('Invalid desktop admin token')
  return {
    ...loadConfig({ PORT: String(port), HOST: '127.0.0.1',
      CODEX_COMMAND: absolute('CODEX_DESKTOP_CODEX_COMMAND'),
      CODEX_STATE_ROOT: join(data, 'codex-users'), CODEX_API_KEY_FILE: join(data, 'api-keys.json'),
      CODEX_WORKSPACE_ROOT: absolute('CODEX_DESKTOP_WORKSPACE_ROOT'),
      CODEX_SHUTDOWN_GRACE_MS: '1000',
    }),
    publicDirectory: absolute('CODEX_DESKTOP_PUBLIC_DIR'), desktopAdminToken: token,
  }
}

export async function startDesktop(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadDesktopConfig(env)
  if (!(await stat(config.workspaceRoot)).isDirectory()) throw new Error('Workspace must be an existing directory')
  const dataDirectory = env.CODEX_DESKTOP_DATA_DIR!
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  await prepareConfig(config)
  if (process.platform !== 'win32') await chmod(dataDirectory, 0o700)
  const migration = await migrateLegacyDesktop({ dataDirectory, workspaceRoot: config.workspaceRoot })
  const lifecycle = new RequestLifecycle()
  const sessions = new CodexSessionManager(config)
  const app = createApp({ config, lifecycle, sessions })
  app.locals.desktopMigration = migration
  const server = createServer(app)
  const input = createInterface({ input: process.stdin })
  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    input.close()
    process.stdin.pause()
    ;(app.locals.loginManager as CodexLoginManager).dispose()
    void lifecycle.shutdown(server, config.shutdownGraceMs).then(() => {
      if (sessions.hasUnterminatedProcesses) throw new Error('Codex process did not terminate')
    }).catch(() => { process.exitCode = 1 })
  }
  input.on('line', line => { if (line.trim() === 'shutdown') shutdown() })
  input.on('close', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.once('error', () => { process.exitCode = 1; shutdown() })
  server.listen(config.port, '127.0.0.1', () => {
    if (stopping) { server.close(); return }
    console.log(JSON.stringify({ event: 'desktop_ready', port: config.port }))
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startDesktop().catch(error => {
    console.error(JSON.stringify({ event: 'desktop_error', message: error instanceof Error ? error.message : 'Desktop startup failed' }))
    process.exitCode = 1
  })
}
