import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiKeyStore } from '../src/auth.js'
import { CodexSessionManager } from '../src/codex.js'
import { createApp } from '../src/server.js'

let server: Server
let root: string
let project: string
let baseURL: string
let stateRoot: string

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-browser-')))
  project = join(root, 'project')
  stateRoot = join(root, 'state')
  await mkdir(project)
  const config = {
    port: 0, host: '127.0.0.1', codexCommand: 'unused-browser-test',
    codexStateRoot: stateRoot, workspaceRoot: project, keyFile: join(root, 'keys.json'),
    models: ['gpt-5.4', 'gpt-5.6-sol'], imageModels: ['gpt-5.4'],
    modelEfforts: { 'gpt-5.4': ['low', 'medium', 'high', 'xhigh'], 'gpt-5.6-sol': ['low', 'high'] },
  }
  const sessions = new CodexSessionManager(config)
  // Exercise real HTTP, key storage, validation and browser code without launching
  // Codex, contacting a provider, or accessing the developer's credentials.
  sessions.run = async function* () {
    yield { type: 'message', text: 'OK' }
    yield { type: 'usage', inputTokens: 5, outputTokens: 2 }
    yield { type: 'done' }
  }
  const app = createApp({ config, keys: new ApiKeyStore(config.keyFile), sessions })
  let loginState = { status: 'idle', message: 'Sign in to Codex for this key.' }
  app.locals.loginManager.start = async () => {
    loginState = { status: 'waiting', message: 'Enter the one-time code.' }
    return { ...loginState, url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' }
  }
  app.locals.loginManager.get = () => ({ ...loginState, ...(loginState.status === 'waiting' ? { url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' } : {}) })
  app.locals.loginManager.cancel = () => (loginState = { status: 'cancelled', message: 'Sign-in cancelled.' })
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture failed to bind')
  baseURL = `http://127.0.0.1:${address.port}`
})

test.afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(root, { recursive: true, force: true })
})

test('desktop dashboard avoids duplicate branding and unsupported tunnel setup', async ({ page }) => {
  await page.goto(baseURL + '/#desktopToken=' + 'a'.repeat(64))
  await expect(page.locator('body')).toHaveClass(/desktop-embedded/)
  await expect(page.locator('.topbar .brand')).toBeHidden()
  await expect(page.locator('#status')).toBeVisible()
  await expect(page.locator('.creator-credit')).toBeHidden()
  await expect(page.locator('.advanced-tunnel')).toBeHidden()
  await expect(page.locator('.desktop-local-note')).toContainText('No tunnel is needed')
  await expect(page.locator('#login-status')).not.toContainText('terminal command')
  await page.goto(baseURL)
  await expect(page.locator('.topbar .brand')).toBeVisible()
  await expect(page.locator('.creator-credit')).toContainText('Created by Dhruv')
  await expect(page.locator('.creator-credit a')).toHaveAttribute('href', 'https://thisisdhruv.in')
})

test('onboarding creates a key, copies platform snippets, selects models and verifies readiness', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(baseURL)
  await expect(page.locator('#metric-total-keys')).toHaveText('0')
  await expect(page.locator('#base-url')).toHaveText(`${baseURL}/v1/chat/completions`)
  await expect(page.locator('#workspace-help')).toContainText(project)

  await page.locator('#key-name').fill('Browser fixture key')
  await page.locator('#key-workspace-root').fill(project)
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/admin/api-keys') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create key', exact: true }).click()
  const response = await createdResponse
  expect(response.status()).toBe(201)
  const created = await response.json()
  expect(new URL(page.url()).search).toBe('')
  await expect(page.locator('#new-secret')).toHaveText(created.key)
  await expect(page.locator('#metric-total-keys')).toHaveText('1')

  await page.locator('#login-codex').click()
  await expect(page.locator('#login-code')).toHaveText('TEST-CODE')
  await expect(page.locator('#login-link')).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
  await page.locator('#login-cancel').click()
  await expect(page.locator('#login-status')).toContainText('cancelled')

  await page.locator('#setup-platform').selectOption('macos')
  await expect(page.locator('#login-example')).toContainText('export CODEX_HOME=')
  await expect(page.locator('#login-example')).toContainText(created.id)
  await page.getByRole('button', { name: 'Copy Codex login setup', exact: true }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.locator('#login-example').textContent())
  await page.locator('#setup-platform').selectOption('windows')
  await expect(page.locator('#login-example')).toContainText('$env:CODEX_HOME=')
  await expect(page.locator('#curl-example')).toContainText('Invoke-RestMethod')
  await page.locator('#setup-model').selectOption('gpt-5.6-sol')
  await page.locator('#setup-reasoning').selectOption('high')
  const clientConfig = JSON.parse(await page.locator('#vscode-example').innerText())
  expect(clientConfig[0].models[0]).toMatchObject({ id: 'gpt-5.6-sol', supportsReasoningEffort: ['low', 'high'] })
  await expect(page.locator('#curl-example')).toContainText('"reasoning_effort":"high"')

  await page.locator('#test-connection').click()
  await expect(page.locator('#test-result')).toContainText(/failed/i)
  await expect(page.locator('#test-result')).toContainText(/login|sign in|credentials/i)

  await mkdir(join(stateRoot, created.id), { recursive: true })
  await writeFile(join(stateRoot, created.id, 'auth.json'), '{}')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.locator('#test-connection').click()
  await expect(page.locator('#test-result')).toContainText(/passed|ready|success/i)
  await expect(page.locator('#request-history')).toContainText('gpt-5.6-sol')
  await expect(page.locator('#request-history')).toContainText('5')
  await page.screenshot({ path: 'output/playwright/dashboard-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'output/playwright/dashboard-mobile.png', fullPage: true })
  expect(errors).toEqual([])
})

