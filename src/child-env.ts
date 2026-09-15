/** Never pass the desktop admin capability or Node preload hooks to model tools. */
export function codexChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!env.CODEX_DESKTOP_DATA_DIR) return { ...env }
  return Object.fromEntries(Object.entries(env).filter(([name]) => {
    const key = name.toUpperCase()
    return !key.startsWith('CODEX_DESKTOP_') && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH'
  }))
}
