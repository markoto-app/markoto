import { and, eq, gt, lt, sql } from 'drizzle-orm'
import { rateLimits } from '../db/schema'

/**
 * SQLite-backed sliding-window rate limiter.
 *
 * Why persistent: the previous in-memory implementation reset on every Nitro
 * restart, which meant a user could burst past any quota by triggering a
 * restart (intentionally or otherwise). Persistence also means multiple Nitro
 * workers share one quota — relevant as soon as we scale out.
 *
 * Mechanism: each successful `checkRateLimit` inserts one row tagged with the
 * namespace/key and a timestamp. The same call counts rows within the window
 * and compares against `maxAttempts`. A periodic cleanup job prunes rows that
 * have aged out of every possible window.
 *
 * Trade-off vs. in-memory: roughly a few extra microseconds per call for the
 * write + count + (occasional) prune. Fine for our scale; would want Redis in
 * front of this if we ever saw thousands of checks/sec.
 */

// Keep deleted rows around for a day — covers every window we actually use
// (hours at most) with plenty of slack. Cleanup job drops anything older.
const RETENTION_MS = 24 * 60 * 60 * 1000

export function checkRateLimit(
  namespace: string,
  key: string,
  maxAttempts: number,
  windowMs: number
): boolean {
  const db = useDatabase()
  const now = Date.now()
  const windowStart = now - windowMs

  // Fast path: count existing attempts within the window.
  const existing = db
    .select({ count: sql<number>`count(*)` })
    .from(rateLimits)
    .where(and(
      eq(rateLimits.namespace, namespace),
      eq(rateLimits.key, key),
      gt(rateLimits.createdAt, windowStart)
    ))
    .get()

  if ((existing?.count ?? 0) >= maxAttempts) {
    return false
  }

  db.insert(rateLimits).values({
    namespace,
    key,
    createdAt: now
  }).run()

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

  function cleanup() {
    try {
      const db = useDatabase()
      const cutoff = Date.now() - RETENTION_MS
      db.delete(rateLimits).where(lt(rateLimits.createdAt, cutoff)).run()
    } catch (e: any) {
      console.warn('[rateLimit] cleanup failed:', e?.message || e)
    }
  }

  // Run once at startup to clean up anything from previous processes, then
  // every hour. Cheaper than piggybacking on each checkRateLimit call.
  cleanup()
  setInterval(cleanup, 60 * 60 * 1000)
}
