import { count } from 'drizzle-orm'
import { users } from '../db/schema'

export default defineEventHandler(async () => {
  const db = useDatabase()
  const result = (await db.select({ count: count() }).from(users))[0]

  return {
    status: 'ok',
    database: {
      connected: true,
      userCount: Number(result?.count ?? 0)
    },
    timestamp: Date.now()
  }
})
