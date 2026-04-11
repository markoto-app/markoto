import { count } from 'drizzle-orm'
import { users } from '../db/schema'

export default defineEventHandler(() => {
  const db = useDatabase()
  const result = db.select({ count: count() }).from(users).get()

  return {
    status: 'ok',
    database: {
      connected: true,
      userCount: result?.count ?? 0
    },
    timestamp: Date.now()
  }
})
