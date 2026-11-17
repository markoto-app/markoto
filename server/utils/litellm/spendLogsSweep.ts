import * as Sentry from '@sentry/nuxt'
import { deleteSpendLogsBefore } from '../../repos/litellmSpend'
import { system } from '../../repos/proofs'
import { DAY_MS } from '~~/shared/config/units'
import { useLogger } from '../platform/logger'

const log = useLogger('spend-logs-sweep')

// LiteLLM `LiteLLM_SpendLogs` retention sweeper. Every billable AI call
// writes a row, so the table grows linearly with traffic. The admin spend dashboard reads it on every
// refresh, so unbounded growth eventually impacts
// dashboard responsiveness.
//
// 90-day retention matches the window we keep `processed_webhook_events`
// long enough for forensic queries, short enough that the table
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
// Connection: the one pool on the litellm DB (same Postgres instance,
// LiteLLM's own role when configured), server/db/litellm.ts.
//
// Failure-tolerant: a hiccup just leaves stale rows around for one
// more cycle. The sweep doesn't gate any user-facing behaviour.

/** Days LiteLLM spend rows are kept (also the `ai_assistance` retention in the privacy register). */
export const SPEND_LOG_RETENTION_DAYS = 90

export async function runSpendLogsSweep(): Promise<{ deleted: number } | null> {
  const cutoff = new Date(Date.now() - SPEND_LOG_RETENTION_DAYS * DAY_MS)
  const cutoffIso = cutoff.toISOString()

  let result: { deleted: number }
  try {
    result = { deleted: await deleteSpendLogsBefore(system('spend-logs-sweep'), cutoff) }
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
