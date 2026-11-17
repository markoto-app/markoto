// Schedule of every background sweeper and worker started by a Nitro plugin
// (`server/plugins/`). One table, so the cadence of the whole fleet can be read
// and compared in one place. Server-only: nothing here reaches the browser.
//
// `intervalMs`      time between runs.
// `startupDelayMs`  wait before the first run after boot (plugins without one
//                   run their first pass at the first interval).
// `staleAfterMs` / `idleAfterMs` / `idleAfterDays`
//                   the age a record must reach before that sweeper acts on it.

import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '../../shared/config/units'

interface SweepSchedule {
  intervalMs: number
  startupDelayMs?: number
  staleAfterMs?: number
  idleAfterMs?: number
  idleAfterDays?: number
}

export const SWEEPS = {
  abuseReports: { intervalMs: DAY_MS, startupDelayMs: 50 * SECOND_MS },
  adConversions: { intervalMs: HOUR_MS, startupDelayMs: 40 * SECOND_MS },
  accountDeletion: { intervalMs: HOUR_MS },
  aiCreditSettlement: { intervalMs: HOUR_MS },
  aiRecords: { intervalMs: DAY_MS, startupDelayMs: 30 * SECOND_MS },
  aiSpendRollup: { intervalMs: 6 * HOUR_MS, startupDelayMs: 5 * MINUTE_MS },
  // Must stay strictly longer than the 5-minute agentic-loop deadline
  // (AI_SESSION_HARD_DEADLINE_MS in server/utils/agentic/limits.ts).
  analyticsRetention: { intervalMs: DAY_MS, startupDelayMs: 5 * MINUTE_MS },
  aiSessions: { intervalMs: MINUTE_MS, staleAfterMs: 7 * MINUTE_MS },
  auditLog: { intervalMs: DAY_MS, startupDelayMs: 45 * SECOND_MS },
  customDomainRecheck: { intervalMs: 15 * MINUTE_MS },
  dataExportExpiry: { intervalMs: HOUR_MS },
  dataExportWorker: { intervalMs: MINUTE_MS },
  imageGc: { intervalMs: 6 * HOUR_MS, startupDelayMs: 10 * MINUTE_MS },
  inactiveDocs: { intervalMs: DAY_MS, startupDelayMs: 30 * SECOND_MS },
  knowledge: { intervalMs: 2 * MINUTE_MS, staleAfterMs: 10 * MINUTE_MS },
  litellmKeyReconcile: { intervalMs: 6 * HOUR_MS },
  mcpSessions: { intervalMs: DAY_MS, startupDelayMs: 30 * SECOND_MS, idleAfterDays: 90 },
  orphanCleanup: { intervalMs: HOUR_MS, startupDelayMs: 30 * SECOND_MS },
  spendLogs: { intervalMs: DAY_MS },
  subscriptionCancelBackfill: { intervalMs: DAY_MS, startupDelayMs: 2 * MINUTE_MS },
  waitlist: { intervalMs: HOUR_MS },
  webhookEvents: { intervalMs: DAY_MS },
  workspaceBudgetAlerts: { intervalMs: 15 * MINUTE_MS },
  workspaceInvites: { intervalMs: HOUR_MS },
  yDocPool: { intervalMs: MINUTE_MS, idleAfterMs: 5 * MINUTE_MS }
} as const satisfies Record<string, SweepSchedule>
