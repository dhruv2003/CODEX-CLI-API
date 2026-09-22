import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const htmlPath = resolve('src/public/index.html')

describe('dashboard HTML contract', () => {
  it('provides stable entry points for the six views and guided setup', async () => {
    const html = await readFile(htmlPath, 'utf8')
    for (const view of ['overview', 'api-keys', 'connect', 'requests', 'diagnostics', 'settings']) {
      expect(html).toContain(`data-view="${view}"`)
    }
    for (const id of [
      'keys', 'create-dialog', 'create-form', 'close-create', 'secret-continue',
      'page-refresh', 'theme-light', 'theme-dark', 'wizard-progress', 'wizard-stage', 'wizard-next', 'wizard-back',
      'connect-empty', 'setup-key', 'test-connection', 'health-check',
      'diagnostic-check', 'request-history', 'history-key-filter',
      'history-model-filter', 'history-result-filter', 'history-refresh',
      'history-search', 'history-export', 'request-detail-panel', 'key-detail-panel',
    ]) {
      expect(html).toContain(`id="${id}"`)
    }
  })
})
