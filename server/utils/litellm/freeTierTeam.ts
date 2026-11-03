// The global monthly ceiling on platform-paid AI for free-tier users.
//
// Every free-tier user's LiteLLM virtual key belongs to ONE LiteLLM team,
// `markoto-free-tier`, whose `max_budget` is the ceiling
// (`NUXT_FREE_TIER_TOTAL_BUDGET_USD`; hosted default 500, unset / 0 = no
// ceiling and no team). The proxy enforces it: before every call it checks
// the key's own `max_budget` (the per-user allowance, `TIER_FREE_LITELLM_
// BUDGET_USD`) AND the team's, so the pool is spent down by every
// platform-paid call any free user makes — the agentic loop, web-tool
// synthesis, MCP, transcription / image / dictation ticks on alias
// defaults — without app-side accounting. The team's `budget_duration`
// is the same `30d` the keys use, which LiteLLM normalises to the 1st of
// the month (verified on v1.106.4: `budget_reset_at` = next 1st, 00:00 UTC
// for both), so the pool and the per-user allowance refill together.
//
// What the team does NOT cover:
//   - BYOK calls (`byok/*`): zero-cost deployment, and LiteLLM skips the
//     budget gates for zero-cost models (verified: a BYOK call on a key
//     whose team is exhausted is still forwarded).
//   - paid tiers (billing on): their keys carry no team (`teamIdForPlan`).
//   - calls the app pays outside LiteLLM or with the master key: the
//     Staan search / Jina Reader fetch of web tools (bounded per user by
//     `NUXT_WEB_TOOLS_*_LIMIT`) and knowledge embeddings (bounded by the
//     knowledge file / byte caps).
//
// Membership is set when a key is created / its budget updated
// (`userKeys.ts`) and reconciled for existing keys by the
// `litellm-key-reconcile` sweeper (`keyReconcile.ts`).

import type { PlanName } from '~~/shared/config/tiers'
import { litellmAdminFetch } from './litellmAdmin'

/** Fixed LiteLLM team id (LiteLLM accepts a caller-chosen `team_id`), so no app-side storage is needed. */
export const FREE_TIER_TEAM_ID = 'markoto-free-tier'

/** Same reset cadence as the per-user keys (`userKeys.ts`). */
export const FREE_TIER_BUDGET_DURATION = '30d'

/** Stable machine code for "the shared monthly free pool is used up". */
export const FREE_ALLOWANCE_EXHAUSTED_CODE = 'ai/free-allowance-exhausted'

/** i18n key the client renders for the error (all 6 locales). */
export const FREE_ALLOWANCE_EXHAUSTED_MESSAGE_KEY = 'ai.freeAllowanceExhausted'

/** English fallback; the client prefers the i18n key. */
export const FREE_ALLOWANCE_EXHAUSTED_MESSAGE
  = 'This month\'s free AI allowance is used up. Add your own key in Settings → AI provider to keep going.'

type Env = Record<string, string | undefined>

/**
 * The configured ceiling in USD, or null when there is none (unset, empty,
 * `0`, negative or not a number — self-hosters run without a pool).
 */
