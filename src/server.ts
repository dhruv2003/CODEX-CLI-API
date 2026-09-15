import { constants } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { access, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express, { type NextFunction, type Request, type Response } from 'express'
import { AdmissionController, AdmissionError, type AdmissionLease } from './admission.js'
import { ApiKeyStore, type ApiKeyIdentity, type ApiKeyPolicy, type ApiKeyUsage } from './auth.js'
import { CodexSessionManager, type RunRequest } from './codex.js'
import { loadConfig, prepareConfig, type AppConfig } from './config.js'
import { writeStream } from './streaming.js'
import { RequestLifecycle } from './lifecycle.js'
import { CodexLoginManager } from './login.js'
import { isInsideWorkspace, resolveWorkspacePath } from './security.js'

interface Dependencies {
  config: AppConfig
  keys: ApiKeyStore
  sessions: CodexSessionManager
  admission: AdmissionController
  lifecycle: RequestLifecycle
}

class InvalidRequestError extends Error {
  constructor(message: string, readonly param: string | null = null, readonly code = 'invalid_request') {
    super(message)
  }
}

export function createApp(overrides: Partial<Dependencies> = {}) {
  const config = overrides.config ?? loadConfig()
  const keys = overrides.keys ?? new ApiKeyStore(config.keyFile)
  const sessions = overrides.sessions ?? new CodexSessionManager(config)
  const admission = overrides.admission ?? new AdmissionController({
    maxConcurrent: config.maxConcurrent ?? 2,
    maxConcurrentPerKey: config.maxConcurrentPerKey ?? 1,
    maxQueue: config.maxQueue ?? 20,
  })
  const app = express()
  const lifecycle = overrides.lifecycle ?? new RequestLifecycle()
  const loginManager = new CodexLoginManager(config)
  app.locals.loginManager = loginManager
  lifecycle.signal.addEventListener('abort', () => loginManager.dispose(), { once: true })
  app.locals.lifecycle = lifecycle
  const publicDirectory = config.publicDirectory ?? fileURLToPath(new URL('public', import.meta.url))
  app.disable('x-powered-by')
  if (config.desktopAdminToken) {
    const expectedToken = Buffer.from(config.desktopAdminToken)
    app.use((request, response, next) => {
      const localOrigin = `http://127.0.0.1:${request.socket.localPort}`
      if (request.get('host') !== `127.0.0.1:${request.socket.localPort}` || (request.get('origin') && request.get('origin') !== localOrigin)) {
        response.status(403).json({ error: { message: 'desktop origin denied' } })
        return
      }
      // Assets contain no credentials. All other admin paths require the per-launch capability.
      const adminPath = request.path.toLowerCase()
      const isAsset = request.method === 'GET' && ['/admin/app.js', '/admin/styles.css', '/admin/logo.png'].includes(request.path)
      if (adminPath.startsWith('/admin') && !isAsset) {
        const actual = Buffer.from(request.get('X-Codex-Desktop-Token') ?? '')
        if (actual.length !== expectedToken.length || !timingSafeEqual(actual, expectedToken)) {
          response.status(403).json({ error: { message: 'desktop authorization required' } })
          return
        }
      }
      next()
    })
  }
  app.use(requestContext)
  const history: Record<string, unknown>[] = []
  const tests = new Map<string, { ok: boolean; code: string; message: string; model: string; testedAt: string }>()
  app.use((request, response, next) => {
    const started = Date.now()
    let recorded = false
    const record = () => {
      if (recorded || request.method !== 'POST' || !(/^\/v1\/(chat\/completions|responses|sessions\/[^/]+\/messages)$/.test(request.path) || /^\/admin\/api-keys\/[^/]+\/test$/.test(request.path))) return
      recorded = true
      const usage = response.locals.generationUsage as ApiKeyUsage | undefined
      history.unshift({ requestId: response.locals.requestId, keyId: (response.locals.apiKeyIdentity as ApiKeyIdentity | undefined)?.id ?? null,
        model: typeof request.body?.model === 'string' && config.models.includes(request.body.model) ? request.body.model : config.models[0] ?? null,
        status: !response.writableFinished ? 'aborted' : usage?.failed || response.statusCode >= 400 ? 'failed' : 'success',
        httpStatus: response.statusCode, durationMs: Date.now() - started, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
        timestamp: new Date(started).toISOString(), path: request.path.startsWith('/admin/') ? '/admin/api-keys/:keyId/test' : request.path.startsWith('/v1/sessions/') ? '/v1/sessions/:sessionId/messages' : request.path })
      history.length = Math.min(history.length, 100)
    }
    response.once('finish', record)
    response.once('close', record)
    next()
  })
  app.use((_request, response, next) => {
    if (lifecycle.isStopping) {
      sendError(response, 503, 'server is shutting down', null, 'server_shutdown', 'server_error')
      return
    }
    next()
  })
  app.use(express.json({ limit: '1mb' }))
  app.get('/healthz', (_request, response) => { response.json({ ok: true }) })
  app.get('/readyz', asyncHandler(async (_request, response) => {
    try {
      await Promise.all([
        access(config.workspaceRoot, constants.R_OK | constants.W_OK),
        access(config.codexStateRoot, constants.R_OK | constants.W_OK),
        access(dirname(config.keyFile), constants.R_OK | constants.W_OK),
      ])
      response.json({ ok: true, capacity: admission.stats() })
    } catch {
      response.status(503).json({ ok: false })
    }
  }))

  app.use('/admin/api-keys', localAdmin)
  app.all('/admin/api-keys/:keyId/login', asyncHandler(async (request, response) => {
    const id = String(request.params.keyId)
    if (!/^key_[0-9a-f]{16}$/.test(id)) return sendError(response, 400, 'invalid API key id', 'keyId', 'invalid_value')
    const key = (await keys.list()).find(candidate => candidate.id === id)
    if (!key) return sendError(response, 404, 'API key not found', 'keyId', 'not_found')
    if (request.method === 'GET') return response.json(loginManager.get(id))
    if (request.method === 'DELETE') return response.json(loginManager.cancel(id))
    if (request.method !== 'POST') return response.status(405).set('Allow', 'GET, POST, DELETE').end()
    if (!key.active || (key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.now())) return sendError(response, 409, 'Activate an unexpired key before signing in.', 'keyId', 'key_inactive')
    tests.delete(id)
    response.json(await loginManager.start(id))
  }))
  app.get('/admin/requests', localAdmin, (_request, response) => response.json({ data: history, limit: 100, retention: 'memory' }))
  app.get('/admin/setup', localAdmin, asyncHandler(async (_request, response) => {
    response.json({ models: config.models.map(id => ({ id, efforts: config.modelEfforts[id] ?? [], inputModalities: config.imageModels.includes(id) ? ['text', 'image'] : ['text'] })),
      keys: await Promise.all((await keys.list()).map(async key => {
        const authStatus = await credentialStatus(config.codexStateRoot, key.id)
        const lastTest = tests.get(key.id) ?? null
        return { id: key.id, authStatus, lastTest, ready: key.active && (key.expiresAt === null || Date.parse(key.expiresAt) > Date.now()) && authStatus === 'credentials_found' && lastTest?.ok === true }
      })) })
  }))
  app.post('/admin/api-keys/:keyId/test', asyncHandler(async (request, response) => {
    const id = String(request.params.keyId)
    const key = (await keys.list()).find(candidate => candidate.id === id)
    if (!key) return sendError(response, 404, 'API key not found', 'keyId', 'not_found')
    if (!key.active || (key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.now())) return sendError(response, 409, 'Activate an unexpired key before testing.', 'keyId', 'key_inactive')
    if (loginManager.isRunning(id)) return sendError(response, 409, 'Finish signing in before testing this key.', 'keyId', 'login_in_progress')
    const body = objectBody(request)
    const model = stringOr(body.model, config.models[0] ?? '')
    validateOption(model, config.models, 'model', 'model is not enabled')
    const effort = body.reasoningEffort === undefined ? undefined : stringOr(body.reasoningEffort, '')
    if (effort !== undefined) validateOption(effort, config.modelEfforts[model] ?? [], 'reasoningEffort', 'reasoning effort is not enabled for this model')
    response.locals.apiKeyIdentity = key
    const result = (ok: boolean, code: string, message: string, status: number) => {
      const value = { ok, code, message, model, testedAt: new Date().toISOString() }
      tests.set(id, value)
      response.status(status).json(value)
    }
    if (await credentialStatus(config.codexStateRoot, id) !== 'credentials_found') return result(false, 'login_required', 'Sign in to Codex for this key, then test again.', 409)
    const cwd = await keyWorkspaceRoot(config, key)
    const execution = await admit(response, key, admission, Math.min(config.requestTimeoutMs ?? 600_000, 60_000), lifecycle.signal, true)
    if (!execution) return
    let session: ReturnType<CodexSessionManager['create']> | undefined
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let failed = true
    try {
      session = sessions.create(cwd, id)
      let hasMessage = false
      for await (const event of sessions.run(session, { message: 'Reply with OK only. Do not use tools or inspect files.', model, reasoningEffort: effort, sandbox: 'read-only', images: [], signal: execution.signal })) {
        if (event.type === 'message' && event.text.trim()) hasMessage = true
        if (event.type === 'usage') { inputTokens = event.inputTokens; outputTokens = event.outputTokens }
      }
      if (!hasMessage) throw new Error('empty response')
      failed = false
      await recordUsage(keys, response, id, { inputTokens, outputTokens, failed })
      result(true, 'ready', 'Connection passed. This model is ready to use in VS Code.', 200)
    } catch {
      await recordUsage(keys, response, id, { inputTokens, outputTokens, failed: true })
      if (!execution.clientAborted()) result(false, execution.timedOut() ? 'timeout' : 'upstream_error', execution.timedOut() ? 'The test timed out. Check your connection and try again.' : 'Codex could not complete the test. Check the CLI installation, sign in again, and confirm this model is available to your account.', execution.timedOut() ? 504 : 502)
    } finally {
      execution.release()
      if (session) sessions.delete(session.id, id)
    }
  }))
  app.get('/admin/metrics', localAdmin, asyncHandler(async (_request, response) => {
    const allKeys = await keys.list()
    response.json({
      capacity: admission.stats(),
      keys: {
        total: allKeys.length,
        active: allKeys.filter(key => key.active && (key.expiresAt === null || Date.parse(key.expiresAt) > Date.now())).length,
        requestCount: allKeys.reduce((total, key) => total + key.requestCount, 0),
        inputTokens: allKeys.reduce((total, key) => total + key.inputTokens, 0),
        outputTokens: allKeys.reduce((total, key) => total + key.outputTokens, 0),
        failureCount: allKeys.reduce((total, key) => total + key.failureCount, 0),
      },
    })
  }))
  app.get('/admin/config', localAdmin, (_request, response) => {
    response.json({ codexStateRoot: config.codexStateRoot, workspaceRoot: config.workspaceRoot, defaultModel: config.models[0] ?? '', ...(app.locals.desktopMigration ? { desktopMigration: app.locals.desktopMigration } : {}) })
  })
  app.get('/admin/api-keys', asyncHandler(async (_request, response) => {
    response.json({ data: (await keys.list()).map(key => ({ ...key, workspaceRoot: resolve(config.workspaceRoot, key.workspaceRoot ?? '.') })) })
  }))
  app.post('/admin/api-keys', asyncHandler(async (request, response) => {
    const body = objectBody(request)
    const name = stringOr(body.name, '').trim()
    if (name.length === 0 || name.length > 100) return sendError(response, 400, 'name must be 1-100 characters', 'name', 'invalid_value')
    const policyError = validateKeyPolicy(body)
    if (policyError !== undefined) return sendError(response, 400, policyError.message, policyError.param, 'invalid_value')
    if (typeof body.workspaceRoot !== 'string' || body.workspaceRoot.trim().length === 0) return sendError(response, 400, 'workspaceRoot must be an existing directory inside CODEX_WORKSPACE_ROOT', 'workspaceRoot', 'invalid_value')
    const workspaceRoot = await safeDirectory(config.workspaceRoot, body.workspaceRoot.trim())
    const created = await keys.create(name, { ...keyPolicy(body), workspaceRoot: relative(config.workspaceRoot, workspaceRoot) || '.' })
    response.status(201).json({ ...created, workspaceRoot })
  }))
  app.patch('/admin/api-keys/:keyId', asyncHandler(async (request, response) => {
    const body = objectBody(request)
    if (body.active !== undefined && typeof body.active !== 'boolean') return sendError(response, 400, 'active must be a boolean', 'active', 'invalid_value')
    const policyError = validateKeyPolicy(body)
    if (policyError !== undefined) return sendError(response, 400, policyError.message, policyError.param, 'invalid_value')
    const keyId = Array.isArray(request.params.keyId) ? request.params.keyId[0] : request.params.keyId
    const updated = await keys.update(keyId, { ...(typeof body.active === 'boolean' ? { active: body.active } : {}), ...keyPolicy(body) })
    if (updated === undefined) return sendError(response, 404, 'API key not found', 'keyId', 'not_found')
    response.json(updated)
  }))
  app.delete('/admin/api-keys/:keyId', asyncHandler(async (request, response) => {
    const keyId = Array.isArray(request.params.keyId) ? request.params.keyId[0] : request.params.keyId
    if (!/^key_[0-9a-f]{16}$/.test(keyId)) return sendError(response, 400, 'invalid API key id', 'keyId', 'invalid_value')
    if (loginManager.isRunning(keyId)) return sendError(response, 409, 'Cancel the sign-in before deleting this key.', 'keyId', 'key_in_use')
    const stateDirectory = resolve(config.codexStateRoot, keyId)
    if (!isInsideWorkspace(config.codexStateRoot, stateDirectory)) return sendError(response, 400, 'invalid API key id', 'keyId', 'invalid_value')
    const wasRetired = sessions.isKeyRetired(keyId)
    if (!sessions.tryRetireKey(keyId)) return sendError(response, 409, 'API key has a running request', 'keyId', 'key_in_use')

    let result
    try {
      result = await keys.deleteInactive(keyId, () => rm(stateDirectory, { recursive: true, force: true }))
    } catch {
      if (!wasRetired) sessions.restoreKey(keyId)
      if (process.env.NODE_ENV !== 'test') console.error(JSON.stringify({
        event: 'api_key_state_delete_failed', requestId: response.locals.requestId as string, apiKeyId: keyId,
      }))
      return sendError(response, 500, 'API key state could not be deleted; the inactive key remains available for retry', 'keyId', 'state_delete_failed')
    }
    if (result === 'active') {
      if (!wasRetired) sessions.restoreKey(keyId)
      return sendError(response, 409, 'deactivate the API key before deleting it', 'keyId', 'key_must_be_inactive')
    }
    if (result === 'not_found') {
      if (!wasRetired) sessions.restoreKey(keyId)
      return sendError(response, 404, 'API key not found', 'keyId', 'not_found')
    }

    sessions.finalizeKeyDeletion(keyId)
    tests.delete(keyId)
    response.status(204).end()
  }))
  app.get('/', (_request, response) => { response.sendFile(resolve(publicDirectory, 'index.html')) })
  app.use('/admin', express.static(publicDirectory))
  app.use('/v1', authenticate(keys))

  app.get('/v1/models', (_request, response) => {
    response.json({
      object: 'list',
      data: config.models.map(model => ({
        id: model,
        object: 'model',
        created: 0,
        owned_by: 'deepseek-harness',
        inputModalities: config.imageModels.includes(model) ? ['text', 'image'] : ['text'],
        efforts: config.modelEfforts[model] ?? ['low', 'medium', 'high'],
      })),
    })
  })

  app.post('/v1/sessions', asyncHandler(async (request, response) => {
    const body = objectBody(request)
    const identity = apiKeyIdentity(response)
    const workspaceRoot = await keyWorkspaceRoot(config, identity)
    const requestedCwd = stringOr(body.cwd, '.')
    const cwd = await safeDirectory(workspaceRoot, requestedCwd)
    const session = sessions.create(cwd, identity.id)
    response.status(201).json({ id: session.id, cwd: session.cwd })
  }))

  app.post('/v1/sessions/:sessionId/messages', asyncHandler(async (request, response) => {
    const sessionId = Array.isArray(request.params.sessionId) ? request.params.sessionId[0] : request.params.sessionId
    const session = sessions.get(sessionId, apiKeyIdentity(response).id)
    if (session === undefined) return sendError(response, 404, 'session not found', 'sessionId', 'not_found')
    const body = objectBody(request)
    const message = stringOr(body.message, '')
    if (message.length === 0 || message.length > 100_000) return sendError(response, 400, 'message must be 1-100000 characters', 'message', 'invalid_value')
    const model = stringOr(body.model, config.models[0]!)
    validateOption(model, config.models, 'model', 'model is not enabled')
    const sandbox = stringOr(body.sandbox, 'workspace-write')
    validateOption(sandbox, ['read-only', 'workspace-write'], 'sandbox', 'invalid sandbox')
    const effort = body.reasoningEffort === undefined ? undefined : stringOr(body.reasoningEffort, '')
    if (effort !== undefined) validateOption(effort, config.modelEfforts[model] ?? [], 'reasoningEffort', 'reasoning effort is not enabled for this model')
    const identity = apiKeyIdentity(response)
    const workspaceRoot = await keyWorkspaceRoot(config, identity)
    const images = await safeImages(config, workspaceRoot, body.images, model)
    const execution = await admit(response, identity, admission, config.requestTimeoutMs ?? 600_000, lifecycle.signal)
    if (execution === undefined) return
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let failed = true
    let usageRecorded = false
    response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    response.flushHeaders()
    try {
      for await (const event of sessions.run(session, { message, model, reasoningEffort: effort, sandbox: sandbox as RunRequest['sandbox'], images, signal: execution.signal })) {
        if (event.type === 'usage') {
          inputTokens = event.inputTokens
          outputTokens = event.outputTokens
        }
        await writeStream(response, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, execution.signal)
      }
      failed = false
    } catch (error: unknown) {
      logExecutionFailure(response, execution)
      if (!execution.clientAborted()) {
        await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed: true })
        usageRecorded = true
        await writeStream(response, `event: error\ndata: ${JSON.stringify({ error: execution.timedOut() ? 'request timed out' : 'Codex CLI request failed' })}\n\n`, AbortSignal.timeout(1000))
      }
    } finally {
      execution.release()
      if (!usageRecorded) await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed })
      response.end()
    }
  }))

  app.post('/v1/chat/completions', asyncHandler(async (request, response) => {
    const body = objectBody(request)
    const model = stringOr(body.model, '')
    validateOption(model, config.models, 'model', 'model is not enabled')
    const message = chatPrompt(body.messages)
    const stream = body.stream === true
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new InvalidRequestError('stream must be a boolean')
    const includeUsage = streamIncludesUsage(body.stream_options, stream)
    const effort = body.reasoning_effort === undefined ? undefined : stringOr(body.reasoning_effort, '')
    if (effort !== undefined) validateOption(effort, config.modelEfforts[model] ?? [], 'reasoning_effort', 'reasoning effort is not enabled for this model')
    const sandbox = stringOr(body.sandbox, 'workspace-write')
    validateOption(sandbox, ['read-only', 'workspace-write'], 'sandbox', 'invalid sandbox')
    const identity = apiKeyIdentity(response)
    const workspaceRoot = await keyWorkspaceRoot(config, identity)
    const cwd = await safeDirectory(workspaceRoot, stringOr(body.cwd, '.'))
    const images = await safeImages(config, workspaceRoot, body.images, model)
    const session = sessions.create(cwd, identity.id)
    const completionId = `chatcmpl-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let assistantText = ''
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let sentRole = false
    const execution = await admit(response, identity, admission, config.requestTimeoutMs ?? 600_000, lifecycle.signal)
    if (execution === undefined) {
      sessions.delete(session.id, identity.id)
      return
    }
    let failed = true
    let usageRecorded = false
    if (stream) {
      response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      response.flushHeaders()
    }
    try {
      for await (const event of sessions.run(session, {
        message,
        model,
        reasoningEffort: effort,
        sandbox: sandbox as RunRequest['sandbox'],
        images,
        signal: execution.signal,
      })) {
        if (event.type === 'message') {
          assistantText += event.text
          if (stream) {
            await writeSse(response, execution.signal, completionChunk(completionId, created, model, {
              role: sentRole ? undefined : 'assistant',
              content: event.text,
            }, null, includeUsage))
            sentRole = true
          }
        } else if (event.type === 'usage') {
          inputTokens = event.inputTokens
          outputTokens = event.outputTokens
        }
      }
      await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed: false })
      usageRecorded = true
      if (stream) {
        await writeSse(response, execution.signal, completionChunk(completionId, created, model, { content: undefined }, 'stop', includeUsage))
        if (includeUsage) {
          await writeSse(response, execution.signal, {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: completionUsage(inputTokens, outputTokens),
          })
        }
        await writeSse(response, execution.signal, '[DONE]')
        response.end()
      } else {
        response.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: assistantText }, finish_reason: 'stop' }],
          usage: completionUsage(inputTokens, outputTokens),
        })
      }
      failed = false
    } catch (error: unknown) {
      logExecutionFailure(response, execution)
      if (execution.clientAborted()) {
        if (stream && !response.writableEnded) response.end()
        return
      }
      const timedOut = execution.timedOut()
      if (!usageRecorded) {
        await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed: true })
        usageRecorded = true
      }
      if (stream) {
        await writeSse(response, AbortSignal.timeout(1000), errorBody(timedOut ? 'request timed out' : 'Codex CLI request failed', 'server_error', null, timedOut ? 'timeout' : 'upstream_error'))
        response.end()
      } else {
        response.status(timedOut ? 504 : 502).json(errorBody(timedOut ? 'request timed out' : 'Codex CLI request failed', 'server_error', null, timedOut ? 'timeout' : 'upstream_error'))
      }
      return
    } finally {
      execution.release()
      sessions.delete(session.id, identity.id)
      if (!usageRecorded) await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed })
    }
  }))

  app.post('/v1/responses', asyncHandler(async (request, response) => {
    const body = objectBody(request)
    if (body.previous_response_id !== undefined) return sendError(response, 400, 'previous_response_id is not supported', 'previous_response_id', 'unsupported_value')
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) return sendError(response, 400, 'tools are not supported', 'tools', 'unsupported_value')
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto') return sendError(response, 400, 'tool_choice is not supported', 'tool_choice', 'unsupported_value')
    if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) return sendError(response, 400, 'max_output_tokens is not supported', 'max_output_tokens', 'unsupported_value')
    if (body.temperature !== undefined && body.temperature !== 1) return sendError(response, 400, 'temperature is not supported', 'temperature', 'unsupported_value')
    if (body.top_p !== undefined && body.top_p !== 1) return sendError(response, 400, 'top_p is not supported', 'top_p', 'unsupported_value')
    if (body.store !== undefined && body.store !== false) return sendError(response, 400, 'store is not supported', 'store', 'unsupported_value')
    if (body.truncation !== undefined && body.truncation !== 'disabled') return sendError(response, 400, 'truncation is not supported', 'truncation', 'unsupported_value')
    if (!isDefaultTextFormat(body.text)) return sendError(response, 400, 'text format is not supported', 'text.format', 'unsupported_value')
    if (!isEmptyMetadata(body.metadata)) return sendError(response, 400, 'metadata is not supported', 'metadata', 'unsupported_value')
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new InvalidRequestError('stream must be a boolean')
    const model = stringOr(body.model, config.models[0] ?? '')
    validateOption(model, config.models, 'model', 'model is not enabled')
    const instructions = optionalString(body.instructions, 'instructions')
    const message = responsesPrompt(body.input, instructions)
    const effort = reasoningEffort(body.reasoning)
    if (effort !== undefined) validateOption(effort, config.modelEfforts[model] ?? [], 'reasoning.effort', 'reasoning effort is not enabled for this model')
    const sandbox = stringOr(body.sandbox, 'workspace-write')
    validateOption(sandbox, ['read-only', 'workspace-write'], 'sandbox', 'invalid sandbox')
    const stream = body.stream === true
    const identity = apiKeyIdentity(response)
    const workspaceRoot = await keyWorkspaceRoot(config, identity)
    const cwd = await safeDirectory(workspaceRoot, stringOr(body.cwd, '.'))
    const session = sessions.create(cwd, identity.id)
    const responseId = `resp_${crypto.randomUUID()}`
    const outputItemId = `msg_${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let assistantText = ''
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    let sequenceNumber = 0
    const execution = await admit(response, identity, admission, config.requestTimeoutMs ?? 600_000, lifecycle.signal)
    if (execution === undefined) {
      sessions.delete(session.id, identity.id)
      return
    }
    let failed = true
    let usageRecorded = false
    try {
      if (stream) {
        response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        response.flushHeaders()
        await writeResponseEvent(response, execution.signal, 'response.created', sequenceNumber++, { response: responseObject(responseId, created, model, instructions, effort, 'in_progress', [], undefined, undefined) })
        await writeResponseEvent(response, execution.signal, 'response.in_progress', sequenceNumber++, { response: responseObject(responseId, created, model, instructions, effort, 'in_progress', [], undefined, undefined) })
        await writeResponseEvent(response, execution.signal, 'response.output_item.added', sequenceNumber++, { output_index: 0, item: responseOutputItem(outputItemId, 'in_progress') })
        await writeResponseEvent(response, execution.signal, 'response.content_part.added', sequenceNumber++, { item_id: outputItemId, output_index: 0, content_index: 0, part: responseOutputText('') })
      }
      for await (const event of sessions.run(session, {
        message,
        model,
        reasoningEffort: effort,
        sandbox: sandbox as RunRequest['sandbox'],
        images: [],
        signal: execution.signal,
      })) {
        if (event.type === 'message') {
          assistantText += event.text
          if (stream) await writeResponseEvent(response, execution.signal, 'response.output_text.delta', sequenceNumber++, {
            item_id: outputItemId,
            output_index: 0,
            content_index: 0,
            delta: event.text,
            logprobs: [],
          })
        } else if (event.type === 'usage') {
          inputTokens = event.inputTokens
          outputTokens = event.outputTokens
        }
      }
      await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed: false })
      usageRecorded = true
      const output = [responseOutputItem(outputItemId, 'completed', assistantText)]
      const completed = responseObject(responseId, created, model, instructions, effort, 'completed', output, inputTokens, outputTokens)
      if (stream) {
        await writeResponseEvent(response, execution.signal, 'response.output_text.done', sequenceNumber++, { item_id: outputItemId, output_index: 0, content_index: 0, text: assistantText, logprobs: [] })
        await writeResponseEvent(response, execution.signal, 'response.content_part.done', sequenceNumber++, { item_id: outputItemId, output_index: 0, content_index: 0, part: responseOutputText(assistantText) })
        await writeResponseEvent(response, execution.signal, 'response.output_item.done', sequenceNumber++, { output_index: 0, item: output[0] })
        await writeResponseEvent(response, execution.signal, 'response.completed', sequenceNumber++, { response: completed })
        response.end()
      } else {
        response.json(completed)
      }
      failed = false
    } catch (error: unknown) {
      logExecutionFailure(response, execution)
      if (execution.clientAborted()) {
        if (stream && !response.writableEnded) response.end()
        return
      }
      const timedOut = execution.timedOut()
      if (!usageRecorded) {
        await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed: true })
        usageRecorded = true
      }
      if (stream) {
        await writeResponseEvent(response, AbortSignal.timeout(1000), 'error', sequenceNumber++, { code: timedOut ? 'timeout' : 'upstream_error', message: timedOut ? 'request timed out' : 'Codex CLI request failed', param: null })
        response.end()
      } else {
        response.status(timedOut ? 504 : 502).json(errorBody(timedOut ? 'request timed out' : 'Codex CLI request failed', 'server_error', null, timedOut ? 'timeout' : 'upstream_error'))
      }
      return
    } finally {
      execution.release()
      sessions.delete(session.id, identity.id)
      if (!usageRecorded) await recordUsage(keys, response, identity.id, { inputTokens, outputTokens, failed })
    }
  }))

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      response.destroy()
      return
    }
    const bodyParserError = error instanceof SyntaxError && typeof error === 'object' && error !== null && 'status' in error
    if (error instanceof InvalidRequestError || bodyParserError) {
      response.status(400).json(errorBody(errorMessage(error), 'invalid_request_error', error instanceof InvalidRequestError ? error.param : null, error instanceof InvalidRequestError ? error.code : 'invalid_request'))
      return
    }
    if (process.env.NODE_ENV !== 'test') console.error(JSON.stringify({
      event: 'request_handler_failed',
      requestId: response.locals.requestId as string,
      method: request.method,
      path: request.path,
      apiKeyId: (response.locals.apiKeyIdentity as ApiKeyIdentity | undefined)?.id ?? null,
    }))
    response.status(500).json(errorBody('internal server error', 'server_error', null, 'internal_error'))
  })
  return app
}

