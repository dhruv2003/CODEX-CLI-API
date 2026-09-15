import { isAbsolute, relative, resolve, sep } from 'node:path'

export function isInsideWorkspace(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate))
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
}

export function resolveWorkspacePath(root: string, requested: string): string {
  const candidate = resolve(root, requested)
  if (!isInsideWorkspace(root, candidate)) throw new Error('path is outside workspace')
  return candidate
}
