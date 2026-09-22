import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadDesktopConfig } from '../src/desktop.js'
import { prepareConfig } from '../src/config.js'
import { createApp } from '../src/server.js'
import { codexChildEnv } from '../src/child-env.js'
import { spawn } from 'node:child_process'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-config-'))
  await mkdir(join(root, 'workspace'))
  return { CODEX_DESKTOP_DATA_DIR: join(root, 'settings'), CODEX_DESKTOP_WORKSPACE_ROOT: join(root, 'workspace'),
    CODEX_DESKTOP_CODEX_COMMAND: join(root, 'codex'), CODEX_DESKTOP_PUBLIC_DIR: resolve('src/public'),
    CODEX_DESKTOP_TOKEN: 'a'.repeat(64), CODEX_DESKTOP_PORT: '3081' }
}

describe('desktop runtime', () => {
  it('reports the actual EADDRINUSE error when the configured port really is occupied', async () => {
    const env = await fixture()
    const occupied = createServer()
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    const child = spawn(process.execPath, ['--import=tsx/esm', resolve('src/desktop.ts')], {
      env: { ...process.env, ...env, CODEX_DESKTOP_PORT: String(address.port), NODE_OPTIONS: '', NODE_PATH: '' },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', data => { errors += data })
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    const timer = setTimeout(() => child.kill(), 8000)
    try {
      expect(await exited).toBe(1)
      expect(errors).toContain('EADDRINUSE')
      expect(errors).not.toContain(env.CODEX_DESKTOP_TOKEN)
    } finally {
      clearTimeout(timer)
      child.kill()
      await new Promise<void>(resolve => occupied.close(() => resolve()))
    }
  }, 10000)
  it('does not pass desktop capabilities or Node injection hooks to Codex children', () => {
    const env = { CODEX_DESKTOP_DATA_DIR: '/private/app', CODEX_DESKTOP_TOKEN: 'secret', NODE_OPTIONS: '--require bad', NODE_PATH: '/bad', PATH: '/bin', HOME: '/user' }
    expect(codexChildEnv(env)).toEqual({ PATH: '/bin', HOME: '/user' })
    expect(env.CODEX_DESKTOP_TOKEN).toBe('secret')
  })
  it('uses only desktop settings and preserves stored credentials', async () => {
    const env = await fixture()
    const config = loadDesktopConfig({ ...env, HOST: '0.0.0.0', CODEX_COMMAND: 'evil', CODEX_MODELS: 'evil', CODEX_API_KEY_FILE: '/evil', PORT: '9999' })
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3081)
    expect(config.codexCommand).toBe(env.CODEX_DESKTOP_CODEX_COMMAND)
    expect(config.models).not.toContain('evil')
    expect(config.keyFile).toBe(join(env.CODEX_DESKTOP_DATA_DIR, 'api-keys.json'))
    await prepareConfig(config)
    await writeFile(config.keyFile, 'preserved')
    await prepareConfig(config)
    expect(await readFile(config.keyFile, 'utf8')).toBe('preserved')
  })
  it('rejects missing token, relative paths, invalid port and overlapping credentials', async () => {
    const env = await fixture()
    expect(() => loadDesktopConfig({ ...env, CODEX_DESKTOP_TOKEN: '' })).toThrow('token')
    expect(() => loadDesktopConfig({ ...env, CODEX_DESKTOP_DATA_DIR: 'relative' })).toThrow('absolute')
    expect(() => loadDesktopConfig({ ...env, CODEX_DESKTOP_PORT: '65536' })).toThrow('port')
    expect(() => loadDesktopConfig({ ...env, CODEX_DESKTOP_DATA_DIR: env.CODEX_DESKTOP_WORKSPACE_ROOT })).toThrow('overlap')
  })
  it('protects admin routes while retaining authenticated API access and public assets', async () => {
    const config = loadDesktopConfig(await fixture())
    await prepareConfig(config)
    const server = createServer(createApp({ config }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const url = `http://127.0.0.1:${address.port}`
    const headers = { 'X-Codex-Admin': 'local', 'X-Codex-Desktop-Token': config.desktopAdminToken! }
    try {
      for (const path of ['/admin/config', '/ADMIN/config', '/admin/api-keys', '/admin/setup', '/admin/metrics', '/admin/requests']) {
        expect((await fetch(url + path, { headers: { 'X-Codex-Admin': 'local' } })).status).toBe(403)
        expect((await fetch(url + path, { headers })).status).toBe(200)
      }
      expect((await fetch(url + '/admin/config', { headers: { ...headers, 'X-Codex-Desktop-Token': 'b'.repeat(64) } })).status).toBe(403)
      const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
        get(url + '/admin/config', { headers: { ...headers, Host: 'evil.example' } }, response => {
          response.resume()
          resolve(response.statusCode)
        }).on('error', reject)
      })
      expect(foreignHostStatus).toBe(403)
      expect((await fetch(url + '/admin/config', { headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403)
      expect((await fetch(url + '/admin/config', { headers: { ...headers, Origin: url } })).status).toBe(200)
      expect((await fetch(url + '/admin/app.js')).status).toBe(200)
      expect((await fetch(url + '/')).status).toBe(200)
      expect((await fetch(url + '/v1/models')).status).toBe(401)
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