async function credentialStatus(root: string, id: string): Promise<'credentials_found' | 'missing' | 'unreadable'> {
  if (!/^key_[0-9a-f]{16}$/.test(id)) return 'unreadable'
  try {
    const file = resolve(root, id, 'auth.json')
    const details = await stat(file)
    if (!details.isFile() || details.size === 0) return 'unreadable'
    await access(file, constants.R_OK)
    return 'credentials_found'
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
}

function logExecutionFailure(response: Response, execution: AdmittedExecution): void {
  if (process.env.NODE_ENV !== 'test') console.error(JSON.stringify({
    event: 'generation_failed', requestId: response.locals.requestId as string,
    category: execution.clientAborted() ? 'client_aborted' : execution.timedOut() ? 'timeout' : 'upstream_error',
  }))
}

function requestContext(request: Request, response: Response, next: NextFunction): void {
  const clientRequestId = request.get('x-client-request-id')
  const requestId = clientRequestId !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(clientRequestId)
    ? clientRequestId
    : `req_${crypto.randomUUID()}`
  const started = Date.now()
  response.locals.requestId = requestId
  response.set('x-request-id', requestId)
  let logged = false
  const log = (outcome: 'completed' | 'aborted'): void => {
    if (logged) return
    logged = true
    if (process.env.NODE_ENV === 'test') return
    const identity = response.locals.apiKeyIdentity as ApiKeyIdentity | undefined
    console.log(JSON.stringify({
      requestId,
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Date.now() - started,
      apiKeyId: identity?.id ?? null,
      outcome,
    }))
  }
  response.once('finish', () => { log('completed') })
  response.once('close', () => { log(response.writableEnded ? 'completed' : 'aborted') })
  next()
}

async function recordUsage(keys: ApiKeyStore, response: Response, apiKeyId: string, usage: ApiKeyUsage): Promise<void> {
  response.locals.generationUsage = usage
  try {
    await keys.recordUsage(apiKeyId, usage)
  } catch {
    if (process.env.NODE_ENV !== 'test') console.error(JSON.stringify({
      event: 'usage_persistence_failed',
      requestId: response.locals.requestId as string,
      apiKeyId,
    }))
  }
}

interface AdmittedExecution {
  signal: AbortSignal
  timedOut(): boolean
  clientAborted(): boolean
  release(): void
}

async function admit(response: Response, identity: ApiKeyIdentity, admission: AdmissionController, timeoutMs: number, shutdown: AbortSignal, includeQueue = false): Promise<AdmittedExecution | undefined> {
  const client = new AbortController()
  const queueTimeout = includeQueue ? AbortSignal.timeout(timeoutMs) : undefined
  const close = (): void => { if (!response.writableEnded) client.abort() }
  response.on('close', close)
  try {
    const lifetime = AbortSignal.any([client.signal, shutdown, ...(queueTimeout ? [queueTimeout] : [])])
    const lease: AdmissionLease = await admission.acquire(identity.id, identity.requestsPerMinute, lifetime)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([lifetime, timeout])
    let released = false
    return {
      signal,
      timedOut: () => timeout.aborted || queueTimeout?.aborted === true,
      clientAborted: () => client.signal.aborted,
      release: () => {
        if (released) return
        released = true
        response.removeListener('close', close)
        lease.release()
      },
    }
  } catch (error: unknown) {
    response.removeListener('close', close)
    if (client.signal.aborted) return undefined
    if (queueTimeout?.aborted) {
      sendError(response, 504, 'Connection test timed out while waiting for capacity. Try again shortly.', null, 'timeout', 'server_error')
      return undefined
    }
    if (shutdown.aborted) {
      sendError(response, 503, 'server is shutting down', null, 'server_shutdown', 'server_error')
      return undefined
    }
    if (error instanceof AdmissionError) {
      response.set('Retry-After', String(error.retryAfterSeconds ?? 1))
      sendError(response, 429, error.message, null, error.code === 'rate_limit' ? 'rate_limit_exceeded' : 'queue_full', 'rate_limit_error')
      return undefined
    }
    throw error
  }
}

function validateKeyPolicy(body: Record<string, unknown>): { message: string; param: string } | undefined {
  if (body.expiresAt !== undefined && body.expiresAt !== null
    && (typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)) || new Date(body.expiresAt).toISOString() !== body.expiresAt)) {
    return { message: 'expiresAt must be a canonical ISO timestamp or null', param: 'expiresAt' }
  }
  if (body.requestsPerMinute !== undefined
    && (typeof body.requestsPerMinute !== 'number' || !Number.isSafeInteger(body.requestsPerMinute) || body.requestsPerMinute <= 0)) {
    return { message: 'requestsPerMinute must be a positive integer', param: 'requestsPerMinute' }
  }
  return undefined
}

