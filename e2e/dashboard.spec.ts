import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { access, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ApiKeyStore } from '../src/auth.js'
import { CodexSessionManager } from '../src/codex.js'
import { createApp } from '../src/server.js'

let server: Server
let root: string
let project: string
let baseURL: string
let stateRoot: string
let inferenceCalls: number
let finishLogin: () => void

const views = ['overview', 'api-keys', 'connect', 'requests', 'diagnostics', 'settings'] as const
type View = typeof views[number]
type Theme = 'light' | 'dark'

async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator(`#theme-${theme}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(`#theme-${theme === 'dark' ? 'light' : 'dark'}`)).toHaveAttribute('aria-pressed', 'false')
}

async function expectWizardStep(page: Page, step: number) {
  await expect(page.locator('#wizard-progress')).toBeVisible()
  await expect(page.locator('#wizard-progress li')).toHaveCount(4)
  await expect(page.locator('#wizard-progress [aria-current="step"]')).toHaveText(new RegExp(`^${step}\\.`))
  await expect(page.locator('#wizard-stage')).toHaveAttribute('data-step', String(step))
  await expect(page.locator('#wizard-title')).toContainText([/workspace/i, /create.*key/i, /sign in/i, /test/i][step - 1])
}

async function navigate(page: Page, view: View) {
  const item = page.getByRole('navigation', { name: 'Primary' }).locator(`[data-view="${view}"]`)
  await item.click()
  await expect(page.locator(`#view-${view}`)).toBeVisible()
  await expect(page.locator('[data-view-panel]:visible')).toHaveCount(1)
  await expect(item).toHaveAttribute('aria-current', 'page')
}

async function openCreate(page: Page) {
  await page.locator('[data-create-key]:visible').first().click()
  await expect(page.locator('#create-dialog')).toBeVisible()
}

async function createKey(page: Page, name = 'Browser fixture key') {
  await openCreate(page)
  const created = await submitCreate(page, name)
  await page.locator('#secret-continue').click()
  await expect(page.locator('#create-dialog')).toBeHidden()
  return created
}

async function submitCreate(page: Page, name = 'Browser fixture key') {
  await page.locator('#key-name').fill(name)
  await page.locator('#key-workspace-root').fill(project)
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/admin/api-keys') && response.request().method() === 'POST')
  await page.locator('#create-form').getByRole('button', { name: 'Create key', exact: true }).click()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  const created = await response.json() as { id: string; key: string }
  await expect(page.locator('#new-secret')).toHaveText(created.key)
  expect(new URL(page.url()).search).toBe('')
  return created
}

async function refresh(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/admin/setup'))
  await page.locator('#page-refresh').click()
  await response
  await expect(page.locator('#status')).toContainText('up to date')
}

async function saveCredentials(id: string) {
  await mkdir(join(stateRoot, id), { recursive: true })
  await writeFile(join(stateRoot, id, 'auth.json'), '{}')
}

async function openTrustedDesktop(page: Page, {firstRun = false} = {}) {
  // Use the native HTTP origin so both directions of the real postMessage
  // handshake are exercised, including defaults sent back into the dashboard.
  const launcher = 'http://tauri.localhost'
  await page.route(baseURL + '/**', async route => route.fulfill({response:await route.fetch()}))
  await page.route(launcher + '/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'index.html'
    if (!['index.html', 'app.js', 'styles.css', 'branding.css', 'logo.png'].includes(name)) return route.abort()
    await route.fulfill({
      body:await readFile(resolve('desktop', name)),
      contentType:name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'text/html',
    })
  })
  await page.addInitScript(({url, workspace, firstRun}) => {
    if (firstRun && location.origin === url) {
      localStorage.setItem('codex-dashboard-ui', JSON.stringify({view:'settings', step:1}))
    }
    if (location.hostname !== 'tauri.localhost') return
    let running = !firstRun
    let token = 'a'.repeat(64)
    let settings = {workspaceRoot:firstRun ? '' : workspace, port:Number(new URL(url).port)}
    ;(window as any).__TAURI__ = {core:{invoke:async (command: string, args?: {settings:typeof settings}) => {
      if (command === 'check_for_update') return {message:'No update available.'}
      if (command === 'save_settings') { settings = args!.settings; return settings }
      if (command === 'stop_gateway') running = false
      else if (command === 'start_gateway') {
        // The native process creates a fresh capability URL on every start.
        token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
        running = true
      }
      else if (command !== 'desktop_status') throw new Error(`Unexpected native command: ${command}`)
      return {
        running, dashboardUrl:running ? url + '/#desktopToken=' + token : null,
        settings,
      }
    }}}
  }, {url:baseURL, workspace:project, firstRun})
  await page.goto(launcher)
  if (firstRun) {
    await expect(page.locator('#first-run-host')).toBeVisible()
    await page.locator('#workspace').fill(project)
    await page.locator('#start').click()
  }
  await expect(page.locator('body')).toHaveClass(/connected/)
  const dashboard = page.frameLocator('#dashboard')
  await expect(dashboard.locator('#status')).toContainText('up to date')
  return dashboard
}

