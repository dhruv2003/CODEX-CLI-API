import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

async function dashboardMessage(page: Page, data: unknown) {
  const frame = page.frames().find(frame => frame.url().startsWith('http://127.0.0.1:3081/'))!
  await frame.evaluate(data => window.parent.postMessage(data, 'http://desktop.test'), data)
}
async function startDesktop(page: Page) {
  await page.goto('http://desktop.test')
  await page.locator('#workspace').fill('/Users/test/Projects')
  await page.getByRole('button', { name: 'Save & start gateway' }).click()
  await expect(page.frameLocator('#dashboard').getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
}
async function openSettings(page: Page) {
  await page.frameLocator('#dashboard').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('#settings-panel')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('http://desktop.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    const name = path === '/' ? 'index.html' : path.slice(1)
    if (!['index.html', 'app.js', 'styles.css', 'branding.css', 'logo.png'].includes(name)) return route.abort()
    await route.fulfill({ body: await readFile(resolve('desktop', name)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' })
  })
  await page.route('http://127.0.0.1:3081/**', route => route.fulfill({ body: `<!doctype html><style>body{margin:0;background:#f8f6f0}nav{position:fixed;inset:0 auto 0 0;width:224px;background:white}button{display:block;margin:16px}@media(max-width:820px){nav{inset:0 0 auto;width:100%;height:144px}button{display:inline-block}}</style><nav><button data-view="overview">Overview</button><button data-view="diagnostics">Diagnostics</button><button data-view="settings">Settings</button></nav><script>window.received=[];window.addEventListener('message',e=>window.received.push(e.data));document.querySelectorAll('button').forEach(b=>b.onclick=()=>parent.postMessage({type:'codex-desktop-view',view:b.dataset.view},'http://desktop.test'));</script>`, contentType: 'text/html' }))
  await page.addInitScript(() => {
    const win = window as any
    win.calls = []
    let settings = { workspaceRoot: '', port: 3081 }
    let running = false
    win.__TAURI__ = { core: { invoke: async (command: string, args: any) => {
      win.calls.push(command)
      if (command === 'desktop_status' && win.savedWorkspace) settings.workspaceRoot = win.savedWorkspace
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

test('settings and About show the installed app version', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__TAURI__.app = { getVersion: async () => '9.8.7' }
  })
  await page.goto('http://desktop.test')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.settings-heading .version')).toHaveText('v9.8.7')
  await expect(page.locator('.about')).toContainText('Codex CLI API · v9.8.7')
  await expect(page.getByText('Current version', { exact: false })).toHaveText('Current version v9.8.7')
})

test('desktop first run saves native settings and starts, restarts and stops gateway', async ({ page }) => {
  await page.goto('http://desktop.test')
  await expect(page.locator('#status')).toHaveText('Gateway stopped')
  await expect(page.locator('#native-sidebar .brand')).toHaveText('Codex CLI APILocal AI gateway')
  await expect(page.getByRole('group',{name:'Appearance'}).getByRole('button').first()).toHaveAccessibleName('Dark theme')
  await page.getByRole('button', { name: 'Choose folder' }).click()
  await expect(page.locator('#workspace')).toHaveValue('/Users/test/Projects')
  await page.getByRole('button', { name: 'Save & start gateway' }).click()
  await expect(page.locator('#dashboard')).toBeVisible()
  await expect(page.locator('#onboarding')).toBeHidden()
  await expect(page.locator('#dashboard')).toHaveAttribute('src', /&view=onboarding&step=2$/)
  await openSettings(page)
  await page.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(page.locator('#status')).toContainText('Running')
  await page.getByRole('button', { name: 'Stop gateway' }).click()
  await expect(page.locator('#dashboard')).toBeHidden()
  await expect(page.locator('#settings-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Back to setup' }).click()
  await expect(page.locator('#onboarding')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Setup navigation' }).getByRole('button', { name: 'Overview' })).toBeDisabled()
  expect(await page.evaluate(() => (window as any).calls.filter((call: string) => call !== 'check_for_update'))).toEqual(['desktop_status', 'choose_workspace', 'save_settings', 'start_gateway', 'stop_gateway', 'start_gateway', 'stop_gateway'])
})

test('update download failure cannot offer installation and notes are plain text', async ({ page }) => {
  await startDesktop(page)
  await openSettings(page)
  await page.evaluate(() => { (window as any).updateFixture = { configured: true, version: '0.3.0', message: 'Update available', notes: '<b>Release notes</b>' }; (window as any).badSignature = true })
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.locator('#update-notes')).toHaveText('<b>Release notes</b>')
  await page.getByRole('button', { name: 'Download update' }).click()
  await expect(page.getByRole('alert')).toContainText('signature')
  await expect(page.locator('#install-update')).toBeHidden()
})

test('update requires confirmation and shows active work rejection', async ({ page }) => {
  await startDesktop(page)
  await openSettings(page)
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
  await frame.evaluate(() => window.parent.postMessage({ type: 'codex-desktop-open-settings' }, '*'))
  await expect(page.getByRole('main', { name: 'Settings', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
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

test('automatic update check survives saved-workspace gateway startup failure', async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as any
    win.savedWorkspace = '/Users/test/Projects'
    win.failStart = true
    win.updateFixture = { configured: true, version: '1.4.1', message: 'Update available' }
  })
  await page.goto('http://desktop.test')
  await expect(page.getByRole('alert')).toContainText('Port is already in use')
  await expect(page.locator('#dashboard')).toBeHidden()
  await expect(page.locator('#update-notice')).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('#settings-panel')).toBeVisible()
  await expect(page.locator('#update-status')).toContainText('1.4.1')
  await expect(page.getByRole('button', { name: 'Download update' })).toBeEnabled()
})

test('native Settings can manually check for updates after gateway startup failure', async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as any
    win.savedWorkspace = '/Users/test/Projects'
    win.failStart = true
  })
  await page.goto('http://desktop.test')
  await expect(page.getByRole('alert')).toContainText('Port is already in use')
  await expect(page.locator('#dashboard')).toBeHidden()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.evaluate(() => {
    (window as any).updateFixture = { configured: true, version: '1.4.1', message: 'Update available' }
  })
  await page.getByRole('button', { name: 'Check for updates' }).click()
  await expect(page.locator('#update-status')).toContainText('1.4.1')
  await expect(page.getByRole('button', { name: 'Download update' })).toBeEnabled()
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
  await startDesktop(page)
  const frame = page.locator('#dashboard')
  await expect(frame).toBeVisible()
  const before = await frame.boundingBox()
  expect(before).toEqual({x:0,y:0,width:1000,height:700})
  await expect(frame).not.toHaveAttribute('title')
  await expect(page.locator('#native-sidebar')).toBeHidden()
  await expect(page.locator('#desktop-options')).toBeHidden()
  await openSettings(page)
  const drawer = page.getByRole('main',{name:'Settings',exact:true})
  await expect(drawer).toBeVisible()
  const drawerBox = await drawer.boundingBox()
  expect(drawerBox).toEqual({x:224,y:0,width:776,height:700})
  expect((await page.locator('.settings-heading').boundingBox())!.height).toBe(82)
  await expect(drawer.locator('.native-onboarding-progress')).toHaveCount(0)
  expect((await frame.boundingBox())!.height).toBe(before!.height)
  await page.screenshot({path:'output/playwright/native-settings-light.png'})
  await page.frameLocator('#dashboard').getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(drawer).toBeHidden()
  await openSettings(page)
  await page.setViewportSize({width:820,height:700})
  expect(await drawer.boundingBox()).toEqual({x:0,y:144,width:820,height:556})
  expect(await frame.boundingBox()).toEqual({x:0,y:0,width:820,height:700})
  await page.frameLocator('#dashboard').getByRole('button', { name: 'Diagnostics', exact: true }).click()
  await expect(drawer).toBeHidden()
  await page.screenshot({path:'output/playwright/desktop-layout-fixed.png'})
})

test('native theme persists and synchronizes on ready without echoing dashboard changes', async ({ page }) => {
  await page.goto('http://desktop.test')
  await page.getByRole('button', { name: 'Dark theme', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 19, 24)')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.locator('#workspace').fill('/Users/test/Projects')
  await page.getByRole('button', { name: 'Save & start gateway' }).click()
  await expect(page.frameLocator('#dashboard').getByRole('button', { name: 'Settings' })).toBeVisible()
  const frame = page.frames().find(frame => frame.url().startsWith('http://127.0.0.1:3081/'))!
  expect(await frame.evaluate(() => (window as any).received)).toEqual([])
  await dashboardMessage(page, { type: 'codex-desktop-ready' })
  await expect.poll(() => frame.evaluate(() => (window as any).received.filter((v: any) => v.type === 'codex-desktop-theme'))).toEqual([{type:'codex-desktop-theme',theme:'dark'}])
  await dashboardMessage(page, { type: 'codex-desktop-theme', theme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await page.evaluate(() => localStorage.getItem('codex-ui-theme'))).toBe('light')
  await dashboardMessage(page, { type: 'codex-desktop-theme', theme: 'dark', extra: true })
  await dashboardMessage(page, { type: 'codex-desktop-theme', theme: 'invalid' })
  await page.evaluate(() => {
    const source = (document.getElementById('dashboard') as HTMLIFrameElement).contentWindow
    const data = {type:'codex-desktop-theme',theme:'dark'}
    window.dispatchEvent(new MessageEvent('message', {source,origin:'https://evil.test',data}))
    window.dispatchEvent(new MessageEvent('message', {source:window,origin:'http://127.0.0.1:3081',data}))
  })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await frame.evaluate(() => (window as any).received.filter((v: any) => v.type === 'codex-desktop-theme'))).toHaveLength(1)
  await dashboardMessage(page, { type: 'codex-desktop-theme', theme: 'dark' })
  await openSettings(page)
  await expect(page.locator('#settings-panel')).toHaveCSS('background-color', 'rgb(17, 19, 24)')
  await expect(page.locator('#settings-form')).toHaveCSS('background-color', 'rgb(25, 28, 35)')
  await page.screenshot({path:'output/playwright/native-settings-dark.png'})
})

test('defaults wait for ready, use the bounded catalog, and persist only UI choices', async ({ page }) => {
  await startDesktop(page)
  await openSettings(page)
  const frame = page.frames().find(frame => frame.url().startsWith('http://127.0.0.1:3081/'))!
  const models = [{id:'model-a',efforts:['low','high']},{id:'model-b',efforts:['medium']}]
  await dashboardMessage(page, { type:'codex-desktop-models', models })
  await expect(page.locator('#default-model option')).toHaveCount(3)
  await page.getByLabel('Default model', {exact:true}).selectOption('model-a')
  await page.getByLabel('Default reasoning level').selectOption('high')
  await page.getByRole('button', {name:'Save defaults'}).click()
  expect(await frame.evaluate(() => (window as any).received)).toEqual([])
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('codex-desktop-ui-defaults')!))).toEqual({model:'model-a',reasoning:'high'})
  await dashboardMessage(page, {type:'codex-desktop-ready'})
  await expect.poll(() => frame.evaluate(() => (window as any).received.filter((v: any) => v.type === 'codex-desktop-defaults'))).toEqual([{type:'codex-desktop-defaults',model:'model-a',reasoning:'high'}])
  await page.getByLabel('Default model', {exact:true}).selectOption('model-b')
  await expect(page.getByLabel('Default reasoning level')).toHaveValue('')
  await page.getByLabel('Default reasoning level').selectOption('medium')
  await page.getByRole('button', {name:'Save defaults'}).click()
  await expect.poll(() => frame.evaluate(() => (window as any).received.filter((v: any) => v.type === 'codex-desktop-defaults').at(-1))).toEqual({type:'codex-desktop-defaults',model:'model-b',reasoning:'medium'})
  const malformedCatalogs = [null, {}, [{id:42,efforts:[]}], [{id:'a',efforts:'high'}], [{id:'a',efforts:[1]}], [{id:'a',efforts:[],extra:true}], [{id:'x'.repeat(129),efforts:[]}], Array.from({length:201},(_,i)=>({id:String(i),efforts:[]})), [{id:'a',efforts:['x'.repeat(65)]}], [{id:'a',efforts:Array.from({length:33},(_,i)=>String(i))}], [{id:'a',efforts:[]},{id:'a',efforts:[]}]]
  for (const catalog of malformedCatalogs) await dashboardMessage(page,{type:'codex-desktop-models',models:catalog})
  await expect(page.locator('#default-model option')).toHaveCount(3)
  await expect(page.getByLabel('Default model',{exact:true})).toHaveValue('model-b')
  await page.reload()
  await page.locator('#workspace').fill('/Users/test/Projects')
  await page.getByRole('button', {name:'Save & start gateway'}).click()
  await openSettings(page)
  await dashboardMessage(page,{type:'codex-desktop-models',models})
  await expect(page.getByLabel('Default model',{exact:true})).toHaveValue('model-b')
  await expect(page.getByLabel('Default reasoning level')).toHaveValue('medium')
})

test('settings messages reject wrong source, origin, and payload; native routes return safely', async ({page}) => {
  await startDesktop(page)
  await page.evaluate(() => {
    const source = (document.getElementById('dashboard') as HTMLIFrameElement).contentWindow
    for (const data of [{type:'codex-desktop-view',view:'settings'},{type:'codex-desktop-open-settings'},{type:'codex-desktop-ready'},{type:'codex-desktop-models',models:[{id:'evil',efforts:[]}]}]) {
      window.dispatchEvent(new MessageEvent('message',{source,origin:'https://evil.test',data}))
      window.dispatchEvent(new MessageEvent('message',{source:window,origin:'http://127.0.0.1:3081',data}))
      window.dispatchEvent(new MessageEvent('message',{source,origin:'http://127.0.0.1:3081',data:{...data,extra:true}}))
    }
  })
  await expect(page.locator('#settings-panel')).toBeHidden()
  await expect(page.locator('#default-model option')).toHaveCount(1)
  const frame = page.frames().find(frame=>frame.url().startsWith('http://127.0.0.1:3081/'))!
  expect(await frame.evaluate(()=>(window as any).received)).toEqual([])
  await dashboardMessage(page,{type:'codex-desktop-ready'})
  await openSettings(page)
  await dashboardMessage(page,{type:'codex-desktop-view',view:'not-a-view'})
  await dashboardMessage(page,{type:'codex-desktop-view',view:'overview',extra:true})
  await expect(page.locator('#settings-panel')).toBeVisible()
  await page.getByRole('button',{name:'Open Diagnostics →'}).click()
  await expect(page.locator('#settings-panel')).toBeHidden()
  await expect.poll(()=>frame.evaluate(()=>(window as any).received.at(-1))).toEqual({type:'codex-desktop-navigate',view:'diagnostics'})
  await openSettings(page)
  await page.getByRole('button',{name:'Back to overview'}).click()
  await expect.poll(()=>frame.evaluate(()=>(window as any).received.at(-1))).toEqual({type:'codex-desktop-navigate',view:'overview'})
})

test('saving settings returns a reloaded dashboard to overview after its ready handshake', async ({ page }) => {
  await page.route('http://127.0.0.1:3081/**', route => route.fulfill({contentType:'text/html',body:`<!doctype html><nav><button data-view="overview">Overview</button><button data-view="settings">Settings</button></nav><p id="current-view"></p><script>
    const show = view => { document.getElementById('current-view').textContent = view; localStorage.setItem('fixture-view', view); };
    show(new URLSearchParams(location.hash.slice(1)).get('view') || localStorage.getItem('fixture-view') || 'overview');
    document.querySelectorAll('button').forEach(button => button.onclick = () => { show(button.dataset.view); parent.postMessage({type:'codex-desktop-view',view:button.dataset.view},'http://desktop.test'); });
    addEventListener('message', event => { if(event.data.type === 'codex-desktop-navigate') show(event.data.view); });
  </script>`}))
  await startDesktop(page)
  await page.frameLocator('#dashboard').getByRole('button',{name:'Overview',exact:true}).click()
  await openSettings(page)
  await page.locator('#workspace').fill('/Users/test/OtherProjects')
  await page.getByRole('button',{name:'Save & restart gateway'}).click()
  await expect(page.locator('#settings-panel')).toBeHidden()
  await expect(page.frameLocator('#dashboard').locator('#current-view')).toHaveText('settings')
  // Startup reports its restored route before ready; the queued native return wins.
  await dashboardMessage(page,{type:'codex-desktop-view',view:'settings'})
  await expect(page.locator('#settings-panel')).toBeHidden()
  await dashboardMessage(page,{type:'codex-desktop-ready'})
  await expect(page.frameLocator('#dashboard').locator('#current-view')).toHaveText('overview')
  await openSettings(page)
  await expect(page.locator('#workspace')).toHaveValue('/Users/test/OtherProjects')
})

test('settings heading keeps focus without an outline and keyboard controls retain theirs', async ({page}) => {
  await startDesktop(page)
  await openSettings(page)
  await expect(page.locator('#settings-title')).toBeFocused()
  await expect(page.locator('#settings-title')).toHaveCSS('outline-style','none')
  await page.keyboard.press('Tab')
  await expect(page.locator('#close-settings')).toBeFocused()
  await expect(page.locator('#close-settings')).toHaveCSS('outline-style','solid')
})
