import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  await page.route('http://desktop.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    const name = path === '/' ? 'index.html' : path.slice(1)
    if (!['index.html', 'app.js', 'styles.css'].includes(name)) return route.abort()
    await route.fulfill({ body: await readFile(resolve('desktop', name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' })
  })
  await page.route('http://127.0.0.1:3081/**', route => route.fulfill({ body: '<h1>Gateway fixture</h1>', contentType: 'text/html' }))
  await page.addInitScript(() => {
    const win = window as any
    win.calls = []
    let settings = { workspaceRoot: '', port: 3081 }
    let running = false
    win.__TAURI__ = { core: { invoke: async (command: string, args: any) => {
      win.calls.push(command)
      if (command === 'choose_workspace') return '/Users/test/Projects'
      if (command === 'save_settings') settings = args.settings
      if (command === 'start_gateway') {
        if (win.failStart) throw new Error('Port is already in use. Choose a different port.')
        running = true
      }
      if (command === 'stop_gateway') running = false
      return { running, settings, dataDir: '/Users/test/Library/Application Support/Codex', dashboardUrl: running ? 'http://127.0.0.1:3081/#desktopToken=' + 'a'.repeat(64) : null }
    } } }
  })
})

test('desktop first run saves native settings and starts, restarts and stops gateway', async ({ page }) => {
  await page.goto('http://desktop.test')
  await expect(page.locator('#status')).toHaveText('Gateway stopped')
  await page.getByRole('button', { name: 'Choose folder' }).click()
  await expect(page.locator('#workspace')).toHaveValue('/Users/test/Projects')
  await page.getByRole('button', { name: 'Save & start gateway' }).click()
  await expect(page.locator('#dashboard')).toBeVisible()
  await expect(page.locator('#onboarding')).toBeHidden()
  await page.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Running')
  await page.getByRole('button', { name: 'Stop gateway' }).click()
  await expect(page.locator('#dashboard')).toBeHidden()
  await expect(page.locator('#onboarding')).toBeVisible()
  expect(await page.evaluate(() => (window as any).calls)).toEqual(['desktop_status', 'choose_workspace', 'save_settings', 'start_gateway', 'stop_gateway', 'start_gateway', 'stop_gateway'])
})

test('only the running dashboard can request the fixed authentication browser', async ({ page }) => {
  await page.goto('http://desktop.test')
  await page.locator('#workspace').fill('/Users/test/Projects')
  await page.getByRole('button', { name: 'Save & start gateway' }).click()
  await expect(page.locator('#dashboard')).toBeVisible()
  await page.evaluate(() => {
    const source = (document.getElementById('dashboard') as HTMLIFrameElement).contentWindow
    const data = { type: 'codex-desktop-open-login' }
    window.dispatchEvent(new MessageEvent('message', { source, origin: 'https://evil.test', data }))
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'http://127.0.0.1:3081', data }))
    window.dispatchEvent(new MessageEvent('message', { source, origin: 'http://127.0.0.1:3081', data: { ...data, url: 'https://evil.test' } }))
  })
  expect(await page.evaluate(() => (window as any).calls)).not.toContain('open_codex_login')
  const frame = page.frames().find(frame => frame.url().startsWith('http://127.0.0.1:3081/'))!
  await frame.evaluate(() => window.parent.postMessage({ type: 'codex-desktop-open-login' }, '*'))
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((value: string) => value === 'open_codex_login').length)).toBe(1)
})

test('desktop launch error stays actionable without an empty dashboard', async ({ page }) => {
  await page.goto('http://desktop.test')
  await page.evaluate(() => { (window as any).failStart = true })
  await page.locator('#workspace').fill('/Users/test/Projects')
  await page.getByRole('button', { name: 'Save & start gateway' }).click()
  await expect(page.getByRole('alert')).toContainText('Port is already in use')
  await expect(page.locator('#dashboard')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Save & start gateway' })).toBeEnabled()
})