test.beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-browser-')))
  project = join(root, 'project')
  stateRoot = join(root, 'state')
  await mkdir(project)
  await mkdir(stateRoot)
  inferenceCalls = 0
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
    inferenceCalls++
    yield { type: 'message', text: 'OK' }
    yield { type: 'usage', inputTokens: 5, outputTokens: 2 }
    yield { type: 'done' }
  }
  const app = createApp({ config, keys: new ApiKeyStore(config.keyFile), sessions })
  let loginState = { status: 'idle', message: 'Sign in to Codex for this key.' }
  finishLogin = () => { loginState = { status: 'success', message: 'Signed in. Test the connection to verify credentials.' } }
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
  await expect(page.locator('#status')).toBeVisible()
  await expect(page.locator('.brand-logo:visible')).toHaveCount(1)
  await expect(page.locator('.creator-credit')).toContainText('thisisdhruv.in')
  await expect(page.locator('.advanced-tunnel')).toBeHidden()
  await expect(page.locator('.desktop-local-note')).toContainText('No tunnel is needed')
  await navigate(page, 'connect')
  await expect(page.locator('#login-status')).not.toContainText('terminal command')
  await page.goto(baseURL)
  await expect(page.locator('.brand-logo:visible')).toHaveCount(1)
  await expect(page.locator('.creator-credit')).toContainText('Created by Dhruv')
  await expect(page.locator('.creator-credit a')).toHaveAttribute('href', 'https://thisisdhruv.in')
})

