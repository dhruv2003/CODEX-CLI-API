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

  it('ships the selected Sidecar brand assets in the app surfaces', async () => {
    const assetFiles = [
      'brand-assets/Sidecar_Brand_Assets_Pack/png/app-icon-dark-1024.png',
      'brand-assets/Sidecar_Brand_Assets_Pack/png/app-icon-light-1024.png',
      'brand-assets/Sidecar_Brand_Assets_Pack/png/app-icon-blue-1024.png',
    ]
    const [desktopLogo, publicLogo, darkMaster, lightMaster, blueMaster] = await Promise.all([
      readFile(resolve('desktop/logo.png')),
      readFile(resolve('src/public/logo.png')),
      readFile(resolve(assetFiles[0])),
      readFile(resolve(assetFiles[1])),
      readFile(resolve(assetFiles[2])),
    ])

    expect(desktopLogo).toEqual(darkMaster)
    expect(publicLogo).toEqual(lightMaster)
    expect(blueMaster.byteLength).toBeGreaterThan(0)
  })

  it('uses Sidecar for the application package names', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { name: string }
    const cargo = await readFile(resolve('src-tauri/Cargo.toml'), 'utf8')

    expect(packageJson.name).toBe('sidecar')
    expect(cargo).toContain('name = "sidecar-desktop"')
  })
})
