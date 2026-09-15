import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApiKeyStore } from '../src/auth.js'
import { CodexSessionManager, type RunRequest, type Session } from '../src/codex.js'
import { createApp } from '../src/server.js'

describe('HTTP API', () => {
  it('protects the API and creates workspace-scoped sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-server-'))
    await mkdir(join(root, 'project'))
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('test')
    const other = await keys.create('other')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: ['gpt-5.4'],
      modelEfforts: { 'gpt-5.4': ['low', 'medium', 'high', 'xhigh'] },
    }
    const sessions = new CodexSessionManager(config)
    vi.spyOn(sessions, 'run').mockImplementation(async function* () { yield { type: 'done' } })
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const url = `http://127.0.0.1:${address.port}`
      const unauthenticated = await fetch(`${url}/v1/models`)
      expect(unauthenticated.status).toBe(401)
      expect(await unauthenticated.json()).toEqual({
        error: { message: 'invalid API key', type: 'authentication_error', param: null, code: 'invalid_api_key' },
      })
      const response = await fetch(`${url}/v1/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: 'project' }),
      })
      expect(response.status).toBe(201)
      const session = await response.json() as { id: string }
      expect(session).toMatchObject({ cwd: await realpath(join(root, 'project')) })
      const crossKeyResponse = await fetch(`${url}/v1/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${other.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'should not access this session' }),
      })
      expect(crossKeyResponse.status).toBe(404)
    } finally {
      vi.restoreAllMocks()
      await close(server)
    }
  })

  it('uses the authenticated API key workspace as its hard boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-key-workspace-'))
    const project = join(root, 'project')
    const sibling = join(root, 'sibling')
    await Promise.all([mkdir(project), mkdir(sibling)])
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('project key', { workspaceRoot: project })
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const url = `http://127.0.0.1:${address.port}/v1/sessions`
      const headers = { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' }

      const defaultWorkspace = await fetch(url, { method: 'POST', headers, body: '{}' })
      expect(defaultWorkspace.status).toBe(201)
      expect(await defaultWorkspace.json()).toMatchObject({ cwd: await realpath(project) })

      const escapedWorkspace = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ cwd: '..\\sibling' }) })
      expect(escapedWorkspace.status).toBe(400)
      expect(await escapedWorkspace.json()).toMatchObject({ error: { message: 'cwd must be a directory inside workspace' } })
    } finally {
      await close(server)
    }
  })

  it('returns models in the OpenAI list format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-models-'))
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('test')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: ['gpt-5.4'],
      modelEfforts: { 'gpt-5.4': ['low', 'medium', 'high', 'xhigh'] },
    }
    const server = createServer(createApp({ config, keys, sessions: new CodexSessionManager(config) }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
        headers: { Authorization: `Bearer ${created.key}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        object: 'list',
        data: [{
          id: 'gpt-5.4',
          object: 'model',
          created: 0,
          owned_by: 'deepseek-harness',
          inputModalities: ['text', 'image'],
          efforts: ['low', 'medium', 'high', 'xhigh'],
        }],
      })
    } finally {
      await close(server)
    }
  })

  it('returns a generic server error when the key store is unreadable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-key-error-'))
    const keyFile = join(root, 'keys.json')
    await writeFile(keyFile, 'not json')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile,
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low'] },
    }
    const server = createServer(createApp({ config, keys: new ApiKeyStore(keyFile), sessions: new CodexSessionManager(config) }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`, {
        headers: { Authorization: 'Bearer dsh_live_invalid' },
      })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: { message: 'internal server error', type: 'server_error', param: null, code: 'internal_error' },
      })
    } finally {
      vi.restoreAllMocks()
      await close(server)
    }
  })

  it('rejects full-access requests with an OpenAI error envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-errors-'))
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('test')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    vi.spyOn(sessions, 'run').mockImplementation(async function* () { yield { type: 'done' } })
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }], sandbox: 'danger-full-access' }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: { message: 'invalid sandbox', type: 'invalid_request_error', param: 'sandbox', code: 'invalid_value' },
      })
    } finally {
      vi.restoreAllMocks()
      await close(server)
    }
  })

  it('releases one-shot chat sessions after completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-cleanup-'))
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('test')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    let captured: Session | undefined
    const create = sessions.create.bind(sessions)
    vi.spyOn(sessions, 'create').mockImplementation((cwd, apiKeyId) => {
      captured = create(cwd, apiKeyId)
      return captured
    })
    vi.spyOn(sessions, 'run').mockImplementation(async function* () {
      yield { type: 'message', text: 'ok' }
      yield { type: 'done' }
    })
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }] }),
      })

      expect(response.status).toBe(200)
      expect(captured).toBeDefined()
      expect(sessions.get(captured!.id, created.id)).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      await close(server)
    }
  })

  it('streams OpenAI chat completion chunks through the Codex session runner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-chat-'))
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('test')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low', 'medium', 'high', 'xhigh'] },
    }
    const sessions = new CodexSessionManager(config)
    let capturedRequest: RunRequest | undefined
    let runCount = 0
    vi.spyOn(sessions, 'run').mockImplementation(async function* (_session, request) {
      capturedRequest = request
      yield { type: 'message', text: 'Hello from Codex' }
      if (runCount++ === 0) yield { type: 'usage', inputTokens: 4, outputTokens: 3 }
      yield { type: 'done' }
    })
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: true,
          stream_options: { include_usage: true },
          reasoning_effort: 'high',
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Say hello.' },
          ],
        }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const lines = (await response.text()).split('\n').filter(line => line.startsWith('data: '))
      const chunks = lines.slice(0, -1).map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
      expect(chunks[0]).toMatchObject({
        object: 'chat.completion.chunk',
        model: 'gpt-5.4',
        choices: [{ delta: { role: 'assistant', content: 'Hello from Codex' }, finish_reason: null }],
      })
      expect(chunks[1]).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      expect(chunks[2]).toMatchObject({
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      })
      expect(lines.at(-1)).toBe('data: [DONE]')
      expect(capturedRequest?.model).toBe('gpt-5.4')
      expect(capturedRequest?.reasoningEffort).toBe('high')
      expect(capturedRequest?.message).toContain('Be concise.')
      expect(capturedRequest?.message).toContain('Say hello.')

      const responseWithoutUsage = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.4', stream: true, messages: [{ role: 'user', content: 'Again.' }] }),
      })
      const chunksWithoutUsage = (await responseWithoutUsage.text())
        .split('\n')
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice('data: '.length)) as { choices?: unknown[] })
      expect(chunksWithoutUsage.some(chunk => chunk.choices?.length === 0)).toBe(false)

      const responseWithUnknownUsage = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'One more time.' }],
        }),
      })
      const chunksWithUnknownUsage = (await responseWithUnknownUsage.text())
        .split('\n')
        .filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice('data: '.length)) as { choices?: unknown[]; usage?: unknown })
      expect(chunksWithUnknownUsage.at(-1)).toEqual({
        id: expect.any(String),
        object: 'chat.completion.chunk',
        created: expect.any(Number),
        model: 'gpt-5.4',
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    } finally {
      vi.restoreAllMocks()
      await close(server)
    }
  })

  it('returns a completed OpenAI response from text input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-responses-'))
    await mkdir(join(root, 'project'))
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('test')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low', 'medium', 'high'] },
    }
    const sessions = new CodexSessionManager(config)
    let capturedRequest: RunRequest | undefined
    vi.spyOn(sessions, 'run').mockImplementation(async function* (_session, request) {
      capturedRequest = request
      yield { type: 'message', text: 'Hello from Codex' }
      yield { type: 'usage', inputTokens: 4, outputTokens: 3 }
      yield { type: 'done' }
    })
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] }],
          instructions: 'Be concise.',
          reasoning: { effort: 'high' },
          cwd: 'project',
        }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        id: expect.stringMatching(/^resp_/),
        object: 'response',
        status: 'completed',
        completed_at: expect.any(Number),
        max_output_tokens: null,
        metadata: {},
        model: 'gpt-5.4',
        store: false,
        temperature: 1,
        text: { format: { type: 'text' } },
        top_p: 1,
        truncation: 'disabled',
        output: [{
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello from Codex', annotations: [] }],
        }],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      })
      expect(capturedRequest).toMatchObject({
        model: 'gpt-5.4',
        reasoningEffort: 'high',
      })
      expect(capturedRequest?.message).toContain('Be concise.')
      expect(capturedRequest?.message).toContain('Say hello.')
    } finally {
      vi.restoreAllMocks()
      await close(server)
    }
  })

  it('streams Responses API lifecycle events and rejects unsupported request features', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-cli-api-responses-stream-'))
    const keys = new ApiKeyStore(join(root, 'keys.json'))
    const created = await keys.create('test')
    const config = {
      port: 0,
      host: '127.0.0.1',
      codexCommand: 'codex',
      codexStateRoot: join(root, 'codex-users'),
      workspaceRoot: root,
      keyFile: join(root, 'keys.json'),
      models: ['gpt-5.4'],
      imageModels: [],
      modelEfforts: { 'gpt-5.4': ['low'] },
    }
    const sessions = new CodexSessionManager(config)
    const runSpy = vi.spyOn(sessions, 'run').mockImplementation(async function* () {
      yield { type: 'message', text: 'Hello' }
      yield { type: 'message', text: ' world' }
      yield { type: 'done' }
    })
    const server = createServer(createApp({ config, keys, sessions }))
    await listen(server)
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind')
      const url = `http://127.0.0.1:${address.port}/v1/responses`
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Say hello.', stream: true }),
      })
      expect(response.status).toBe(200)
      const events = (await response.text()).split('\n').filter(line => line.startsWith('event: ')).map(line => line.slice('event: '.length))
      expect(events).toEqual([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
      ])
      runSpy.mockImplementationOnce(async function* () { throw new Error('upstream failed') })
      const failed = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'Fail.', stream: true }),
      })
      const failureLines = (await failed.text()).split('\n')
      expect(failureLines.filter(line => line.startsWith('event: ')).at(-1)).toBe('event: error')
      expect(JSON.parse(failureLines.filter(line => line.startsWith('data: ')).at(-1)!.slice(6))).toEqual({
        type: 'error', sequence_number: 4, code: 'upstream_error', message: 'Codex CLI request failed', param: null,
      })
      const unsupportedTools = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hello', tools: [{ type: 'function', name: 'x' }] }),
      })
      expect(unsupportedTools.status).toBe(400)
      expect(await unsupportedTools.json()).toEqual({
        error: { message: 'tools are not supported', type: 'invalid_request_error', param: 'tools', code: 'unsupported_value' },
      })
      const unsupportedLimit = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hello', max_output_tokens: 10 }),
      })
      expect(await unsupportedLimit.json()).toEqual({
        error: { message: 'max_output_tokens is not supported', type: 'invalid_request_error', param: 'max_output_tokens', code: 'unsupported_value' },
      })
      const priorResponse = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hello', previous_response_id: 'resp_old' }),
      })
      expect(await priorResponse.json()).toEqual({
        error: { message: 'previous_response_id is not supported', type: 'invalid_request_error', param: 'previous_response_id', code: 'unsupported_value' },
      })
      const unsupportedInput = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: [{ type: 'function_call', name: 'x' }] }),
      })
      expect(await unsupportedInput.json()).toEqual({
        error: { message: 'input[0].type is unsupported', type: 'invalid_request_error', param: null, code: 'invalid_request' },
      })
    } finally {
      vi.restoreAllMocks()
      await close(server)
    }
  })
})

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
}
