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

import { litellmKeyListResponse, type LitellmListedKey } from './adminResponses'
import { listUsersWithKeys } from '../../repos/litellmKeys'
import { effectivePlan } from '../billing/billingMode'
import { getTiers } from '../billing/tierConfig'
import { planToBudgetUsd } from '~~/shared/billing/aiPoints'
import type { PlanName } from '~~/shared/config/tiers'
import { openSecretOrNull, secretContext } from '../platform/secretBox'
import { creditBudgetExtraUsd } from '../billing/aiCreditBudget'
import { listSubjectsWithCredits } from '../../repos/aiCreditGrants'
import { litellmAdminFetch } from './litellmAdmin'
import { ensureFreeTierTeam, ensureFreeTierTeamMember, FREE_TIER_BUDGET_DURATION, teamIdForPlan } from './freeTierTeam'
import { DAY_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'
import type { RawEnv } from '~~/shared/env/define'
import { useLogger } from '../platform/logger'

const log = useLogger('litellm-key-reconcile')

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

type ListedKey = LitellmListedKey

export interface DesiredKeyState {
  teamId: string | null
  maxBudget: number
  budgetDuration: string
}

/** Pure: what a user's key should look like. */
export function desiredKeyState(plan: PlanName, planValidUntil: Date | null, env?: RawEnv): DesiredKeyState {
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
    const payload = litellmKeyListResponse.parse(await res.json())
    const keys = payload.keys
    for (const k of keys) {
      out.set(k.token, { token: k.token, team_id: k.team_id ?? null, max_budget: k.max_budget ?? null, budget_duration: k.budget_duration ?? null })
    }
    const totalPages = payload.total_pages ?? null
    if (keys.length === 0 || (totalPages !== null && page >= totalPages)) break
  }
  return out
}

export async function reconcileUserKeys(): Promise<KeyReconcileSummary> {
  const summary: KeyReconcileSummary = { checked: 0, updated: 0, missing: 0, failed: 0 }
  if (useEnv().test.litellmStub) return summary

  const rows = await listUsersWithKeys()
  if (rows.length === 0) return summary

  // The team must exist before any key can be pointed at it.
  await ensureFreeTierTeam()
  const listed = await listAllKeys()
  // Only users who bought top-ups need the credit lookup.
  const usersWithCredits = new Set((await listSubjectsWithCredits(new Date(Date.now() - 62 * DAY_MS)))
    .filter(s => s.type === 'user').map(s => s.id))

  for (const row of rows) {
    if (!row.keyId || !row.keyToken) continue
    summary.checked++
    const outcome = await reconcileKey({ id: row.id, plan: row.plan, planValidUntil: row.planValidUntil, keyId: row.keyId, keyToken: row.keyToken }, listed, usersWithCredits)
    if (outcome !== 'unchanged') summary[outcome]++
  }
  if (summary.updated > 0 || summary.missing > 0 || summary.failed > 0) {
    log.info('key reconcile finished', { ...summary })
  }
  return summary
}

interface KeyedUser {
  id: number
  plan: Parameters<typeof desiredKeyState>[0]
  planValidUntil: Parameters<typeof desiredKeyState>[1]
  keyId: string
  keyToken: string
}

/** Bring one user's key in line with their plan (and top-up credits); what happened, for the summary. */
async function reconcileKey(
  row: KeyedUser,
  listed: Awaited<ReturnType<typeof listAllKeys>>,
  usersWithCredits: ReadonlySet<string>
): Promise<'missing' | 'unchanged' | 'updated' | 'failed'> {
  const current = listed.get(row.keyId)
  if (!current) return 'missing'
  const desired = desiredKeyState(row.plan, row.planValidUntil)
  // Top-up credits raise the key's budget on top of the plan's.
  if (usersWithCredits.has(String(row.id))) {
    desired.maxBudget = Math.round((desired.maxBudget + await creditBudgetExtraUsd({ type: 'user', id: String(row.id) })) * 10_000) / 10_000
  }
  if (!keyNeedsUpdate(current, desired)) return 'unchanged'
  // Unreadable token: ensureUserKey replaces the key on the user's next AI call.
  const token = openSecretOrNull('litellm-user-key', secretContext.litellmUserKey(row.id), row.keyToken)
  if (!token) return 'failed'
  try {
    // LiteLLM only moves a key into a team whose member its user is.
    if (desired.teamId) await ensureFreeTierTeamMember(row.id)
    const res = await litellmAdminFetch('/key/update', {
      method: 'POST',
      body: JSON.stringify({
        key: token,
        team_id: desired.teamId,
        max_budget: desired.maxBudget,
        budget_duration: desired.budgetDuration
      })
    })
    if (!res.ok) {
      throw new Error(`LiteLLM answered ${res.status}`)
    }
    return 'updated'
  } catch (e) {
    log.warn('/key/update failed', { userId: row.id, err: e })
    return 'failed'
  }
}