function keyPolicy(body: Record<string, unknown>): ApiKeyPolicy {
  return {
    ...(body.expiresAt === null || typeof body.expiresAt === 'string' ? { expiresAt: body.expiresAt } : {}),
    ...(typeof body.requestsPerMinute === 'number' ? { requestsPerMinute: body.requestsPerMinute } : {}),
  }
}

function localAdmin(request: Request, response: Response, next: NextFunction): void {
  const address = request.socket.remoteAddress
  const isLoopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!isLoopback || request.get('x-codex-admin') !== 'local') {
    sendError(response, 403, 'local admin access required', null, 'admin_access_required', 'authentication_error')
    return
  }
  next()
}

function authenticate(keys: ApiKeyStore) {
  return asyncHandler(async (request, response, next) => {
    const header = request.get('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    const identity = await keys.identify(token)
    if (identity === undefined) return sendError(response, 401, 'invalid API key', null, 'invalid_api_key', 'authentication_error')
    response.locals.apiKeyIdentity = identity
    next()
  })
}

function apiKeyIdentity(response: Response): ApiKeyIdentity {
  const identity = response.locals.apiKeyIdentity as ApiKeyIdentity | undefined
  if (identity === undefined) throw new Error('API key identity is missing')
  return identity
}

function asyncHandler(handler: (request: Request, response: Response, next: NextFunction) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const lifecycle = request.app.locals.lifecycle as RequestLifecycle
    void lifecycle.track(handler(request, response, next)).catch(next)
  }
}

