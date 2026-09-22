import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Stitch native desktop shell contract', () => {
  it('exposes the four-step first-run workflow and native controls', async () => {
    const html = await readFile(resolve('desktop/index.html'), 'utf8')
    for (const label of ['Workspace', 'Create key', 'Sign in', 'Test connection']) expect(html).toContain(label)
    for (const id of ['onboarding', 'settings-panel', 'dashboard', 'status', 'settings-toggle', 'default-model', 'default-reasoning']) expect(html).toContain(`id="${id}"`)
    expect(html).not.toContain('<dialog')
    expect(html).toContain('aria-label="API key manager and setup"')
    expect(html).not.toContain('title="API key manager and setup"')
  })

  it('keeps the embedded settings handoff constrained to the running dashboard', async () => {
    const app = await readFile(resolve('desktop/app.js'), 'utf8')
    const branding = await readFile(resolve('desktop/branding.css'), 'utf8')
    expect(app).toContain('event.source !== $("dashboard").contentWindow')
    expect(app).toContain('event.origin !== new URL(state.dashboardUrl).origin')
    expect(app).toContain('codex-desktop-open-settings')
    expect(app).toContain('openSettings()')
    expect(app).toContain('codex-desktop-view')
    expect(app).toContain('codex-desktop-ready')
    expect(app).toContain('codex-desktop-defaults')
    expect(app).toContain('codex-desktop-models')
    expect(branding).toContain('#settings-panel {')
    expect(branding).toContain('position: fixed;')
    expect(branding).toContain('inset: 0 0 0 224px;')
    expect(branding).toContain('inset: 144px 0 0 0;')
  })
})
