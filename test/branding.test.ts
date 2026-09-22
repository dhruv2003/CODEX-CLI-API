import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Sidecar branding hotfix', () => {
  it('uses the Sidecar product name and sidecar.co.in in shipped product surfaces', async () => {
    const files = [
      'src-tauri/tauri.conf.json',
      'desktop/index.html',
      'src/public/index.html',
      'README.md',
      'docs/branding.md',
    ]
    const contents = await Promise.all(files.map(file => readFile(resolve(file), 'utf8')))

    for (const content of contents) {
      expect(content).toContain('Sidecar')
      expect(content).toContain('sidecar.co.in')
    }
    expect(contents.join('\n')).not.toContain('thesidecar.in')
  })
})
