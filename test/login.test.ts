import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexLoginManager } from '../src/login.js'
import { loadConfig } from '../src/config.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
const keyId = 'key_0123456789abcdef'
const managers: CodexLoginManager[] = []
afterEach(() => { managers.forEach(manager => manager.dispose()); managers.length = 0; vi.clearAllMocks() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-login-'))
  const manager = new CodexLoginManager(loadConfig({ CODEX_STATE_ROOT: directory }))
  managers.push(manager)
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(() => { child.emit('close', 1); return true }),
  })
  vi.mocked(spawn).mockReturnValue(child as never)
  return { manager, child, directory }
}

describe('device login', () => {
  it('isolates login and exposes only a verified device URL and code across output chunks', async () => {
    const { manager, child, directory } = await fixture()
    expect((await manager.start(keyId)).status).toBe('starting')
    expect(spawn).toHaveBeenCalledWith('codex', ['login', '--device-auth'], expect.objectContaining({
      shell: false, env: expect.objectContaining({ CODEX_HOME: join(directory, keyId) }),
    }))
    child.stdout.emit('data', Buffer.from('secret=DO_NOT_EXPOSE https://evil.example/device ABCD-1234'))
    expect(manager.get(keyId).url).toBeUndefined()
    child.stderr.emit('data', Buffer.from('\nhttps://auth.openai.com/codex/'))
    child.stderr.emit('data', Buffer.from('device\nABCD-1234'))
    expect(manager.get(keyId)).toMatchObject({ status: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' })
    expect(JSON.stringify(manager.get(keyId))).not.toContain('DO_NOT_EXPOSE')
    child.emit('close', 0)
    expect(manager.get(keyId)).toEqual({ status: 'success', message: 'Codex sign-in completed. Test the connection next.' })
    expect(manager.isRunning(keyId)).toBe(false)
  })

  it('prevents duplicate login processes and clears the code on cancellation', async () => {
    const { manager, child } = await fixture()
    await Promise.all([manager.start(keyId), manager.start(keyId)])
    expect(spawn).toHaveBeenCalledTimes(1)
    expect((await manager.start('key_aaaaaaaaaaaaaaaa')).status).toBe('failed')
    expect(manager.cancel(keyId).status).toBe('cancelled')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(manager.get(keyId).code).toBeUndefined()
  })

  it('rejects path traversal and reports process failures without raw stderr', async () => {
    const { manager, child } = await fixture()
    await expect(manager.start('../other')).rejects.toThrow('Invalid key ID')
    expect(spawn).not.toHaveBeenCalled()
    await manager.start(keyId)
    child.emit('error', new Error('secret credentials'))
    child.emit('close', 1)
    expect(manager.get(keyId).status).toBe('failed')
    expect(JSON.stringify(manager.get(keyId))).not.toContain('secret credentials')
  })
})
