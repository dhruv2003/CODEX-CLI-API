import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test.beforeEach(async ({ page }) => {
  await page.route('http://desktop.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    const name = path === '/' ? 'index.html' : path.slice(1)
    if (!['index.html', 'app.js', 'styles.css', 'branding.css', 'logo.png'].includes(name)) return route.abort()
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
      if (command === 'check_for_update') return win.updateFixture || { configured: false, version: null, message: 'Automatic updates are not configured for this build.' }
      if (command === 'download_update') { if (win.badSignature) throw new Error('Update signature verification failed'); return }
      if (command === 'install_update') { if (win.activeRequest) throw new Error('Finish all active requests before installing'); return }
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
  expect(await page.evaluate(() => (window as any).calls.filter((call: string) => call !== 'check_for_update'))).toEqual(['desktop_status', 'choose_workspace', 'save_settings', 'start_gateway', 'stop_gateway', 'start_gateway', 'stop_gateway'])
})

test('update download failure cannot offer installation and notes are plain text', async ({ page }) => {
  await page.goto('http://desktop.test')
  await page.getByRole('button', {name:'Settings',exact:true}).click()
  await page.evaluate(() => { (window as any).updateFixture = { configured: true, version: '0.3.0', message: 'Update available', notes: '<b>Release notes</b>' }; (window as any).badSignature = true })
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.locator('#update-notes')).toHaveText('<b>Release notes</b>')
  await page.getByRole('button', { name: 'Download update' }).click()
  await expect(page.getByRole('alert')).toContainText('signature')
  await expect(page.locator('#install-update')).toBeHidden()
})

test('update requires confirmation and shows active work rejection', async ({ page }) => {
  await page.goto('http://desktop.test')
  await page.getByRole('button', {name:'Settings',exact:true}).click()
  await page.evaluate(() => { (window as any).updateFixture = { configured: true, version: '0.3.0', message: 'Update available' }; (window as any).activeRequest = true })
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await page.getByRole('button', { name: 'Download update' }).click()
  await page.getByRole('button', { name: 'Install & restart', exact: true }).click()
  expect(await page.evaluate(() => (window as any).calls)).not.toContain('install_update')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('#update-confirmation')).toBeHidden()
  await page.getByRole('button', { name: 'Install & restart', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm install & restart' }).click()
  await expect(page.getByRole('alert')).toContainText('active requests')
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

test('desktop shows stopped health and safe preference defaults', async ({ page }) => {
  await page.goto('http://desktop.test')
  await page.getByRole('button', {name:'Settings',exact:true}).click()
  await expect(page.getByLabel('Launch at login')).not.toBeChecked()
  await expect(page.getByLabel('Keep running when window closes')).not.toBeChecked()
  await expect(page.locator('#native-health')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check for updates' })).toBeVisible()
})

test('connected dashboard fills the window and settings never shrink it', async ({page}) => {
  await page.setViewportSize({width:1000,height:700})
  await page.goto('http://desktop.test')
  await page.locator('#workspace').fill('/Users/test/Projects')
  await page.getByRole('button',{name:'Save & start gateway'}).click()
  const frame = page.locator('#dashboard')
  await expect(frame).toBeVisible()
  const before = await frame.boundingBox()
  expect(before!.y).toBeLessThan(95)
  expect(before!.height).toBeGreaterThan(580)
  await expect(page.locator('#desktop-options')).toBeHidden()
  await page.getByRole('button',{name:'Settings',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'Settings',exact:true})).toBeVisible()
  expect((await frame.boundingBox())!.height).toBe(before!.height)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByRole('button',{name:'Settings',exact:true})).toBeFocused()
  await page.screenshot({path:'output/playwright/desktop-layout-fixed.png'})
})