test('sidebar always shows a single view and restores the URL route through reload and back', async ({ page }) => {
  await page.goto(baseURL)
  await expect(page.locator('[data-view-panel]:visible')).toHaveCount(1)
  for (const view of views) {
    await navigate(page, view)
    await expect(page.locator('.app-sidebar')).toBeVisible()
    await expect(page.locator('.creator-credit')).toBeVisible()
  }
  await navigate(page, 'requests')
  const requestsURL = page.url()
  await page.reload()
  await expect(page.locator('#view-requests')).toBeVisible()
  await expect(page.locator('[data-view-panel]:visible')).toHaveCount(1)
  await navigate(page, 'diagnostics')
  expect(page.url()).not.toBe(requestsURL)
  await page.goBack()
  await expect(page).toHaveURL(requestsURL)
  await expect(page.locator('#view-requests')).toBeVisible()
  await expect(page.locator('[data-view-panel]:visible')).toHaveCount(1)
  await page.setViewportSize({ width: 760, height: 600 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('theme controls persist the selected appearance across every route and reload', async ({page}) => {
  await page.goto(baseURL)
  for (const theme of ['dark', 'light'] as const) {
    await page.locator(`#theme-${theme}`).click()
    await expectTheme(page, theme)
    expect(await page.evaluate(() => localStorage.getItem('codex-ui-theme'))).toBe(theme)
    for (const view of views) {
      await navigate(page, view)
      await expectTheme(page, theme)
    }
    await page.reload()
    await expect(page.locator('#view-settings')).toBeVisible()
    await expectTheme(page, theme)
    await navigate(page, 'overview')
    await expectTheme(page, theme)
  }
})

test('real embedded dashboard opens inline native Settings from its persistent sidebar', async ({page}) => {
  // Forward to the real fixture server through Playwright's request context;
  // Chromium's public-host-to-loopback restrictions do not model Tauri's origin.
  await page.route(baseURL + '/**', async route => route.fulfill({response:await route.fetch()}))
  await page.route('http://launcher.test/**', async route => {
    const name = new URL(route.request().url()).pathname.slice(1) || 'index.html'
    if (!['index.html','app.js','styles.css','branding.css','logo.png'].includes(name)) return route.abort()
    await route.fulfill({body:await readFile(resolve('desktop',name)),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/html'})
  })
  await page.addInitScript(({url,workspace}) => {
    if (location.hostname !== 'launcher.test') return
    ;(window as any).__TAURI__ = {core:{invoke:async (command:string) => {
      if (command === 'check_for_update') throw new Error('Could not fetch a valid release JSON from the remote')
      if (command !== 'desktop_status') throw new Error('Unexpected native command')
      return {running:true,dashboardUrl:url+'/#desktopToken='+'a'.repeat(64),settings:{workspaceRoot:workspace,port:Number(new URL(url).port)}}
    }}}
  }, {url:baseURL,workspace:project})
  await page.setViewportSize({width:1280,height:900})
  await page.goto('http://launcher.test')
  await expect(page.locator('body')).toHaveClass(/connected/)
  await expect(page.locator('body > header')).toBeHidden()
  await expect(page.locator('#native-sidebar')).toBeHidden()
  const dashboard = page.frameLocator('#dashboard')
  await expect(dashboard.locator('[data-view-panel]:visible')).toHaveCount(1)
  for (const viewport of [{width:1280,height:900}, {width:760,height:600}]) {
    await page.setViewportSize(viewport)
    for (const theme of ['light', 'dark'] as const) {
      await dashboard.locator(`#theme-${theme}`).click()
      await expect(dashboard.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await dashboard.getByRole('navigation', {name:'Primary'}).locator('[data-view="settings"]').click()
      await expect(page.locator('#settings-panel')).toBeVisible()
      await expect(page.locator('dialog:visible')).toHaveCount(0)
      await expect(dashboard.locator('.app-sidebar')).toBeVisible()
      await expect(dashboard.locator('.creator-credit')).toBeVisible()
      await expect(page.locator('#update-status')).toContainText('Update information isn’t available yet')
      await expect(page.locator('#update-error-detail')).toBeHidden()
      await page.screenshot({path:`output/playwright/dashboard-inline-settings-${theme}-${viewport.width}x${viewport.height}.png`})
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await dashboard.getByRole('navigation', {name:'Primary'}).locator('[data-view="overview"]').click()
      await expect(page.locator('#settings-panel')).toBeHidden()
      await expect(dashboard.locator('#view-overview')).toBeVisible()
      expect((await page.locator('#dashboard').boundingBox())!.height).toBeGreaterThan(viewport.height - 100)
    }
  }
})

test('audit regression: native Gateway default resets the configured model and reasoning', async ({page}) => {
  await new ApiKeyStore(join(root, 'keys.json')).create('Native defaults fixture', {workspaceRoot:'.'})
  const dashboard = await openTrustedDesktop(page)
  const navigation = dashboard.getByRole('navigation', {name:'Primary'})
  await navigation.locator('[data-view="settings"]').click()
  await expect(page.locator('#settings-panel')).toBeVisible()
  await expect(page.locator('#default-model')).toBeEnabled()
  await page.locator('#default-model').selectOption('gpt-5.6-sol')
  await page.locator('#default-reasoning').selectOption('high')
  await page.locator('#save-defaults').click()
  await expect(dashboard.locator('#setup-model')).toHaveValue('gpt-5.6-sol')
  await expect(dashboard.locator('#setup-reasoning')).toHaveValue('high')

  await page.locator('#default-model').selectOption('')
  await page.locator('#save-defaults').click()
  await expect(page.locator('#defaults-status')).toHaveText('Defaults saved.')
  await navigation.locator('[data-view="connect"]').click()
  await expect(page.locator('#settings-panel')).toBeHidden()
  await expect(dashboard.locator('#setup-model')).toHaveValue('gpt-5.4')
  await expect(dashboard.locator('#setup-reasoning')).toHaveValue('')
  await expect(dashboard.locator('#curl-example')).not.toContainText('reasoning_effort')
  expect(JSON.parse(await dashboard.locator('#vscode-example').innerText())[0].models[0].id).toBe('gpt-5.4')

  await page.reload()
  await expect(dashboard.locator('#status')).toContainText('up to date')
  await expect(dashboard.locator('#view-connect')).toBeVisible()
  await expect(dashboard.locator('#setup-model')).toHaveValue('gpt-5.4')
  await expect(dashboard.locator('#setup-reasoning')).toHaveValue('')
  expect(inferenceCalls).toBe(0)
})

test('audit regression: a saved Settings route restores the native inline panel on relaunch', async ({page}) => {
  const dashboard = await openTrustedDesktop(page)
  await dashboard.getByRole('navigation', {name:'Primary'}).locator('[data-view="settings"]').click()
  await expect(page.locator('#settings-panel')).toBeVisible()
  // Reload the whole native shell: its JS state and hidden panel reset, while
  // the dashboard's origin-scoped saved route survives the fresh iframe.
  await page.reload()
  await expect(dashboard.locator('#view-settings')).toBeVisible()
  await expect(page.locator('#settings-panel')).toBeVisible()
  await expect(page.locator('#workspace')).toBeVisible()
  await expect(page.locator('#workspace')).toHaveValue(project)
  await expect(page.locator('#native-sidebar')).toBeHidden()
  await expect(dashboard.getByRole('navigation', {name:'Primary'}).locator('[data-view="settings"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('dialog:visible')).toHaveCount(0)

  // Save/restart replaces the iframe while its old saved route is Settings.
  // Native's queued Overview override must win, and its ACK must close Settings.
  await page.locator('#start').click()
  await expect(dashboard.locator('#status')).toContainText('up to date')
  await expect(dashboard.locator('#view-overview')).toBeVisible()
  await expect(dashboard.getByRole('navigation', {name:'Primary'}).locator('[data-view="overview"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#settings-panel')).toBeHidden()
  await expect(dashboard.locator('[data-view-panel]:visible')).toHaveCount(1)
  expect(inferenceCalls).toBe(0)
})

test('audit regression: first-run native onboarding overrides a previously saved Settings route', async ({page}) => {
  const dashboard = await openTrustedDesktop(page, {firstRun:true})
  await expect(dashboard.locator('#view-onboarding')).toBeVisible()
  await expect(dashboard.locator('#wizard-stage')).toHaveAttribute('data-step', '2')
  await expect(dashboard.locator('#wizard-progress [aria-current="step"]')).toContainText('Create an API key')
  await expect(dashboard.locator('#wizard-stage #create-form')).toBeVisible()
  await expect(dashboard.locator('#view-settings')).toBeHidden()
  await expect(page.locator('#settings-panel')).toBeHidden()
  await expect(page.locator('#first-run-host')).toBeHidden()
  await expect(dashboard.locator('[data-view-panel]:visible')).toHaveCount(1)
  expect(inferenceCalls).toBe(0)
})

for (const failure of ['gateway', 'gateway workspace', 'key workspace'] as const) {
  test(`audit regression: prior test success cannot finish onboarding with unhealthy ${failure}`, async ({page, request}) => {
    const key = await new ApiKeyStore(join(root, 'keys.json')).create('Readiness fixture', {workspaceRoot:'.'})
    await saveCredentials(key.id)
    const tested = await request.post(`${baseURL}/admin/api-keys/${key.id}/test`, {
      headers:{'X-Codex-Admin':'local'}, data:{model:'gpt-5.4'},
    })
    expect(tested.status()).toBe(200)
    expect((await tested.json()).ok).toBe(true)
    await page.goto(baseURL)
    await navigate(page, 'overview')
    await page.locator('#setup-continue').click()
    for (const step of [1, 2, 3]) {
      await expectWizardStep(page, step)
      await page.locator('#wizard-next').click()
    }
    await expectWizardStep(page, 4)
    await expect(page.locator('#wizard-next')).toBeEnabled()

    await page.route('**/admin/health', async route => {
      const response = await route.fetch()
      const health = await response.json()
      if (failure !== 'key workspace') health.gateway.ready = false
      if (failure === 'gateway workspace') health.gateway.workspaceAccessible = false
      const selected = health.keys.find((entry: {id:string}) => entry.id === key.id)
      selected.ready = false
      if (failure === 'key workspace') selected.workspaceAccessible = false
      await route.fulfill({response, json:health})
    })
    await refresh(page)
    await expect(page.locator('#wizard-next')).toBeDisabled()
    await expect(page.locator('#wizard-progress li').nth(3)).toHaveAttribute('data-complete', 'false')
    await expect(page.locator('#test-result')).toContainText(/passed/i)
    await navigate(page, 'overview')
    await expect(page.locator('#setup-checklist li').nth(3)).toHaveAttribute('data-complete', 'false')
    await navigate(page, 'connect')
    await expect(page.locator('#setup-progress')).not.toContainText(/ready to (?:configure|use)|ready for/i)
    await expect(page.locator('#setup-progress')).toContainText(/health|workspace|unavailable|not ready|inaccessible/i)
    expect(inferenceCalls).toBe(1)

    await page.unroute('**/admin/health')
    await refresh(page)
    await navigate(page, 'overview')
    await page.locator('#setup-continue').click()
    await expectWizardStep(page, 4)
    await expect(page.locator('#wizard-next')).toBeEnabled()
    expect(inferenceCalls).toBe(1)
  })
}

test('four-step onboarding requires creation, simulated sign-in and an explicit connection test', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(baseURL)
  await navigate(page, 'overview')
  await page.locator('#setup-continue').click()
  await expect(page.locator('#view-onboarding')).toBeVisible()
  await expectWizardStep(page, 1)
  await expect(page.locator('#wizard-stage')).toContainText(/workspace/i)
  await expect(page.locator('#wizard-back')).toBeDisabled()
  await page.locator('#wizard-next').click()
  await expectWizardStep(page, 2)
  await expect(page.locator('#wizard-next')).toBeDisabled()
  await page.locator('#wizard-back').click()
  await expectWizardStep(page, 1)
  await page.locator('#wizard-next').click()
  await expect(page.locator('#wizard-stage #create-form')).toBeVisible()
  await page.screenshot({path:'output/playwright/dashboard-onboarding-create.png'})
  const created = await submitCreate(page)
  await expect(page.locator('#view-onboarding')).toBeVisible()
  await expectWizardStep(page, 2)
  await page.locator('#wizard-next').click()
  await expectWizardStep(page, 3)
  await expect(page.locator('#wizard-next')).toBeDisabled()
  await page.locator('#login-codex').click()
  await expect(page.locator('#login-code')).toHaveText('TEST-CODE')
  await page.screenshot({path:'output/playwright/dashboard-onboarding-signin.png'})
  await expect(page.locator('#login-link')).toHaveAttribute('href', 'https://auth.openai.com/codex/device')
  await page.locator('#login-cancel').click()
  await expect(page.locator('#login-status')).toContainText('cancelled')
  await page.locator('#login-codex').click()
  await expect(page.locator('#login-code')).toHaveText('TEST-CODE')
  await saveCredentials(created.id)
  finishLogin()
  await refresh(page)
  await expect(page.locator('#wizard-next')).toBeEnabled()
  await expect(page.locator('#login-codex')).toBeDisabled()
  await expect(page.locator('#login-codex')).toHaveText('Signed in')
  await expect(page.locator('#login-again')).toBeVisible()
  expect(inferenceCalls).toBe(0)
  await page.locator('#wizard-next').click()
  await expectWizardStep(page, 4)
  await expect(page.locator('#wizard-stage')).toContainText(/test/i)
  await page.screenshot({path:'output/playwright/dashboard-onboarding-test.png'})
  await expect(page.locator('#wizard-next')).toBeDisabled()
  expect(inferenceCalls).toBe(0)
  await page.locator('#test-connection').click()
  await expect(page.locator('#test-result')).toContainText(/passed|ready|success/i)
  expect(inferenceCalls).toBe(1)
  await expect(page.locator('#wizard-next')).toBeEnabled()
  await page.locator('#wizard-next').click()
  await expect(page.locator('#view-overview')).toBeVisible()
  await expect(page.locator('#setup-checklist li')).toHaveCount(4)
  await expect(page.locator('#setup-checklist li[data-complete="true"]')).toHaveCount(4)
  await expect(page.locator('#metric-total-keys')).toHaveText('1')
  await navigate(page, 'connect')
  await expect(page.locator('#base-url')).toHaveText(`${baseURL}/v1/chat/completions`)
  await page.locator('.terminal-login summary').click()
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
  await expect(page.locator('#test-result')).toContainText(/passed|ready|success/i)
  await navigate(page, 'requests')
  await expect(page.locator('#request-history')).toContainText('gpt-5.6-sol')
  await expect(page.locator('#request-history')).toContainText('5')
  const storage = await page.evaluate(() => JSON.stringify({ local: {...localStorage}, session: {...sessionStorage} }))
  expect(storage).not.toContain(created.key)
  expect(errors).toEqual([])
})

test('completed sign-in is muted, survives refresh, and allows an explicit retry or another key', async ({page}) => {
  const store = new ApiKeyStore(join(root, 'keys.json'))
  const signedIn = await store.create('Signed-in project', {workspaceRoot:'.'})
  const other = await store.create('Another project', {workspaceRoot:'.'})
  await saveCredentials(signedIn.id)
  await page.goto(baseURL)
  await navigate(page, 'connect')
  await page.locator('#setup-key').selectOption(signedIn.id)
  const login = page.locator('#login-codex')
  await expect(login).toBeDisabled()
  await expect(login).toHaveText('Signed in')
  await expect(login).toHaveCSS('background-color', 'rgb(243, 240, 232)')
  await expect(page.locator('#login-again')).toBeEnabled()
  await page.reload()
  await expect(login).toBeDisabled()
  await expect(login).toHaveText('Signed in')
  await page.locator('#login-again').click()
  await expect(page.locator('#login-code')).toHaveText('TEST-CODE')
  await expect(login).toBeDisabled()
  await expect(login).toHaveText('Signing in…')
  await expect(page.locator('#login-again')).toBeHidden()
  await page.locator('#login-cancel').click()
  await expect(login).toHaveText('Signed in')
  await page.locator('#theme-dark').click()
  await expect(login).toHaveCSS('background-color', 'rgb(35, 38, 48)')
  await page.screenshot({path:'output/playwright/dashboard-signed-in-dark.png'})
  await page.locator('#setup-key').selectOption(other.id)
  await expect(login).toBeEnabled()
  await expect(login).toHaveText('Sign in to Codex ↗')
  await expect(page.locator('#login-again')).toBeHidden()
  await page.locator('#setup-key').selectOption(signedIn.id)
  await expect(login).toBeDisabled()
  await rm(join(stateRoot, signedIn.id, 'auth.json'))
  await refresh(page)
  await expect(login).toBeEnabled()
  await expect(page.locator('#login-again')).toBeHidden()
  expect(inferenceCalls).toBe(0)
})

test('invalid workspace stays in the form with an actionable error', async ({ page }) => {
  await page.goto(baseURL)
  await navigate(page, 'api-keys')
  await openCreate(page)
  await expect(page.locator('#workspace-help')).toContainText(project)
  await page.locator('#key-name').fill('Invalid folder')
  await page.locator('#key-workspace-root').fill(join(root, 'missing'))
  await page.getByRole('button', { name: 'Create key', exact: true }).click()
  await expect(page.locator('#workspace-error')).toBeVisible()
  await expect(page.locator('#workspace-error')).not.toBeEmpty()
  await expect(page.locator('#create-dialog')).toBeVisible()
  await expect(page.locator('#key-name')).toHaveValue('Invalid folder')
  expect(new URL(page.url()).search).toBe('')
  expect(await new ApiKeyStore(join(root, 'keys.json')).list()).toHaveLength(0)
  await page.locator('#close-create').click()
  await expect(page.locator('#create-dialog')).toBeHidden()
  await navigate(page, 'overview')
  await expect(page.locator('#metric-total-keys')).toHaveText('0')
})

test('key search and status filters do not hide onboarding or change key state', async ({ page }) => {
  const store = new ApiKeyStore(join(root, 'keys.json'))
  const active = await store.create('Work project', { workspaceRoot: '.' })
  const inactive = await store.create('Personal project', { workspaceRoot: '.' })
  await store.update(inactive.id, { active: false })
  await page.goto(baseURL)
  await navigate(page, 'api-keys')
  await expect(page.locator('.key-card')).toHaveCount(2)
  await page.getByLabel('Search keys').fill('Personal')
  await expect(page.locator('.key-card')).toHaveCount(1)
  await expect(page.locator('.key-card')).toContainText('Personal project')
  await page.getByLabel('Key status').selectOption('active')
  await expect(page.locator('#keys')).toContainText('No keys match')
  await page.getByLabel('Search keys').fill('')
  await expect(page.locator('.key-card')).toHaveCount(1)
  await expect(page.locator('.key-card')).toContainText('Work project')
  await navigate(page, 'overview')
  await expect(page.getByLabel('Setup checklist')).toContainText('Choose workspace')
  expect((await store.list()).find(key => key.id === active.id)?.active).toBe(true)
})

test('health checks and diagnostic reports never trigger inference', async ({ page }) => {
  await page.goto(baseURL)
  await navigate(page, 'diagnostics')
  await page.getByRole('button', { name: 'Run health check', exact: true }).click()
  await expect(page.locator('#health-results')).toContainText('Workspace')
  await expect(page.locator('#health-results')).toContainText(/accessible/i)
  await page.getByRole('button', { name: 'Prepare diagnostic report', exact: true }).click()
  await expect(page.locator('#diagnostic-report')).toBeVisible()
  await expect(page.locator('#diagnostic-report')).toContainText('"sessionCredentialsIncluded": false')
  await expect(page.locator('#diagnostic-report')).not.toContainText(project)
  expect(inferenceCalls).toBe(0)
  await navigate(page, 'overview')
  await expect(page.locator('#metric-requests')).toHaveText('0')
})

test('empty Connect offers key creation and dialog cancellation leaves the route intact', async ({ page }) => {
  await page.goto(baseURL)
  await navigate(page, 'connect')
  await expect(page.locator('#connect-empty')).toBeVisible()
  await page.locator('#connect-empty [data-create-key]').click()
  await expect(page.locator('#create-dialog')).toBeVisible()
  await page.locator('#key-name').fill('Unsaved key')
  await page.locator('#close-create').click()
  await expect(page.locator('#create-dialog')).toBeHidden()
  await expect(page.locator('#view-connect')).toBeVisible()
  await openCreate(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('#create-dialog')).toBeHidden()
  expect(await new ApiKeyStore(join(root, 'keys.json')).list()).toHaveLength(0)
  await createKey(page, 'Connect CTA key')
  await expect(page.locator('#connect-empty')).toBeHidden()
  await expect(page.locator('#setup-key')).toContainText('Connect CTA key')
  await page.locator('#test-connection').click()
  await expect(page.locator('#test-result')).toContainText(/failed.*sign in/i)
  expect(inferenceCalls).toBe(0)
})

test('Requests refreshes, searches, combines three filters, inspects rows and exports only metadata', async ({ page, request }) => {
  const store = new ApiKeyStore(join(root, 'keys.json'))
  const first = await store.create('Work requests', { workspaceRoot: '.' })
  const second = await store.create('Personal requests', { workspaceRoot: '.' })
  const failed = await request.post(`${baseURL}/admin/api-keys/${first.id}/test`, { headers: {'X-Codex-Admin':'local'}, data: {model:'gpt-5.4'} })
  expect(failed.status()).toBe(409)
  await saveCredentials(first.id)
  await saveCredentials(second.id)
  const privatePrompt = 'PRIVATE_PROMPT_NOT_FOR_HISTORY'
  for (const [key, model] of [[first, 'gpt-5.4'], [second, 'gpt-5.6-sol']] as const) {
    const response = await request.post(`${baseURL}/v1/chat/completions`, {
      headers: { Authorization: `Bearer ${key.key}` },
      data: { model, messages: [{role:'user', content:privatePrompt}] },
    })
    expect(response.status()).toBe(200)
  }
  await page.goto(baseURL)
  await navigate(page, 'requests')
  const rows = page.locator('#request-history tr')
  await expect(rows).toHaveCount(3)
  await page.locator('#history-key-filter').selectOption(first.id)
  await expect(rows).toHaveCount(2)
  await page.locator('#history-model-filter').selectOption('gpt-5.4')
  await page.locator('#history-result-filter').selectOption('failed')
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('409')
  await page.locator('#history-model-filter').selectOption('gpt-5.6-sol')
  await expect(rows).toHaveCount(0)
  await expect(page.locator('#history-status')).toContainText(/no requests match/i)
  for (const id of ['history-key-filter', 'history-model-filter', 'history-result-filter']) {
    await page.locator(`#${id}`).selectOption('all')
  }
  await page.locator('#history-search').fill('Personal requests')
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('gpt-5.6-sol')
  await rows.first().click()
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  const detail = page.locator('#request-detail-panel')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('gpt-5.6-sol')
  await expect(detail).toContainText('200')
  await expect(detail).toContainText('/v1/chat/completions')
  await page.screenshot({path:'output/playwright/dashboard-request-detail.png'})
  await page.locator('#request-detail-close').click()
  await expect(detail).toBeHidden()
  await rows.first().focus()
  await page.keyboard.press('Enter')
  await expect(detail).toBeVisible()
  const historyResponse = page.waitForResponse(response => response.url().endsWith('/admin/requests'))
  await page.locator('#history-refresh').click()
  expect((await historyResponse).ok()).toBe(true)
  await expect(page.locator('#history-search')).toHaveValue('Personal requests')
  await expect(rows).toHaveCount(1)
  await page.locator('#history-search').fill('')
  await expect(rows).toHaveCount(3)
  const metadata = await (await request.get(`${baseURL}/admin/requests`, {headers:{'X-Codex-Admin':'local'}})).json()
  expect(metadata.data).toHaveLength(3)
  expect(metadata.data.some((row: {inputTokens: number; outputTokens: number}) => row.inputTokens === 5 && row.outputTokens === 2)).toBe(true)
  const downloadPromise = page.waitForEvent('download')
  await page.locator('#history-export').click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).toBeTruthy()
  const exported = await readFile(path!, 'utf8')
  expect(exported).toContain('gpt-5.4')
  expect(exported).toContain('gpt-5.6-sol')
  for (const surface of [JSON.stringify(metadata), await page.locator('#view-requests').innerText(), exported]) {
    for (const secret of [first.key, second.key, privatePrompt, project, stateRoot]) expect(surface).not.toContain(secret)
  }
  expect(inferenceCalls).toBe(2)
})

test('setup and health failures remain actionable and recover on explicit refresh', async ({ page }) => {
  const store = new ApiKeyStore(join(root, 'keys.json'))
  await store.create('Recovery fixture', { workspaceRoot: '.' })
  await page.route('**/admin/setup', route => route.fulfill({status:503,json:{error:{message:'Fixture setup unavailable'}}}))
  await page.route('**/admin/health', route => route.fulfill({status:503,json:{error:{message:'Fixture health unavailable'}}}))
  await page.goto(baseURL)
  await navigate(page, 'connect')
  await expect(page.locator('#setup-progress')).toContainText(/unavailable.*refresh/i)
  await expect(page.locator('#test-connection')).toBeDisabled()
  await navigate(page, 'diagnostics')
  await page.locator('#health-check').click()
  await expect(page.locator('#status')).toContainText(/unavailable.*review settings.*retry/i)
  await expect(page.locator('#health-results')).toContainText('Status unavailable')
  await expect(page.locator('#recovery-panel').getByRole('button', {name:'Review settings'}).first()).toBeVisible()
  await expect(page.locator('#health-check')).toBeEnabled()
  await page.unroute('**/admin/setup')
  await page.unroute('**/admin/health')
  await refresh(page)
  await page.locator('#health-check').click()
  await expect(page.locator('#health-results article').filter({has:page.getByRole('heading', {name:'Workspace',exact:true})})).toContainText('Accessible')
  await navigate(page, 'connect')
  await expect(page.locator('#setup-model')).toContainText('gpt-5.4')
  expect(inferenceCalls).toBe(0)
})

for (const viewport of [{width:1280,height:900}, {width:760,height:600}]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`all six pages preserve their ${theme} shell at ${viewport.width}x${viewport.height}`, async ({page}) => {
      await new ApiKeyStore(join(root, 'keys.json')).create('Visual fixture project', {workspaceRoot:'.'})
      await page.setViewportSize(viewport)
      await page.goto(baseURL)
      await expect(page.locator('#status')).toContainText('up to date')
      await page.locator(`#theme-${theme}`).click()
      await expectTheme(page, theme)
      for (const view of views) {
        await navigate(page, view)
        await expect(page.locator('.app-sidebar')).toBeInViewport()
        await expect(page.locator('.creator-credit')).toBeVisible()
        await expect(page.locator('.brand-logo:visible')).toHaveCount(1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({path:`output/playwright/dashboard-${view}-${theme}-${viewport.width}x${viewport.height}.png`})
        await page.locator('.creator-credit').scrollIntoViewIfNeeded()
        await expect(page.locator('.creator-credit')).toBeInViewport()
        await expect(page.locator('.app-sidebar')).toBeInViewport()
      }
    })
  }
}

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
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: /API Keys/ }).click()
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
