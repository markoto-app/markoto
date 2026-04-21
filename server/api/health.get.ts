import { countUsers } from '../repos/health'

export default defineEventHandler(async () => {
  return {
    status: 'ok',
    database: {
      connected: true,
      userCount: await countUsers()
    },
    timestamp: Date.now()
  }
})