function objectBody(request: Request): Record<string, unknown> {
  if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) throw new InvalidRequestError('JSON body must be an object')
  return request.body as Record<string, unknown>
}

function validateOption(value: string, allowed: readonly string[], param: string, message: string): void {
  if (!allowed.includes(value)) throw new InvalidRequestError(message, param, 'invalid_value')
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function chatPrompt(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) throw new InvalidRequestError('messages must be a non-empty array')
  const prompt = value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new InvalidRequestError(`messages[${index}] must be an object`)
    const message = item as Record<string, unknown>
    const role = stringOr(message.role, '')
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) throw new InvalidRequestError(`messages[${index}].role is invalid`)
    return `${role}: ${messageText(message.content, index)}`
  }).join('\n\n')
  if (prompt.length === 0 || prompt.length > 100_000) throw new InvalidRequestError('messages must contain 1-100000 characters')
  return prompt
}

function messageText(value: unknown, index: number): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) throw new InvalidRequestError(`messages[${index}].content must be text`)
  return value.map((part, partIndex) => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) throw new InvalidRequestError(`messages[${index}].content[${partIndex}] must be text`)
    const text = part as Record<string, unknown>
    if (text.type !== 'text' || typeof text.text !== 'string') throw new InvalidRequestError(`messages[${index}].content supports text parts only`)
    return text.text
  }).join('')
}

