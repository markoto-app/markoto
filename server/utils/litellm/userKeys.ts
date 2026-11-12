import { eq } from 'drizzle-orm'
import { users } from '../../db/schema'
import { litellmKeyGenerateResponse, litellmKeyInfoResponse } from './adminResponses'
import { useDatabase } from '../platform/database'
import { planToBudgetUsd } from '~~/shared/billing/aiPoints'
import { getTiers } from '~~/server/utils/billing/tierConfig'
import type { PlanName } from '~~/shared/config/tiers'
import { openSecretOrNull, sealSecret, secretContext } from '../platform/secretBox'
import { litellmAdminFetch } from './litellmAdmin'
import { ensureFreeTierTeam, ensureFreeTierTeamMember, teamIdForPlan } from './freeTierTeam'
import { creditBudgetExtraUsd } from '../billing/aiCreditBudget'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'

const log = useLogger('litellm-keys')

/** Plan budget + the user's top-up credits, USD. */
export async function userKeyBudgetUsd(userId: number, plan: PlanName): Promise<number> {
  return planToBudgetUsd(plan, getTiers()) + await creditBudgetExtraUsd({ type: 'user', id: String(userId) })
}

// Per-user LiteLLM virtual-key CRUD. Single source of truth for the
// user's AI budget. Every billable AI call goes through
// `useLitellmForUser(virtualKeyToken)`; LiteLLM's spend tracker
// enforces the `max_budget` set at the user's plan tier. Stripe
// webhooks call `updateUserKeyBudget` / `resetUserKeySpend` on plan
// changes.

// Stub mode for harnesses without a live proxy: integration tests run
// against a real `litellm-test` container, while the unit/repos tiers
// don't start docker and set
// `LITELLM_TEST_STUB=1` so `ensureUserKey` returns a stub handle and
// the budget-update / spend-reset / key-info helpers no-op. Don't
// gate on TEST_MODE alone: TEST_MODE is also set in integration where
// the real proxy IS reachable, and stubbing there would defeat the
// coverage of the real /key/* admin surface.
const TEST_STUB_TOKEN = 'sk-fake-test-virtual-key'
const TEST_STUB_KEY_ID_PREFIX = 'test-stub-'
function isStubMode(): boolean {
  return useEnv().test.litellmStub
}

/**
 * Thrown when LiteLLM rejects an LLM call because the user's
 * `max_budget` has been crossed (LiteLLM is the only budget gate).
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
  const budget = await userKeyBudgetUsd(userId, plan)
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
      // is the ONLY periodic reset: free users have no Stripe invoice
      // to hang a reset on, so without this their "$1/month" would be a
      // lifetime $1. Paid users reset here too — we deliberately do NOT also reset on
      // invoice.paid (that would double-reset and over-grant budget).
      budget_duration: '30d',
      user_id: String(userId),
      // Abuse cap. The user can't make more than 60 LLM calls/min from
      // a single virtual key. Generous for normal use (the agentic loop
      // fires ~5 calls per turn at most; 60/min covers a heavy session).
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
  const payload = litellmKeyGenerateResponse.parse(await res.json())
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
    litellmKeyToken: sealUserKey(userId, token)
  }).where(eq(users.id, userId))

  return { keyId, token }
}

function sealUserKey(userId: number, token: string): string {
  return sealSecret('litellm-user-key', secretContext.litellmUserKey(userId), token)
}

/** The stored bearer token, or null when it can't be decrypted (key lost / rotated away). */
function openUserKey(userId: number, sealed: string): string | null {
  return openSecretOrNull('litellm-user-key', secretContext.litellmUserKey(userId), sealed)
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
    const token = openUserKey(userId, row.keyToken)
    if (token) return { keyId: row.keyId, token }
    // Unreadable (encryption key lost or rotated without _PREVIOUS): the
    // bearer token is gone for good, so retire the old key by its id and
    // mint a fresh one rather than failing every AI call.
    log.warn('stored key token is unreadable; minting a new key', { userId })
    if (!isStubMode()) await retireKeyById(row.keyId)
  }
  if (isStubMode()) {
    // Persist a stub so subsequent reads don't churn — same shape as
    // a real key, no LiteLLM round-trip.
    const stubKeyId = `${TEST_STUB_KEY_ID_PREFIX}${userId}`
    await db.update(users).set({
      litellmKeyId: stubKeyId,
      litellmKeyToken: sealUserKey(userId, TEST_STUB_TOKEN)
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
  const budget = await userKeyBudgetUsd(userId, plan)
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
 * Reset the cumulative spend back to 0 (used when a paid plan
 * ends, so a user over the free cap isn't stuck until the monthly
 * reset). The `max_budget` stays the same; only `spend` resets. Returns false (after logging)
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
  const token = openUserKey(userId, encrypted)
  // Unreadable: the next AI call mints a new key (ensureUserKey) with zero spend.
  if (!token) return true
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
    log.warn('/key/reset_spend failed', { status: res.status })
    return false
  }
  return true
}

/**
 * Best-effort delete of a key we can no longer present as a bearer token.
 * LiteLLM's /key/delete accepts the hashed token id (`token_id`) as well as
 * the `sk-` token, so the orphan doesn't keep a budget in the proxy.
 */
async function retireKeyById(keyId: string): Promise<void> {
  try {
    const res = await litellmAdminFetch('/key/delete', { method: 'POST', body: JSON.stringify({ keys: [keyId] }) })
    if (!res.ok && res.status !== 404) log.warn('retiring an unreadable key failed', { status: res.status })
  } catch (e) {
    log.warn('retiring an unreadable key failed', { err: e })
  }
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
        log.warn('/key/delete failed', { status: res.status })
        ok = false
      }
    }
    const resUser = await adminFetch('/user/delete', {
      method: 'POST',
      body: JSON.stringify({ user_ids: [String(userId)] })
    })
    if (!resUser.ok && resUser.status !== 404) {
      log.warn('/user/delete failed', { status: resUser.status })
      ok = false
    }
  } catch (e) {
    log.warn('key deletion failed', { err: e })
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
    token = openUserKey(userId, encrypted)
    if (!token) log.warn('could not decrypt the key token for deletion')
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
  const { info } = litellmKeyInfoResponse.parse(await res.json())
  return {
    spend: info?.spend ?? 0,
    maxBudget: info?.max_budget ?? planToBudgetUsd(plan, getTiers())
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
