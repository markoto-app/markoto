import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { useDatabase } from '../database'
import { planToBudgetUsd } from '~~/shared/billing/aiPoints'
import { getTiers } from '~~/server/utils/tierConfig'
import type { PlanName } from '~~/shared/config/tiers'
import { encryptToken, decryptToken } from './tokenCrypto'
import { litellmAdminFetch } from './litellmAdmin'
import { ensureFreeTierTeam, ensureFreeTierTeamMember, teamIdForPlan } from './freeTierTeam'

// Per-user LiteLLM virtual-key CRUD. Single source of truth for the
// user's AI budget. Every billable AI call goes through
// `useLitellmForUser(virtualKeyToken)`; LiteLLM's spend tracker
// enforces the `max_budget` set at the user's plan tier. Stripe
// webhooks call `updateUserKeyBudget` / `resetUserKeySpend` on plan
// changes + monthly renewals.

// ─── Stub mode (for harnesses without a live proxy) ────────────────────
//
// Phase 7: integration tests bring up a real `litellm-test` container
// and exercise the actual /key/* admin surface. The unit-test path
// (vitest --project=unit) doesn't bring up docker — it sets
// `LITELLM_TEST_STUB=1` so `ensureUserKey` returns a stub handle and
// the budget-update / spend-reset / key-info helpers no-op. Don't
// gate on TEST_MODE alone: TEST_MODE is also set in integration where
// the real proxy IS reachable, and stubbing there would defeat the
// regression coverage we're adding.
const TEST_STUB_TOKEN = 'sk-fake-test-virtual-key'
const TEST_STUB_KEY_ID_PREFIX = 'test-stub-'
function isStubMode(): boolean {
  return process.env.LITELLM_TEST_STUB === '1'
}

// ─── Errors ────────────────────────────────────────────────────────────

/**
 * Thrown when LiteLLM rejects an LLM call because the user's
 * `max_budget` has been crossed. Replaces the legacy `BudgetExhausted`
 * (Phase 6 retired the app-side counter — LiteLLM is the only gate).
 *
 * Caller paths catch this and emit the doc-breadcrumb upgrade message
 * via `runLoop`'s existing `emitBudgetBreadcrumb` flow.
 */
export class LitellmBudgetExhausted extends Error {
  readonly userId: number
  constructor(userId: number, message?: string) {
    super(message ?? `LiteLLM budget exhausted for user ${userId}.`)
    this.name = 'LitellmBudgetExhausted'
    this.userId = userId
  }
}

/** Predicate: is this error a budget_exceeded from LiteLLM? */
export function isBudgetExceededError(err: unknown): boolean {
  if (!err) return false
  const msg = errorAsString(err)
  return /budget_exceeded|Budget has been exceeded/i.test(msg)
}

function errorAsString(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}

// ─── Public API ────────────────────────────────────────────────────────

interface UserKeyHandle {
  /** LiteLLM's internal `token_id` (returned as `token` from /key/generate). */
  keyId: string
  /** The `sk-...` token used as a Bearer credential — stored encrypted at rest. */
  token: string
}

/**
 * Generate a new LiteLLM virtual key for the user with the right plan
 * budget. Persists the encrypted token + key id to `users` so future
 * calls can use it without re-creating.
 *
 * Idempotent against concurrent first-uses: the unique constraint on
 * `users.litellm_key_id` ensures only one row succeeds; the loser
 * re-reads the winner's key.
 */