test('invalid workspace stays in the form with an actionable error', async ({ page }) => {
  await page.goto(baseURL)
  await expect(page.locator('#metric-total-keys')).toHaveText('0')
  await page.locator('#key-name').fill('Invalid folder')
  await page.locator('#key-workspace-root').fill(join(root, 'missing'))
  await page.getByRole('button', { name: 'Create key', exact: true }).click()
  await expect(page.locator('#workspace-error')).toBeVisible()
  await expect(page.locator('#workspace-error')).not.toBeEmpty()
  expect(new URL(page.url()).search).toBe('')
  await expect(page.locator('#metric-total-keys')).toHaveText('0')
})

test('permanent deletion uses an in-app confirmation, supports cancel and removes only the confirmed key', async ({ page }) => {
  const store = new ApiKeyStore(join(root, 'keys.json'))
  const doomed = await store.create('Disposable deletion fixture', { workspaceRoot: '.' })
  const retained = await store.create('Keep this fixture', { workspaceRoot: '.' })
  await store.update(doomed.id, { active: false })
  await mkdir(join(stateRoot, doomed.id), { recursive: true })
  await writeFile(join(stateRoot, doomed.id, 'auth.json'), '{}')
  // Reproduce the embedded WebView: browser confirm cannot be used here.
  await page.addInitScript(() => { window.confirm = () => { throw new Error('Browser confirm is unavailable'); } })
  await page.goto(baseURL + '/#desktopToken=' + 'a'.repeat(64))
  const trigger = page.getByRole('button', { name: 'Permanently delete API key Disposable deletion fixture', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Delete API key permanently?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Disposable deletion fixture')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await store.list()).toHaveLength(2)
  await access(join(stateRoot, doomed.id, 'auth.json'))
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(await store.list()).toHaveLength(2)
  await trigger.click()
  const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith(doomed.id))
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click()
  expect((await deleted).status()).toBe(204)
  await expect(trigger).toHaveCount(0)
  expect((await store.list()).map(key => key.id)).toEqual([retained.id])
  await expect(access(join(stateRoot, doomed.id))).rejects.toMatchObject({ code: 'ENOENT' })
})
