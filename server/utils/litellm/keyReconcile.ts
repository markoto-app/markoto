// Reconciles every existing per-user LiteLLM virtual key with what the
// user's EFFECTIVE plan says it should be:
//
//   - `team_id`        — the free-tier pool (`freeTierTeam.ts`) for free
//                        users while a ceiling is configured, else none;
//   - `max_budget`     — the plan's `litellmBudgetUsd` (`TIER_*` overrides
//                        applied), so lowering `TIER_FREE_LITELLM_BUDGET_USD`
//                        reaches keys created under the old value;
//   - `budget_duration`— the monthly `30d` reset.
//
// Keys are created with these values (`createUserKey`) and re-set on plan
// changes (`updateUserKeyBudget`); this job covers keys that predate a
// config change. It is idempotent: one paginated `/key/list` read, then a
// `/key/update` only for keys that differ. Run by the
// `litellm-key-reconcile` plugin at boot and every 6 h, under its sweep lock.

import { isNotNull } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDatabase } from '../database'
import { effectivePlan } from '../billingMode'
import { getTiers } from '../tierConfig'
import { planToBudgetUsd } from '~~/shared/billing/aiPoints'
import type { PlanName } from '~~/shared/config/tiers'
import { decryptToken } from './tokenCrypto'
import { creditBudgetExtraUsd } from '../aiCreditBudget'
import { listSubjectsWithCredits } from '../../repos/aiCreditGrants'
import { litellmAdminFetch } from './litellmAdmin'
import { ensureFreeTierTeam, ensureFreeTierTeamMember, FREE_TIER_BUDGET_DURATION, teamIdForPlan } from './freeTierTeam'

const PAGE_SIZE = 100
/** Hard stop for the listing loop (100k keys) — guards against a proxy that never reports its last page. */
const MAX_PAGES = 1000

export interface KeyReconcileSummary {
  checked: number
  updated: number
  /** Users whose stored key id the proxy doesn't know (e.g. a wiped LiteLLM DB) — counted and logged, not recreated here. */
  missing: number
  failed: number
}

interface ListedKey {
  token: string
  team_id: string | null
  max_budget: number | null
  budget_duration: string | null
}

export interface DesiredKeyState {
  teamId: string | null
  maxBudget: number
  budgetDuration: string
}

/** Pure: what a user's key should look like. */
export function desiredKeyState(plan: PlanName, planValidUntil: Date | null, env: Record<string, string | undefined> = process.env): DesiredKeyState {
  const effective = effectivePlan(plan, planValidUntil)
  return {
    teamId: teamIdForPlan(effective, env),
    maxBudget: planToBudgetUsd(effective, getTiers()),
    budgetDuration: FREE_TIER_BUDGET_DURATION
  }
}

/** Pure: does the listed key differ from the desired state? */
export function keyNeedsUpdate(listed: Pick<ListedKey, 'team_id' | 'max_budget' | 'budget_duration'>, desired: DesiredKeyState): boolean {
  return (listed.team_id ?? null) !== desired.teamId
    || listed.max_budget !== desired.maxBudget
    || listed.budget_duration !== desired.budgetDuration
}

async function listAllKeys(): Promise<Map<string, ListedKey>> {
  const out = new Map<string, ListedKey>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await litellmAdminFetch(`/key/list?return_full_object=true&size=${PAGE_SIZE}&page=${page}`)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`[keyReconcile] /key/list failed: ${res.status} ${text.slice(0, 200)}`)
    }
    const payload = await res.json() as { keys?: unknown[], total_pages?: number | null }
    const keys = Array.isArray(payload.keys) ? payload.keys : []
    for (const raw of keys) {
      if (typeof raw !== 'object' || raw === null) continue
      const k = raw as Record<string, unknown>
      if (typeof k.token !== 'string') continue
      out.set(k.token, {
        token: k.token,
        team_id: typeof k.team_id === 'string' ? k.team_id : null,
        max_budget: typeof k.max_budget === 'number' ? k.max_budget : null,
        budget_duration: typeof k.budget_duration === 'string' ? k.budget_duration : null
      })
    }
    const totalPages = typeof payload.total_pages === 'number' ? payload.total_pages : null
    if (keys.length === 0 || (totalPages !== null && page >= totalPages)) break
  }
  return out
}

export async function reconcileUserKeys(): Promise<KeyReconcileSummary> {
  const summary: KeyReconcileSummary = { checked: 0, updated: 0, missing: 0, failed: 0 }
  if (process.env.LITELLM_TEST_STUB === '1') return summary

  const db = useDatabase()
  const rows = await db.select({
    id: users.id,
    plan: users.plan,
    planValidUntil: users.planValidUntil,
    keyId: users.litellmKeyId,
    keyToken: users.litellmKeyToken
  }).from(users).where(isNotNull(users.litellmKeyId))
  if (rows.length === 0) return summary

  // The team must exist before any key can be pointed at it.
  await ensureFreeTierTeam()
  const listed = await listAllKeys()
  // Only users who bought top-ups need the credit lookup (WP4).
  const usersWithCredits = new Set((await listSubjectsWithCredits(new Date(Date.now() - 62 * 24 * 3600 * 1000)))
    .filter(s => s.type === 'user').map(s => s.id))

  for (const row of rows) {
    if (!row.keyId || !row.keyToken) continue
    summary.checked++
    const current = listed.get(row.keyId)
    if (!current) {
      summary.missing++
      continue
    }
    const desired = desiredKeyState(row.plan, row.planValidUntil)
    // Top-up credits (WP4) raise the key's budget on top of the plan's.
    if (usersWithCredits.has(String(row.id))) {
      desired.maxBudget = Math.round((desired.maxBudget + await creditBudgetExtraUsd({ type: 'user', id: String(row.id) })) * 10_000) / 10_000
    }
    if (!keyNeedsUpdate(current, desired)) continue
    try {
      // LiteLLM only moves a key into a team whose member its user is.
      if (desired.teamId) await ensureFreeTierTeamMember(row.id)
      const res = await litellmAdminFetch('/key/update', {
        method: 'POST',
        body: JSON.stringify({
          key: decryptToken(row.keyToken),
          team_id: desired.teamId,
          max_budget: desired.maxBudget,
          budget_duration: desired.budgetDuration
        })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`${res.status} ${text.slice(0, 200)}`)
      }
      summary.updated++
    } catch (e) {
      summary.failed++
      console.warn(`[keyReconcile] /key/update for user ${row.id} failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  if (summary.updated > 0 || summary.missing > 0 || summary.failed > 0) {
    console.log(`[keyReconcile] checked=${summary.checked} updated=${summary.updated} missing=${summary.missing} failed=${summary.failed}`)
  }
  return summary
}
