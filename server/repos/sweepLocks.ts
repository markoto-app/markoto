import type { PoolClient } from 'pg'
import * as Sentry from '@sentry/nuxt'
import { useDatabasePool } from '../db/client'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('sweep-lock')

/**
 * Cross-instance lock for periodic background sweepers, built on Postgres
 * session advisory locks. When two instances fire the same sweeper, one
 * acquires the lock and runs; the other no-ops.
 *
 * Session-scoped, not transaction-scoped: a sweep spans many transactions
 * and needs one lock until the end. `pg_try_advisory_xact_lock` would
 * release as soon as the acquire query commits.
 *
 * The lock id is `hashtext(name)`; Postgres has a single advisory-lock
 * namespace, so the name itself is the namespace.
 *
 * Connection pinning: a session lock belongs to the connection that took
 * it, and a `pg.Pool` may serve the next query from another connection, so
 * the same `PoolClient` is held in a per-process Map from acquire to release.
 *
 * Failure modes:
 *   - Lock held elsewhere (the normal multi-instance case): returns false,
 *     no Sentry event; the caller skips the sweep.
 *   - Acquire threw (DB unreachable): captured to Sentry, returns false. This
 *     fails closed so two instances never sweep while locking is degraded.
 *   - `releaseSweepLock` without a held lock: no-op. If the connection died
 *     mid-sweep the lock released with it.
 *
 * Usage:
 *   if (!await acquireSweepLock('orphan-cleanup')) return
 *   try { ...sweep... } finally { await releaseSweepLock('orphan-cleanup') }
 */

const heldConns = new Map<string, PoolClient>()

export async function acquireSweepLock(name: string): Promise<boolean> {
  let client: PoolClient
  try {
    client = await useDatabasePool().connect()
  } catch (e) {
    log.warn('connect failed', { lock: name, err: e })
    Sentry.captureException(e, {
      tags: { component: 'sweepLock', event: 'connect_failed', sweep: name }
    })
    return false
  }

  try {
    const res = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
      [name]
    )
    if (!res.rows[0]?.ok) {
      // Another instance holds the lock.
      client.release()
      return false
    }
    heldConns.set(name, client)
    return true
  } catch (e) {
    // Release the connection so the pool doesn't leak it, and fail closed.
    try {
      client.release()
    } catch { /* ignore */ }
    log.warn('acquire failed', { lock: name, err: e })
    Sentry.captureException(e, {
      tags: { component: 'sweepLock', event: 'acquire_failed', sweep: name }
    })
    return false
  }
}

export async function releaseSweepLock(name: string): Promise<void> {
  const client = heldConns.get(name)
  if (!client) return
  heldConns.delete(name)
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name])
  } catch (e) {
    // The lock is released when the connection ends, so just warn.
    log.warn('unlock failed', { lock: name, err: e })
  } finally {
    try {
      client.release()
    } catch { /* ignore */ }
  }
}
