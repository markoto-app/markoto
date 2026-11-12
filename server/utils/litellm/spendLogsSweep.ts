import * as Sentry from '@sentry/nuxt'
import { Pool } from 'pg'
import { litellmDbUrl } from './litellmDb'
import { DAY_MS } from '~~/shared/config/units'
import { useLogger } from '../platform/logger'

const log = useLogger('spend-logs-sweep')

// LiteLLM `LiteLLM_SpendLogs` retention sweeper. Every billable AI call
// writes a row, so the table grows linearly with traffic. /spend/tags aggregation reads it on every
// admin-dashboard refresh, so unbounded growth eventually impacts
// dashboard responsiveness.
//
// 90-day retention matches the window we keep `processed_webhook_events`
// — long enough for forensic queries, short enough that the table
// stays bounded.
//
// Why direct DB access (not the proxy admin API): LiteLLM v1.83.14
// exposes `/spend/logs` (read), `/spend/logs/v2` (paginated read), and
// `/global/spend/reset` (resets balances but EXPLICITLY preserves the
// spend log rows). There's no admin-API endpoint that deletes rows.
// We connect to the proxy's own Postgres database (the `litellm` DB
// on the same instance as the app DB) and DELETE directly. The proxy
// has no write coordination on this table beyond its own connection
// pool, so a sweep window deletion is safe.
//
// Connection: a dedicated pool on the litellm DB (same Postgres instance,
// LiteLLM's own role when configured) — see ./litellmDb.ts.
//
// Failure-tolerant: a hiccup just leaves stale rows around for one
// more cycle. The sweep doesn't gate any user-facing behaviour.

const RETENTION_DAYS = 90
const TABLE_NAME = '"LiteLLM_SpendLogs"' // PascalCase + quoted (Prisma convention)
const TIMESTAMP_COL = '"startTime"'

let cachedPool: Pool | null = null

function pool(): Pool {
  if (cachedPool) return cachedPool
  cachedPool = new Pool({
    connectionString: litellmDbUrl(),
    // Single-connection pool — the sweep is one query per day.
    max: 1,
    // Tighter timeouts than the app pool: we'd rather fail fast and
    // retry next cycle than hold a connection while the proxy DB is
    // sluggish.
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000
  })
  return cachedPool
}

/** Test-only: drop the cached pool so a fresh connection is made next call. */
export function _resetSpendLogsSweepPool(): void {
  if (cachedPool) {
    void cachedPool.end()
    cachedPool = null
  }
}

export async function runSpendLogsSweep(): Promise<{ deleted: number } | null> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * DAY_MS)
  const cutoffIso = cutoff.toISOString()

  let result: { deleted: number }
  try {
    const r = await pool().query<{ count: string }>(
      `DELETE FROM ${TABLE_NAME} WHERE ${TIMESTAMP_COL} < $1`,
      [cutoffIso]
    )
    result = { deleted: r.rowCount ?? 0 }
  } catch (e) {
    const msg = `[spend-logs-sweep] DELETE failed: ${e instanceof Error ? e.message : e}`
    log.warn('DELETE failed', { err: e })
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'spend-logs-sweep', event: 'delete_failed' }
    })
    return null
  }

  log.info('deleted old rows', { deleted: result.deleted, olderThan: cutoffIso.slice(0, 10) })
  return result
}
