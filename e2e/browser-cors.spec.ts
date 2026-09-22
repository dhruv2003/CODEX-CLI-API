import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiKeyStore, type CreatedApiKey } from '../src/auth.js'
import { CodexSessionManager } from '../src/codex.js'
import { createApp } from '../src/server.js'

let root: string
let gateway: Server
let website: Server
let gatewayOrigin: string
let websiteOrigin: string
let keys: ApiKeyStore
let allowed: CreatedApiKey
let inferenceCalls: number
let requests: { method: string; path: string; origin?: string; authorization?: string; status: number }[]
const desktopToken = 'a'.repeat(64)

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind')
  return `http://127.0.0.1:${address.port}`
}

async function browserFetch(page: Page, path: string, key: string, stream = false) {
  return page.evaluate(async ({ url, key, stream }) => {
    try {
      const response = await fetch(url, {
        method: url.endsWith('/models') ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, ...(url.endsWith('/models') ? {} : { 'Content-Type': 'application/json' }) },
        ...(url.endsWith('/models') ? {} : { body: JSON.stringify({
          model: 'gpt-5.4', messages: [{ role: 'user', content: 'Reply OK' }], stream,
        }) }),
      })
      // Consume the browser's actual ReadableStream, including SSE through EOF.
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let body = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        body += decoder.decode(value, { stream: true })
      }
      body += decoder.decode()
      return { blocked: false, status: response.status, contentType: response.headers.get('content-type'), body }
    } catch (error) {
      return { blocked: true, error: error instanceof Error ? error.name : String(error) }
    }
  }, { url: gatewayOrigin + path, key, stream })
}

test.beforeEach(async ({ page }) => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-browser-cors-')))
  const project = join(root, 'project')
  await mkdir(project)
  const config = {
    port: 0, host: '127.0.0.1', codexCommand: 'unused-browser-cors-test',
    codexStateRoot: join(root, 'state'), workspaceRoot: project, keyFile: join(root, 'keys.json'),
    models: ['gpt-5.4'], imageModels: [], modelEfforts: { 'gpt-5.4': ['low'] },
    desktopAdminToken: desktopToken,
  }
  keys = new ApiKeyStore(config.keyFile)
  const sessions = new CodexSessionManager(config)
  inferenceCalls = 0
  requests = []
  // Only generation is replaced: HTTP, auth, per-key policy, sessions, and
  // Chromium's CORS enforcement all run normally without provider credentials.
  sessions.run = async function* () {
    inferenceCalls++
    yield { type: 'message', text: 'OK' }
    yield { type: 'usage', inputTokens: 5, outputTokens: 2 }
    yield { type: 'done' }
  }
  const app = createApp({ config, keys, sessions })
  gateway = createServer((request, response) => {
    const path = request.url!
    response.once('finish', () => requests.push({
      method: request.method!, path, origin: request.headers.origin,
      authorization: request.headers.authorization, status: response.statusCode,
    }))
    app(request, response)
  })
  website = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>Browser CORS fixture</title>')
  })
  gatewayOrigin = await listen(gateway)
  websiteOrigin = await listen(website)
  allowed = await keys.create('Allowed website', { workspaceRoot: '.', allowedOrigins: [websiteOrigin] })
  await page.goto(websiteOrigin)
  expect(new URL(page.url()).origin).not.toBe(gatewayOrigin)
})

test.afterEach(async () => {
  for (const server of [gateway, website]) {
    if (!server) continue
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  if (root) await rm(root, { recursive: true, force: true })
})

test('an allowed website can read models, JSON completions, and SSE in Chromium under desktop restrictions', async ({ page }) => {
  const models = await browserFetch(page, '/v1/models', allowed.key)
  expect(models.blocked).toBe(false)
  expect(models.status).toBe(200)
  expect(JSON.parse(models.body!).data).toEqual([expect.objectContaining({ id: 'gpt-5.4' })])

  const completion = await browserFetch(page, '/v1/chat/completions', allowed.key)
  expect(completion.blocked).toBe(false)
  expect(completion.status).toBe(200)
  expect(JSON.parse(completion.body!).choices[0].message.content).toBe('OK')

  const streaming = await browserFetch(page, '/v1/chat/completions', allowed.key, true)
  expect(streaming.blocked).toBe(false)
  expect(streaming.status).toBe(200)
  expect(streaming.contentType).toContain('text/event-stream')
  const events = streaming.body!.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
  expect(events.at(-1)).toBe('[DONE]')
  expect(events.slice(0, -1).map(event => JSON.parse(event).choices[0]?.delta?.content ?? '').join('')).toBe('OK')
  expect(inferenceCalls).toBe(2)

  const preflights = requests.filter(request => request.method === 'OPTIONS')
  expect(preflights.map(request => request.path)).toEqual(expect.arrayContaining(['/v1/models', '/v1/chat/completions']))
  for (const preflight of preflights) {
    expect(preflight.origin).toBe(websiteOrigin)
    expect(preflight.authorization).toBeUndefined()
    expect(preflight.status).toBe(204)
  }
})

test('browser permission belongs to each key, revokes immediately, and cannot grant admin access', async ({ page }) => {
  // Populate the browser preflight cache with an allowed request first.
  expect((await browserFetch(page, '/v1/chat/completions', allowed.key)).status).toBe(200)
  expect(inferenceCalls).toBe(1)
  const empty = await keys.create('Default policy', { workspaceRoot: '.' })
  const other = await keys.create('Other origin', { workspaceRoot: '.', allowedOrigins: [gatewayOrigin] })
  for (const key of [empty.key, other.key, 'dsh_live_invalid']) {
    const result = await browserFetch(page, '/v1/chat/completions', key)
    expect(result).toMatchObject({ blocked: true, error: 'TypeError' })
    expect(inferenceCalls).toBe(1)
  }

  await keys.update(allowed.id, { allowedOrigins: [] })
  expect(await browserFetch(page, '/v1/chat/completions', allowed.key, true)).toMatchObject({ blocked: true, error: 'TypeError' })
  expect(inferenceCalls).toBe(1)
  expect(requests.filter(request => request.method === 'POST').map(request => request.status)).toEqual([200, 403, 403, 401, 403])

  await keys.update(allowed.id, { allowedOrigins: [websiteOrigin] })
  const headers = { 'X-Codex-Admin': 'local', 'X-Codex-Desktop-Token': desktopToken, Authorization: `Bearer ${allowed.key}` }
  // These are valid admin credentials; the foreign website still cannot use them.
  expect((await fetch(gatewayOrigin + '/admin/config', { headers })).status).toBe(200)
  const admin = await page.evaluate(async ({ url, headers }) => {
    try {
      await fetch(url, { headers })
      return 'readable'
    } catch (error) {
      return error instanceof Error ? error.name : String(error)
    }
  }, { url: gatewayOrigin + '/admin/config', headers })
  expect(admin).toBe('TypeError')
  expect(requests.filter(request => request.method === 'OPTIONS' && request.path === '/admin/config')).toEqual([
    expect.objectContaining({ status: 403, origin: websiteOrigin, authorization: undefined }),
  ])
  expect((await fetch(gatewayOrigin + '/admin/config', { headers: { ...headers, Origin: websiteOrigin } })).status).toBe(403)
  expect(inferenceCalls).toBe(1)
})