function responsesPrompt(input: unknown, instructions: string | undefined): string {
  const inputText = typeof input === 'string' ? input : responseInputMessages(input)
  const prompt = instructions === undefined ? inputText : `instructions: ${instructions}\n\n${inputText}`
  if (prompt.length === 0 || prompt.length > 100_000) throw new InvalidRequestError('input and instructions must contain 1-100000 characters')
  return prompt
}

function responseInputMessages(input: unknown): string {
  if (!Array.isArray(input) || input.length === 0) throw new InvalidRequestError('input must be a non-empty string or message array')
  return input.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new InvalidRequestError(`input[${index}] must be a message object`)
    const message = item as Record<string, unknown>
    if (message.type !== undefined && message.type !== 'message') throw new InvalidRequestError(`input[${index}].type is unsupported`)
    const role = stringOr(message.role, '')
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) throw new InvalidRequestError(`input[${index}].role is invalid`)
    return `${role}: ${responseInputText(message.content, index)}`
  }).join('\n\n')
}

function responseInputText(value: unknown, index: number): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) throw new InvalidRequestError(`input[${index}].content must be text`)
  return value.map((part, partIndex) => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) throw new InvalidRequestError(`input[${index}].content[${partIndex}] must be text`)
    const content = part as Record<string, unknown>
    if (!['input_text', 'text'].includes(stringOr(content.type, '')) || typeof content.text !== 'string') throw new InvalidRequestError(`input[${index}].content[${partIndex}].type is unsupported`)
    return content.text
  }).join('')
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new InvalidRequestError(`${name} must be a string`)
  return value
}

