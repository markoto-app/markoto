import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import * as Sentry from '@sentry/nuxt'
import { users } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { litellmDbUrl } from '../litellm/litellmDb'
import { getTiers } from './tierConfig'
import { effectivePlan, isBillingEnabled } from './billingMode'
import { planToBudgetUsd } from '~~/shared/billing/aiPoints'
import { getPooledWorkspace, workspaceAiBudgetUsd } from './workspaceBilling'
import { ensureWorkspaceTeam, workspaceTeamId } from '../litellm/workspaceTeams'
import { setUserKeyMaxBudget, userKeyBudgetUsd } from '../litellm/userKeys'
import { creditPeriod, previousCreditPeriod } from './aiCreditBudget'
import {
  expireGrants,
  getPeriodPlanBudget,
  listSubjectsWithCredits,
  recordPeriodPlanBudget,
  settleMonth,
  type CreditSubject
} from '../../repos/aiCreditGrants'
import { useEnv } from '~~/shared/env/load'

// AI credit top-ups: orchestration.
//
//   Budget  = plan budget + credits left + credits used this month
//             (`aiCreditBudget.ts`, applied by `recomputeCreditBudget`).
//   Using   = LiteLLM meters spend, not credits. The settlement
//             (`runCreditSettlement`, hourly) reads a month's spend from
//             LiteLLM's spend logs and takes what passed the plan budget
//             from the grants, soonest-expiring first (`settleMonth`,
//             idempotent per month). It settles the previous month too,
//             so the tail before LiteLLM's reset on the 1st is counted —
//             against the plan budget recorded while that month was
//             open, not today's.
//   Expiry  = 12 months after purchase (`expireGrants`).
// The plan allowance is always used before purchased credits.

let cachedPool: Pool | null = null
function spendDb(): Pool {
  if (!cachedPool) cachedPool = new Pool({ connectionString: litellmDbUrl(), max: 2 })
  return cachedPool
}

function isStubMode(): boolean {
  return useEnv().test.litellmStub
}

function monthBounds(period: string): { from: Date, to: Date } {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) }
}

/**
 * A subject's platform-paid AI spend in one month, USD, from LiteLLM's
 * spend logs: the user's personal key (by its hashed token, the stored
 * key id), or every key of the workspace's team.
 */
export async function monthSpendUsd(subject: CreditSubject, period: string): Promise<number> {
  if (isStubMode()) return 0
  const { from, to } = monthBounds(period)
  if (subject.type === 'user') {
    const keyId = (await useDatabase().select({ keyId: users.litellmKeyId }).from(users).where(eq(users.id, Number(subject.id))).limit(1))[0]?.keyId
    if (!keyId) return 0
    const r = await spendDb().query<{ spend: number | null }>(
      'SELECT coalesce(sum(spend), 0)::float8 AS spend FROM "LiteLLM_SpendLogs" WHERE api_key = $1 AND "startTime" >= $2 AND "startTime" < $3',
      [keyId, from, to]
    )
    return Number(r.rows[0]?.spend ?? 0)
  }
  const r = await spendDb().query<{ spend: number | null }>(
    'SELECT coalesce(sum(spend), 0)::float8 AS spend FROM "LiteLLM_SpendLogs" WHERE team_id = $1 AND "startTime" >= $2 AND "startTime" < $3',
    [workspaceTeamId(subject.id), from, to]
  )
  return Number(r.rows[0]?.spend ?? 0)
}

/** The subject's plan budget for a month, USD (without credits). */
export async function planBudgetUsd(subject: CreditSubject): Promise<number> {
  if (subject.type === 'user') {
    const row = (await useDatabase().select({ plan: users.plan, planValidUntil: users.planValidUntil }).from(users).where(eq(users.id, Number(subject.id))).limit(1))[0]
    return row ? planToBudgetUsd(effectivePlan(row.plan, row.planValidUntil), getTiers()) : 0
  }
  const pool = await getPooledWorkspace(subject.id)
  return pool ? workspaceAiBudgetUsd(pool) : 0
}

/** Push the subject's current budget (plan + credits) to LiteLLM. Best-effort. */
export async function recomputeCreditBudget(subject: CreditSubject): Promise<void> {
  if (isStubMode()) return
  try {
    if (subject.type === 'user') {
      const row = (await useDatabase().select({ plan: users.plan, planValidUntil: users.planValidUntil, keyId: users.litellmKeyId }).from(users).where(eq(users.id, Number(subject.id))).limit(1))[0]
      if (!row?.keyId) return // budget applied when the key is created
      const plan = effectivePlan(row.plan, row.planValidUntil)
      await setUserKeyMaxBudget(Number(subject.id), plan, await userKeyBudgetUsd(Number(subject.id), plan))
      return
    }
    const pool = await getPooledWorkspace(subject.id)
    if (pool) await ensureWorkspaceTeam(pool)
  } catch (e) {
    console.warn(`[aiCredits] budget update for ${subject.type}:${subject.id} failed: ${e instanceof Error ? e.message : e}`)
    Sentry.captureException(e, { tags: { component: 'aiCredits', event: 'budget_update_failed' } })
  }
}

/**
 * Settle one subject's previous + current month, then apply its budget.
 *
 * Each month is settled against the plan budget recorded for it while it
 * was open (`recordPeriodPlanBudget`: the highest one), never against
 * today's plan — after a cancellation today's budget is 0 (workspace) or
 * the small Free one, and the month's spend the plan had already covered
 * would be taken from the purchased credits. A previous month without a
 * recorded budget had no settlement run while it was open (no credits
 * yet) and is left alone.
 */
export async function settleSubject(subject: CreditSubject, now: Date = new Date()): Promise<void> {
  const previous = previousCreditPeriod(now)
  const previousBudget = await getPeriodPlanBudget(subject, previous)
  if (previousBudget !== null) {
    const spend = await monthSpendUsd(subject, previous)
    await settleMonth(subject, previous, Math.max(0, spend - previousBudget), now)
  }
  const current = creditPeriod(now)
  const currentBudget = await recordPeriodPlanBudget(subject, current, await planBudgetUsd(subject))
  const spend = await monthSpendUsd(subject, current)
  await settleMonth(subject, current, Math.max(0, spend - currentBudget), now)
  await recomputeCreditBudget(subject)
}

/** Hourly: expire old grants, settle every subject with credits, update budgets. */
export async function runCreditSettlement(now: Date = new Date()): Promise<{ subjects: number, failed: number }> {
  const summary = { subjects: 0, failed: 0 }
  if (!isBillingEnabled()) return summary
  const expired = await expireGrants(now)
  // Credits that expired since the start of last month may still owe
  // that month's settlement.
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const subjects = new Map<string, CreditSubject>()
  for (const s of [...expired, ...await listSubjectsWithCredits(since)]) subjects.set(`${s.type}:${s.id}`, s)
  for (const subject of subjects.values()) {
    summary.subjects++
    try {
      await settleSubject(subject, now)
    } catch (e) {
      summary.failed++
      console.warn(`[aiCredits] settlement of ${subject.type}:${subject.id} failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  return summary
}
