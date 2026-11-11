import type { PoolClient } from 'pg'
import * as Sentry from '@sentry/nuxt'
import { useDatabasePool } from './database'

/**
 * Coarse cross-instance lock for periodic background sweepers. Built on
 * Postgres advisory locks (session-scoped via pg_try_advisory_lock /
 * pg_advisory_unlock). Two app instances both fire the sweeper timer at
 * the same second; only one acquires the lock and runs the work, the
 * other no-ops.
 *
 * Why session-scoped (NOT transaction-scoped): the sweep work runs
 * across many transactions (and may not be in a transaction at all);
 * we want one lock for the whole sweep, released only at the end. The
 * `pg_try_advisory_xact_lock` variant would auto-release the moment our
 * acquire query commits, defeating the purpose.
 *
 * Each named sweep gets one stable bigint lock id derived from
 * hashtext(name). Postgres uses a single namespace for advisory locks,
 * so the namespace IS the literal string we pass.
 *
 * Connection pinning: Postgres session-advisory locks are bound to the
 * connection that acquired them. With `pg.Pool`, two queries from the
 * same caller can land on different connections — so we pin the same
 * `PoolClient` across acquire AND release via a per-process Map. The
 * Map is per-process; advisory locks are per-connection — across
 * multi-instance, each instance has its own Map AND its own connection,
 * so only one instance's `pg_try_advisory_lock` returns true.
 *
 * Failure modes:
 *   - Could-not-acquire (the common case under multi-instance): logs at
 *     debug, no Sentry capture. Returns false; caller skips the sweep
 *     cleanly.
 *   - Acquire threw (DB unreachable, etc.): Sentry-capture, return false
 *     and let the next tick try. Failing-closed prevents two instances
 *     from running the sweep when the lock infrastructure is degraded.
 *   - releaseSweepLock when no lock was held: silent no-op. Worst case
 *     (the connection was lost mid-sweep) the lock auto-releases when
 *     the connection terminates; the next tick reacquires.
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
    console.warn(`[sweepLock] connect failed for '${name}':`, e instanceof Error ? e.message : e)
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
      // Common case under multi-instance — another worker holds the
      // lock. Return the connection to the pool and bail quietly.
      client.release()
      return false
    }
    heldConns.set(name, client)
    return true
  } catch (e) {
    // Acquire query itself blew up. Release the connection so the pool
    // doesn't leak it, capture for ops, and fail closed.
    try {
      client.release()
    } catch { /* ignore */ }
    console.warn(`[sweepLock] acquire failed for '${name}':`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'sweepLock', event: 'acquire_failed', sweep: name }
    })
    return false
  }
}

export async function releaseSweepLock(name: string): Promise<void> {
  const client = heldConns.get(name)
  if (!client) return // No-op: never acquired here, or already released.
  heldConns.delete(name)
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name])
  } catch (e) {
    // The lock auto-releases when the connection ends, so a failing
    // unlock query is recoverable — just warn.
    console.warn(`[sweepLock] unlock failed for '${name}':`, e instanceof Error ? e.message : e)
  } finally {
    try {
      client.release()
    } catch { /* ignore */ }
  }
}