function reasoningEffort(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidRequestError('reasoning must be an object')
  return optionalString((value as Record<string, unknown>).effort, 'reasoning.effort')
}

function isDefaultTextFormat(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return true
  if (entries.length !== 1 || entries[0]?.[0] !== 'format') return false
  const format = entries[0][1]
  return typeof format === 'object' && format !== null && !Array.isArray(format)
    && Object.keys(format).length === 1 && (format as Record<string, unknown>).type === 'text'
}

function isEmptyMetadata(value: unknown): boolean {
  return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
}

function responseOutputText(text: string) {
  return { type: 'output_text', text, annotations: [] as unknown[] }
}

function responseOutputItem(id: string, status: 'in_progress' | 'completed', text?: string) {
  return { id, type: 'message', status, role: 'assistant', content: text === undefined ? [] : [responseOutputText(text)] }
}

function responseObject(
  id: string,
  created: number,
  model: string,
  instructions: string | undefined,
  effort: string | undefined,
  status: 'in_progress' | 'completed',
  output: ReturnType<typeof responseOutputItem>[],
  inputTokens: number | undefined,
  outputTokens: number | undefined,
) {
  return {
    id,
    object: 'response',
    created_at: created,
    completed_at: status === 'completed' ? created : null,
    status,
    error: null,
    incomplete_details: null,
    instructions: instructions ?? null,
    max_output_tokens: null,
    metadata: {},
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: effort ?? null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: status === 'completed' ? responseUsage(inputTokens, outputTokens) : null,
  }
}

