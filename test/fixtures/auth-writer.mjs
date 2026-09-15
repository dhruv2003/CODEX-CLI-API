import { once } from 'node:events'
import { ApiKeyStore } from '../../src/auth.ts'

const store = new ApiKeyStore(process.argv[2])
const start = once(process, 'message')
process.send('ready')
await start
for (let index = 0; index < 15; index++) {
  await store.create(`worker-${process.pid}-${index}`)
  await store.recordUsage(process.argv[3], { inputTokens: 2, outputTokens: 3 })
}
process.disconnect()
