import { count } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from '../utils/database'

// Tiny "is the DB up" probe used by /api/health. Lives in repos/ for
// consistency — every DB access flows through here now, even the
// one-off healthcheck query.

export async function countUsers(): Promise<number> {
  const db = useDatabase()
  const row = (await db.select({ count: count() }).from(users))[0]
  return Number(row?.count ?? 0)
}