function responseUsage(inputTokens: number | undefined, outputTokens: number | undefined) {
  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  }
}

function writeResponseEvent(response: Response, signal: AbortSignal, type: string, sequenceNumber: number, data: Record<string, unknown>): Promise<void> {
  return writeStream(response, `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...data })}\n\n`, signal)
}

function completionChunk(id: string, created: number, model: string, delta: { role?: string; content?: string }, finishReason: string | null = null, includeUsage = false) {
  return { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(includeUsage ? { usage: null } : {}) }
}

function streamIncludesUsage(value: unknown, stream: boolean): boolean {
  if (value === undefined) return false
  if (!stream || typeof value !== 'object' || value === null || Array.isArray(value)) throw new InvalidRequestError('stream_options requires stream=true')
  const includeUsage = (value as Record<string, unknown>).include_usage
  if (includeUsage !== undefined && typeof includeUsage !== 'boolean') throw new InvalidRequestError('stream_options.include_usage must be a boolean')
  return includeUsage === true
}

function completionUsage(inputTokens: number | undefined, outputTokens: number | undefined) {
  const promptTokens = inputTokens ?? 0
  const completionTokens = outputTokens ?? 0
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
}

function writeSse(response: Response, signal: AbortSignal, value: unknown): Promise<void> {
  return writeStream(response, `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`, signal)
}

