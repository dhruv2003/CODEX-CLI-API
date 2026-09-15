import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'

describe('ApiKeyStore process locking', () => {
  it('releases its lock after a failed mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-lock-failure-'))
    const file = join(directory, 'keys.json')
    const store = new ApiKeyStore(file)
    try {
      await writeFile(file, 'invalid json')
      await expect(store.create('failed')).rejects.toThrow()
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(file, '[]')
      await store.create('recovered')
      expect(await store.list()).toHaveLength(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('times out without stealing an existing lock or changing the key file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-lock-timeout-'))
    const file = join(directory, 'keys.json')
    const store = new ApiKeyStore(file)
    try {
      await store.create('existing')
      const original = await readFile(file, 'utf8')
      await mkdir(`${file}.lock`)
      await expect(store.create('blocked')).rejects.toThrow('stop all writers before removing the lock directory')
      expect(await readFile(file, 'utf8')).toBe(original)
      expect((await stat(`${file}.lock`)).isDirectory()).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 10_000)

  it('preserves creations and usage recorded by separate processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-cli-api-process-lock-'))
    const file = join(directory, 'keys.json')
    const store = new ApiKeyStore(file)
    const key = await store.create('shared')
    const children = Array.from({ length: 3 }, () => fork(new URL('./fixtures/auth-writer.mjs', import.meta.url), [file, key.id], {
      execArgv: ['--import=tsx/esm'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }))
    const exits = children.map(child => once(child, 'exit'))
    try {
      await Promise.all(children.map(child => once(child, 'message')))
      for (const child of children) child.send('start')
      expect(await Promise.all(exits)).toEqual([[0, null], [0, null], [0, null]])
      const keys = await store.list()
      expect(keys).toHaveLength(46)
      expect(keys.find(entry => entry.id === key.id)).toMatchObject({ requestCount: 45, inputTokens: 90, outputTokens: 135 })
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.all(exits)
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
