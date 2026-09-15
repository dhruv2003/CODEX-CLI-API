import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: 'output/playwright/test-results',
  use: { browserName: 'chromium', trace: 'retain-on-failure' },
})