function errorBody(message: string, type: string, param: string | null, code: string | null) {
  return { error: { message, type, param, code } }
}

function sendError(response: Response, status: number, message: string, param: string | null, code: string | null, type = 'invalid_request_error') {
  return response.status(status).json(errorBody(message, type, param, code))
}

async function safeDirectory(root: string, requested: string): Promise<string> {
  try {
    const candidate = await realpath(resolveWorkspacePath(root, requested))
    const realRoot = await realpath(root)
    if (!isInsideWorkspace(realRoot, candidate) || !(await stat(candidate)).isDirectory()) throw new Error()
    return candidate
  } catch {
    throw new InvalidRequestError('cwd must be a directory inside workspace')
  }
}

async function keyWorkspaceRoot(config: AppConfig, identity: ApiKeyIdentity): Promise<string> {
  return safeDirectory(config.workspaceRoot, identity.workspaceRoot ?? '.')
}

async function safeImages(config: AppConfig, root: string, value: unknown, model: string): Promise<string[]> {
  if (value === undefined) return []
  if (!config.imageModels.includes(model)) throw new InvalidRequestError('model does not support images')
  if (!Array.isArray(value) || value.length > 4 || !value.every(item => typeof item === 'string')) throw new InvalidRequestError('images must contain at most four paths')
  const realRoot = await realpath(root)
  const results: string[] = []
  for (const image of value) {
    try {
      const candidate = await realpath(resolveWorkspacePath(realRoot, image))
      if (!isInsideWorkspace(realRoot, candidate) || !(await stat(candidate)).isFile()) throw new Error()
      results.push(candidate)
    } catch {
      throw new InvalidRequestError('image must be a file inside workspace')
    }
  }
  return results
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed'
}

if (!process.env.CODEX_DESKTOP_DATA_DIR && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig()
  await prepareConfig(config)
  const lifecycle = new RequestLifecycle()
  const sessions = new CodexSessionManager(config)
  const app = createApp({ config, lifecycle, sessions })
  const server = createServer(app)
  const shutdown = (): void => {
    // Device login is interactive background work, not an HTTP handler to drain.
    ;(app.locals.loginManager as CodexLoginManager).dispose()
    void lifecycle.shutdown(server, config.shutdownGraceMs).then(() => {
      if (sessions.hasUnterminatedProcesses) throw new Error('Codex CLI did not terminate')
    }).catch(() => {
      console.error(JSON.stringify({ event: 'shutdown_failed' }))
      process.exit(1)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  if (process.platform === 'win32') process.on('SIGBREAK', shutdown)
  server.listen(config.port, config.host, () => {
    console.log(`Codex CLI API listening on http://${config.host}:${config.port}`)
    console.log(`Workspace root: ${config.workspaceRoot}`)
  })
}
