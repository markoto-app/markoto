import { and, count, eq, gt, lt } from 'drizzle-orm'
import { rateLimits } from '../db/schema'

/**
 * Postgres-backed sliding-window rate limiter.
 *
 * Why persistent: the previous in-memory implementation reset on every Nitro
 * restart, which meant a user could burst past any quota by triggering a
 * restart. Persistence also means multiple Nitro workers share one quota.
 *
 * Mechanism: each successful `checkRateLimit` inserts one row tagged with the
 * namespace/key and a timestamp. The same call counts rows within the window
 * and compares against `maxAttempts`. A periodic cleanup job prunes rows that
 * have aged out of every possible window.
 */

// Keep deleted rows around for a day — covers every window we actually use
// (hours at most) with plenty of slack. Cleanup job drops anything older.
const RETENTION_MS = 24 * 60 * 60 * 1000

export async function checkRateLimit(
  namespace: string,
  key: string,
  maxAttempts: number,
  windowMs: number
): Promise<boolean> {
  const db = useDatabase()
  const now = new Date()
  const windowStart = new Date(Date.now() - windowMs)

  // Fast path: count existing attempts within the window.
  const existing = (await db
    .select({ count: count() })
    .from(rateLimits)
    .where(and(
      eq(rateLimits.namespace, namespace),
      eq(rateLimits.key, key),
      gt(rateLimits.createdAt, windowStart)
    )))[0]

  if (Number(existing?.count ?? 0) >= maxAttempts) {
    return false
  }

  await db.insert(rateLimits).values({
    namespace,
    key,
    createdAt: now
  })

  return true
}

let cleanupStarted = false

/**
 * Start the periodic cleanup job. Idempotent. Called from a Nitro plugin at
 * startup so rows don't accumulate indefinitely.
 */
export function startRateLimitCleanup() {
  if (cleanupStarted) return
  cleanupStarted = true

  async function cleanup() {
    try {
      const db = useDatabase()
      const cutoff = new Date(Date.now() - RETENTION_MS)
      await db.delete(rateLimits).where(lt(rateLimits.createdAt, cutoff))
    } catch (e: any) {
      console.warn('[rateLimit] cleanup failed:', e?.message || e)
    }
  }

  // Run once at startup to clean up anything from previous processes, then
  // every hour. Cheaper than piggybacking on each checkRateLimit call.
  void cleanup()
  setInterval(() => { void cleanup() }, 60 * 60 * 1000)
}
