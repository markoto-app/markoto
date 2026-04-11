import { Server } from '@hocuspocus/server'
import { s3Persistence } from './persistence'
import { auth } from './auth'
import { rateLimiter } from './rate-limiter'

const port = parseInt(process.env.PORT || '4001')

const server = new Server({
  port,
  debounce: 2000,
  maxDebounce: 10000,

  async onLoadDocument(data) {
    return s3Persistence.onLoadDocument(data)
  },

  async onStoreDocument(data) {
    await s3Persistence.onStoreDocument(data)
  },

  async onAuthenticate(data) {
    return auth.onAuthenticate(data)
  },

  async onConnect(data) {
    rateLimiter.onConnect(data)
  },

  async onDisconnect(data) {
    rateLimiter.onDisconnect(data)
  }
})

server.listen(port, () => {
  console.log(`[hocuspocus] Sync server listening on port ${port}`)
})