export async function createUserKey(userId: number, plan: PlanName): Promise<UserKeyHandle> {
  const budget = planToBudgetUsd(plan, getTiers())
  // Free-tier keys join the shared monthly pool (`freeTierTeam.ts`) when
  // a global ceiling is configured; the team must exist first.
  const teamId = teamIdForPlan(plan) === null ? null : await ensureFreeTierTeam()
  const res = await litellmAdminFetch('/key/generate', {
    method: 'POST',
    body: JSON.stringify({
      max_budget: budget,
      ...(teamId ? { team_id: teamId } : {}),
      // Monthly spend reset. LiteLLM resets `spend` to 0 every
      // `budget_duration` (reset date lands on the 1st of the month —
      // matches the "resets on the first" copy in the AI Points UI). This
      // is the ONLY periodic reset now: free users have no Stripe invoice
      // to hang a reset on, so without this their "$1/month" was a lifetime
      // $1. Paid users reset here too — we deliberately do NOT also reset on
      // invoice.paid (that would double-reset and over-grant budget).
      budget_duration: '30d',
      user_id: String(userId),
      // Abuse cap. The user can't make more than 60 LLM calls/min from
      // a single virtual key. Generous for normal use (the agentic loop
      // fires ~5 calls per turn at most; 60/min covers a heavy session).
      // Replaces the legacy per-app-route rate limits dropped in Phase 6.
      rpm_limit: 60,
      // Opt the key into client-supplied `metadata.tags` (the multi-
      // axis spend tags from `featureTags.ts` — feature: / workspace:
      // / user: / doc:). Without this, LiteLLM strips every tag we
      // attach: the proxy treats client-tag injection as a routing
      // surface and requires per-key opt-in. Set in `metadata` because
      // /key/generate stashes opaque key state there.
      metadata: { allow_client_tags: true }
      // No `models` filter — let the user's key access every model
      // registered in config.yaml. Per-user model gating would need a
      // separate config knob; right now plans differ on budget only.
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[litellmKeys] /key/generate failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const payload = await res.json() as { key?: string, token_id?: string, token?: string }
  const token = payload.key
  // LiteLLM exposes the bookkeeping handle under either `token_id` or
  // `token` depending on version; prefer `token_id` (newer) and fall
  // back. We store both the bookkeeping handle (for /key/info etc.)
  // AND the encrypted bearer token.
  const keyId = payload.token_id ?? payload.token ?? ''
  if (!token || !keyId) {
    throw new Error('[litellmKeys] /key/generate response missing key or token_id')
  }

  const db = useDatabase()
  await db.update(users).set({
    litellmKeyId: keyId,
    litellmKeyToken: encryptToken(token)
  }).where(eq(users.id, userId))

  return { keyId, token }
}

/**
 * Lazy-create a virtual key on first use. Returns the existing one if
 * `users.litellmKeyId` is already set; otherwise creates + persists.
 */
export async function ensureUserKey(userId: number, plan: PlanName): Promise<UserKeyHandle> {
  const db = useDatabase()
  const rows = await db.select({
    keyId: users.litellmKeyId,
    keyToken: users.litellmKeyToken
  }).from(users).where(eq(users.id, userId)).limit(1)
  const row = rows[0]
  if (row?.keyId && row?.keyToken) {
    return { keyId: row.keyId, token: decryptToken(row.keyToken) }
  }
  if (isStubMode()) {
    // Persist a stub so subsequent reads don't churn — same shape as
    // a real key, no LiteLLM round-trip.
    const stubKeyId = `${TEST_STUB_KEY_ID_PREFIX}${userId}`
    await db.update(users).set({
      litellmKeyId: stubKeyId,
      litellmKeyToken: encryptToken(TEST_STUB_TOKEN)
    }).where(eq(users.id, userId))
    return { keyId: stubKeyId, token: TEST_STUB_TOKEN }
  }
  return await createUserKey(userId, plan)
}

/**
 * Update an existing key's `max_budget` to match a (potentially-new)
 * plan. Called by Stripe webhooks on `checkout.session.completed`,
 * `customer.subscription.updated`, `invoice.payment_failed` (drop to
 * free), `customer.subscription.deleted` (drop to free).
 *
 * Lazy-creates if the user doesn't have a key yet (race: subscription
 * webhook arrives before first AI use).
 */
export async function updateUserKeyBudget(userId: number, plan: PlanName): Promise<void> {
  if (isStubMode()) return
  const handle = await ensureUserKey(userId, plan)
  const budget = planToBudgetUsd(plan, getTiers())
  // Join / leave the free-tier pool with the plan: a paid plan must not be
  // capped by (nor spend) the free users' shared ceiling. `null` detaches.
  const teamId = teamIdForPlan(plan) === null ? null : await ensureFreeTierTeam()
  // LiteLLM only moves a key into a team whose member its user is.
  if (teamId) await ensureFreeTierTeamMember(userId)
  const res = await litellmAdminFetch('/key/update', {
    method: 'POST',
    body: JSON.stringify({
      key: handle.token,
      max_budget: budget,
      team_id: teamId,
      // Keep the monthly reset schedule attached on every budget change.
      // Keys created before this field existed pick it up on their next
      // plan change; new keys already have it from /key/generate.
      budget_duration: '30d'
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[litellmKeys] /key/update failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

/**
 * Test-only: set the key's `max_budget` to `dollars` directly (without
 * plan-derivation). Used by `/api/_test/exhaust-litellm-budget` to slam
 * the budget against current spend so the next call trips the proxy's
 * budget gate. Mirrors the production flow `updateUserKeyBudget` uses
 * — same `/key/update` payload, just with the budget value passed in.
 */
export async function setUserKeyMaxBudget(userId: number, plan: PlanName, dollars: number): Promise<void> {
  if (isStubMode()) return
  const handle = await ensureUserKey(userId, plan)
  const res = await litellmAdminFetch('/key/update', {
    method: 'POST',
    body: JSON.stringify({
      key: handle.token,
      max_budget: dollars
    })
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[litellmKeys] /key/update failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

/**
 * Reset the cumulative spend back to 0 — typically on `invoice.paid`
 * (monthly renewal). The `max_budget` stays the same; only `spend`
 * resets, giving the user a clean cycle. Returns false (after logging)
 * when the proxy refused — callers don't fail on it.
 */
export async function resetUserKeySpend(userId: number): Promise<boolean> {
  if (isStubMode()) return true
  const db = useDatabase()
  const rows = await db.select({
    keyToken: users.litellmKeyToken
  }).from(users).where(eq(users.id, userId)).limit(1)
  const encrypted = rows[0]?.keyToken
  if (!encrypted) {
    // No key yet — nothing to reset. The next AI call will create one
    // with the right budget via `ensureUserKey`.
    return true
  }
  const token = decryptToken(encrypted)
  const res = await litellmAdminFetch(`/key/${encodeURIComponent(token)}/reset_spend`, {
    method: 'POST',
    // LiteLLM >= 1.10x validates a JSON body on this route (a bodyless
    // POST is a 422); `reset_to: 0` is the "clean cycle" we want.
    body: JSON.stringify({ reset_to: 0 })
  })
  if (!res.ok) {
    // 404 on `/key/{key}/reset_spend` means LiteLLM lost the key
    // (e.g. DB wipe on the LiteLLM side). Rather than 5xx the webhook,
    // log + recreate via ensureUserKey on the next AI call.
    const text = await res.text().catch(() => '')
    console.warn(`[litellmKeys] /key/reset_spend failed: ${res.status} ${text.slice(0, 200)}`)
    return false
  }
  return true
}

type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>

/**
 * The HTTP half of `deleteUserKey`: `/key/delete` for the bearer token
 * (when the user ever got a key) and `/user/delete` for LiteLLM's user
 * record. A 404 counts as done. Never throws; returns false after
 * logging. Takes the admin fetch as a parameter so the integration suite
 * can run it against the real `litellm-test` proxy.
 */
export async function deleteLitellmIdentity(adminFetch: AdminFetch, token: string | null, userId: number): Promise<boolean> {
  let ok = true
  try {
    if (token) {
      const res = await adminFetch('/key/delete', {
        method: 'POST',
        body: JSON.stringify({ keys: [token] })
      })
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '')
        console.warn(`[litellmKeys] /key/delete failed: ${res.status} ${text.slice(0, 200)}`)
        ok = false
      }
    }
    const resUser = await adminFetch('/user/delete', {
      method: 'POST',
      body: JSON.stringify({ user_ids: [String(userId)] })
    })
    if (!resUser.ok && resUser.status !== 404) {
      const text = await resUser.text().catch(() => '')
      console.warn(`[litellmKeys] /user/delete failed: ${resUser.status} ${text.slice(0, 200)}`)
      ok = false
    }
  } catch (e) {
    console.warn(`[litellmKeys] key deletion failed: ${e instanceof Error ? e.message : String(e)}`)
    ok = false
  }
  return ok
}

/**
 * Account deletion: remove the user's LiteLLM virtual key and LiteLLM's
 * user record (keyed by our internal user id, also a free-tier team
 * member). Without this both outlive the account. LiteLLM's spend logs
 * are pruned separately by the 90-day `spend-logs-sweep`.
 *
 * Best effort: a proxy refusal or network error is logged and reported
 * as `false`; it never blocks the local deletion.
 */
export async function deleteUserKey(userId: number): Promise<boolean> {
  if (isStubMode()) return true
  const db = useDatabase()
  const rows = await db.select({ keyToken: users.litellmKeyToken })
    .from(users).where(eq(users.id, userId)).limit(1)
  const encrypted = rows[0]?.keyToken
  let token: string | null = null
  if (encrypted) {
    try {
      token = decryptToken(encrypted)
    } catch (e) {
      console.warn(`[litellmKeys] could not decrypt the key token for deletion: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return deleteLitellmIdentity(litellmAdminFetch, token, userId)
}

interface KeyInfo {
  /** Cumulative dollars spent in the current period. */
  spend: number
  /** The key's `max_budget` ceiling in dollars. */
  maxBudget: number
}

/**
 * Read current spend + max_budget for a user's key. Used by
 * /api/ai/credits to populate the AI Points UI.
 */
export async function getUserKeyInfo(userId: number, plan: PlanName): Promise<KeyInfo> {
  const handle = await ensureUserKey(userId, plan)
  if (isStubMode()) {
    // No real spend in tests — surface the static plan budget with zero
    // spend so the AI Points UI renders "{full} / {full} pts".
    return { spend: 0, maxBudget: planToBudgetUsd(plan, getTiers()) }
  }
  const res = await litellmAdminFetch(`/key/info?key=${encodeURIComponent(handle.token)}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`[litellmKeys] /key/info failed: ${res.status} ${text.slice(0, 200)}`)
  }
  const payload = await res.json() as {
    info?: { spend?: number, max_budget?: number }
  }
  const info = payload.info ?? {}
  return {
    spend: typeof info.spend === 'number' ? info.spend : 0,
    maxBudget: typeof info.max_budget === 'number' ? info.max_budget : planToBudgetUsd(plan, getTiers())
  }
}

/**
 * Decrypt + return the raw bearer token. Used at every billable
 * callsite to construct an OpenAI SDK client via
 * `useLitellmForUser(token)`. Created lazily if not yet set.
 *
 * Plaintext NEVER persisted in logs; lifetime is the function-call
 * scope of the caller.
 */
export async function getUserKeyToken(userId: number, plan: PlanName): Promise<string> {
  const handle = await ensureUserKey(userId, plan)
  return handle.token
}