export function freeTierTotalBudgetUsd(env: Env = process.env): number | null {
  const raw = (env.NUXT_FREE_TIER_TOTAL_BUDGET_USD ?? '').trim()
  if (raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

/** Problems with the configured value, logged once at boot. */
export function freeTierTotalBudgetProblems(env: Env = process.env): string[] {
  const raw = (env.NUXT_FREE_TIER_TOTAL_BUDGET_USD ?? '').trim()
  if (raw === '' || raw === '0') return []
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    return [`NUXT_FREE_TIER_TOTAL_BUDGET_USD="${raw.slice(0, 40)}" is not a non-negative number — no global free-tier ceiling is applied.`]
  }
  return []
}

/**
 * The LiteLLM team a key on `plan` belongs to: the free-tier pool for
 * free users while a ceiling is configured, otherwise none. Callers pass
 * the EFFECTIVE plan (billing off → always `free`).
 */
export function teamIdForPlan(plan: PlanName, env: Env = process.env): string | null {
  if (plan !== 'free') return null
  return freeTierTotalBudgetUsd(env) === null ? null : FREE_TIER_TEAM_ID
}

/**
 * Did LiteLLM reject the call because the free-tier POOL is exhausted?
 * The proxy's message is `Budget has been exceeded! Team=<team_id> …`
 * (HTTP 422 on v1.106.4); a per-key exhaustion reads `… Key=…` instead,
 * so the two are told apart by the team id.
 */
export function isFreeAllowanceExhaustedError(err: unknown): boolean {
  if (!err) return false
  let msg: string
  if (err instanceof Error) msg = err.message
  else if (typeof err === 'string') msg = err
  else msg = JSON.stringify(err)
  return msg.includes(`Team=${FREE_TIER_TEAM_ID}`) && /Budget has been exceeded|budget_exceeded/i.test(msg)
}

// ─── Team provisioning ──────────────────────────────────────────────────

/** Budget the team was last brought to in this process (skip the round trip when unchanged). */
let ensuredBudget: number | null = null

/** Test hook: forget the per-process "already ensured" memo. */
export function resetFreeTierTeamMemo(): void {
  ensuredBudget = null
  poolCache = null
}

interface TeamInfo {
  max_budget?: number | null
  spend?: number | null
  budget_duration?: string | null
  budget_reset_at?: string | null
}

async function readTeam(): Promise<TeamInfo | null> {
  const res = await litellmAdminFetch(`/team/info?team_id=${encodeURIComponent(FREE_TIER_TEAM_ID)}`)
  if (res.status === 404) {
    // "Team not found" (v1.106.4).
    await res.text().catch(() => '')
    return null
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[freeTierTeam] /team/info failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const payload = await res.json() as { team_info?: TeamInfo }
  return payload.team_info ?? null
}

/**
 * Create the free-tier team, or bring its `max_budget` / `budget_duration`
 * to the configured values. Idempotent; a no-op without a ceiling.
 * Returns the team id when a ceiling is active, else null.
 */
export async function ensureFreeTierTeam(env: Env = process.env): Promise<string | null> {
  const budget = freeTierTotalBudgetUsd(env)
  if (budget === null) return null
  if (ensuredBudget === budget) return FREE_TIER_TEAM_ID

  const existing = await readTeam()
  if (!existing) {
    const res = await litellmAdminFetch('/team/new', {
      method: 'POST',
      body: JSON.stringify({
        team_id: FREE_TIER_TEAM_ID,
        team_alias: FREE_TIER_TEAM_ID,
        max_budget: budget,
        budget_duration: FREE_TIER_BUDGET_DURATION,
        metadata: { purpose: 'markoto free-tier monthly AI pool' }
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      // Lost a create race with another instance: the team exists now.
      if (!/already exists/i.test(text)) {
        throw new Error(`[freeTierTeam] /team/new failed: ${res.status} ${text.slice(0, 200)}`)
      }
    }
  } else if (existing.max_budget !== budget || existing.budget_duration !== FREE_TIER_BUDGET_DURATION) {
    const res = await litellmAdminFetch('/team/update', {
      method: 'POST',
      body: JSON.stringify({
        team_id: FREE_TIER_TEAM_ID,
        max_budget: budget,
        budget_duration: FREE_TIER_BUDGET_DURATION
      })
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`[freeTierTeam] /team/update failed: ${res.status} ${text.slice(0, 200)}`)
    }
  }
  ensuredBudget = budget
  poolCache = null
  return FREE_TIER_TEAM_ID
}

/**
 * Make the LiteLLM user a member of the free-tier team. `/key/generate`
 * accepts a `team_id` without membership, but `/key/update` moving an
 * existing key (which carries a `user_id`) INTO the team answers 403
 * "User=<id> is not a member of the team" (v1.106.4) — so every update
 * that joins the pool calls this first. Idempotent: "already in team" is
 * success.
 */
export async function ensureFreeTierTeamMember(userId: number): Promise<void> {
  const res = await litellmAdminFetch('/team/member_add', {
    method: 'POST',
    body: JSON.stringify({ team_id: FREE_TIER_TEAM_ID, member: { role: 'user', user_id: String(userId) } })
  })
  if (res.ok) return
  const text = await res.text().catch(() => '')
  if (/already in team|team_member_already_in_team/i.test(text)) return
  throw new Error(`[freeTierTeam] /team/member_add failed: ${res.status} ${text.slice(0, 200)}`)
}

// ─── Pool status (for the UI) ───────────────────────────────────────────

export interface FreeTierPoolStatus {
  exhausted: boolean
  /** ISO timestamp of the next reset, when LiteLLM reports one. */
  resetsAt: string | null
}

const POOL_CACHE_TTL_MS = 15_000
let poolCache: { at: number, value: FreeTierPoolStatus | null } | null = null

/**
 * Whether the shared pool is used up. Cached for 15 s per process: the
 * AI Points UI polls it after every session, and the proxy is the real
 * gate anyway. Null without a ceiling, or when the proxy can't be read
 * (fail open: the UI then behaves as before and the proxy still refuses).
 */
export async function getFreeTierPoolStatus(env: Env = process.env): Promise<FreeTierPoolStatus | null> {
  const budget = freeTierTotalBudgetUsd(env)
  if (budget === null) return null
  const now = Date.now()
  if (poolCache && now - poolCache.at < POOL_CACHE_TTL_MS) return poolCache.value
  const value = await readPoolStatus(budget)
  poolCache = { at: now, value }
  return value
}

async function readPoolStatus(budget: number): Promise<FreeTierPoolStatus | null> {
  try {
    const team = await readTeam()
    if (!team) return { exhausted: false, resetsAt: null }
    const spend = typeof team.spend === 'number' ? team.spend : 0
    const max = typeof team.max_budget === 'number' ? team.max_budget : budget
    // Same comparison as the proxy's gate: it refuses once spend is
    // STRICTLY above max_budget (verified on v1.106.4).
    return { exhausted: spend > max, resetsAt: team.budget_reset_at ?? null }
  } catch (e) {
    console.warn(`[freeTierTeam] could not read the free-tier pool: ${e instanceof Error ? e.message : e}`)
    return null
  }
}
