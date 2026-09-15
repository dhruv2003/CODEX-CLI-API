import { loadConfig, prepareConfig } from './config.js'
import { ApiKeyStore } from './auth.js'
import { realpath, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import { resolveWorkspacePath } from './security.js'

const nameIndex = process.argv.indexOf('--name')
const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : 'local development'
if (name === undefined || name.trim().length === 0) throw new Error('--name must be non-empty')
const workspaceIndex = process.argv.indexOf('--workspace')
const workspace = workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] : undefined
if (workspace === undefined || workspace.trim().length === 0) throw new Error('--workspace must be an existing directory inside CODEX_WORKSPACE_ROOT')

const config = loadConfig()
await prepareConfig(config)
const realRoot = await realpath(config.workspaceRoot)
const selectedWorkspace = await realpath(resolveWorkspacePath(realRoot, workspace.trim()))
if (!(await stat(selectedWorkspace)).isDirectory()) throw new Error('--workspace must be a directory')
const created = await new ApiKeyStore(config.keyFile).create(name.trim(), { workspaceRoot: relative(realRoot, selectedWorkspace) || '.' })
console.log(`ID: ${created.id}`)
console.log(`API key: ${created.key}`)
console.log('Save this key now; only its hash is stored on disk.')
