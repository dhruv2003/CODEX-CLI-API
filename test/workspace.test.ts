import { describe, expect, it } from 'vitest'
import { resolve, join } from 'node:path'
import { isInsideWorkspace, resolveWorkspacePath } from '../src/security.js'

describe('workspace path policy', () => {
  it('accepts paths inside the configured root and rejects traversal', () => {
    const root = resolve('workspace')
    expect(isInsideWorkspace(root, join(root, 'src'))).toBe(true)
    expect(isInsideWorkspace(root, join(root, '..', 'secrets'))).toBe(false)
    expect(() => resolveWorkspacePath(root, join('..', 'secrets.txt'))).toThrow(/outside workspace/i)
  })
})
