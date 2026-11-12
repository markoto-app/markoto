import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createError } from 'h3'
import { resetDb, testDb } from '../setup/db'
import { createUser } from '../setup/fixtures'
import { applyTestEnv } from '../setup/testEnv'
import { fakeOpenAiBaseUrl } from '../setup/env'
import { LITELLM_MASTER_KEY, LITELLM_URL, waitFor } from '../setup/byok'
import { sealSecret, secretContext } from '../../../server/utils/platform/secretBox'
import type { ResolvedAiProvider } from '../../../server/utils/aiProviders/resolve'

// The global monthly ceiling on platform-paid AI for free-tier users
// (`server/utils/litellm/freeTierTeam.ts`), against the REAL `litellm-test`
// proxy (LiteLLM v1.106.4). Runs the production helpers in-process, the
// integration server itself uses `LITELLM_TEST_STUB=1`, so the /key/*,
// /team/* and budget-gate wire contracts are what LiteLLM really does:
//
//   - a new free-tier key joins the `markoto-free-tier` team, whose
//     budget (NUXT_FREE_TIER_TOTAL_BUDGET_USD) resets monthly with the keys;
//   - existing keys are migrated in (and out again) idempotently;
//   - an exhausted team rejects platform-paid calls with an error the app
//     maps to 402 `ai/free-allowance-exhausted`, distinct from the
//     per-key budget: while zero-cost BYOK calls on the same key go on.
//
// The pre-call budget gate runs before any upstream request, so this needs
// no real provider key. One case makes a REAL GLM-5.3 Flash call and is
// opt-in: FREE_ALLOWANCE_LIVE=1 (litellm-test must have a real
// MISTRAL_API_KEY).

// The integration project runs files in ONE worker without isolation:
// snapshot what this file changes and put it back in afterAll.
const envBefore = { ...process.env }
const globalsBefore = { createError: Reflect.get(globalThis, 'createError') }

applyTestEnv()
process.env.LITELLM_TEST_STUB = ''
process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = '500'
process.env.TIER_FREE_LITELLM_BUDGET_USD = '0.5'
// The code under test reads the proxy from the typed env (shared/env).
process.env.NUXT_LITELLM_URL = LITELLM_URL
process.env.NUXT_LITELLM_MASTER_KEY = LITELLM_MASTER_KEY
Object.assign(globalThis, { createError })

const { createUserKey, getUserKeyToken, updateUserKeyBudget } = await import('../../../server/utils/litellm/userKeys')
const team = await import('../../../server/utils/litellm/freeTierTeam')
const { reconcileUserKeys } = await import('../../../server/utils/litellm/keyReconcile')
const { assertFreeAllowanceAvailable, freeAllowanceExhaustedHttpError } = await import('../../../server/utils/billing/freeAllowance')
const { useLitellmForUser } = await import('../../../server/utils/ai/litellmClient')

async function admin(path: string, body?: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const res = await fetch(`${LITELLM_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
  } catch { /* non-JSON error body */ }
  return { status: res.status, json }
}

async function keyInfo(token: string): Promise<Record<string, unknown>> {
  const { status, json } = await admin(`/key/info?key=${encodeURIComponent(token)}`)
  expect(status).toBe(200)
  const info = json.info
  return typeof info === 'object' && info !== null ? info as Record<string, unknown> : {}
}

async function teamInfo(): Promise<Record<string, unknown>> {
  const { status, json } = await admin(`/team/info?team_id=${team.FREE_TIER_TEAM_ID}`)
  expect(status).toBe(200)
  const info = json.team_info
  return typeof info === 'object' && info !== null ? info as Record<string, unknown> : {}
}

async function setTeamBudget(maxBudget: number): Promise<void> {
  expect((await admin('/team/update', { team_id: team.FREE_TIER_TEAM_ID, max_budget: maxBudget })).status).toBe(200)
  team.resetFreeTierTeamMemo()
}

/** A key as created before the free-allowance work: no team, the old $1 budget. */
async function legacyKey(userId: number): Promise<string> {
  const { status, json } = await admin('/key/generate', { max_budget: 1, user_id: String(userId), rpm_limit: 60 })
  expect(status).toBe(200)
  const token = String(json.key)
  await testDb().query('UPDATE users SET litellm_key_id = $1, litellm_key_token = $2 WHERE id = $3',
    [String(json.token_id ?? json.token), sealSecret('litellm-user-key', secretContext.litellmUserKey(userId), token), userId])
  return token
}

beforeAll(async () => {
  team.resetFreeTierTeamMemo()
  await team.ensureFreeTierTeam()
  await setTeamBudget(500)
})

beforeEach(async () => {
  await resetDb()
  process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = '500'
  team.resetFreeTierTeamMemo()
})

afterAll(async () => {
  await setTeamBudget(500)
  for (const k of Object.keys(process.env)) {
    if (!(k in envBefore)) Reflect.deleteProperty(process.env, k)
  }
  Object.assign(process.env, envBefore)
  Object.assign(globalThis, globalsBefore)
})

describe('free-tier pool: team provisioning', () => {
  it('the team carries the configured ceiling and resets monthly, like the keys', async () => {
    const info = await teamInfo()
    expect(info.max_budget).toBe(500)
    expect(info.budget_duration).toBe('30d')
    // LiteLLM normalises 30d to the 1st of the next month, 00:00 UTC.
    expect(String(info.budget_reset_at)).toMatch(/^\d{4}-\d{2}-01T00:00:00/)
  })

  it('regression: concurrent first uses on a fresh deploy both get the team (create race)', async () => {
    // Found by the ai-generate-image flow: the credits fetch and the first
    // AI call both created the team; the loser got LiteLLM's 500 "Unique
    // constraint failed" and the credits endpoint answered 500.
    expect((await admin('/team/delete', { team_ids: [team.FREE_TIER_TEAM_ID] })).status).toBe(200)
    team.resetFreeTierTeamMemo()
    const first = team.ensureFreeTierTeam()
    team.resetFreeTierTeamMemo() // a second instance: its own round trip
    const second = team.ensureFreeTierTeam()
    await expect(Promise.all([first, second])).resolves.toEqual([team.FREE_TIER_TEAM_ID, team.FREE_TIER_TEAM_ID])
    expect((await teamInfo()).max_budget).toBe(500)

    // Within one instance concurrent callers share one round trip.
    team.resetFreeTierTeamMemo()
    await expect(Promise.all([team.ensureFreeTierTeam(), team.ensureFreeTierTeam()])).resolves.toEqual([team.FREE_TIER_TEAM_ID, team.FREE_TIER_TEAM_ID])
  })

  it('a changed ceiling is applied to the existing team (idempotent ensure)', async () => {
    process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = '321'
    await team.ensureFreeTierTeam()
    await team.ensureFreeTierTeam()
    expect((await teamInfo()).max_budget).toBe(321)
    process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = '500'
    team.resetFreeTierTeamMemo()
    await team.ensureFreeTierTeam()
    expect((await teamInfo()).max_budget).toBe(500)
  })
})

describe('free-tier pool: key membership', () => {
  it('a new free-tier key joins the pool with the $0.50 allowance', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'free')
    const info = await keyInfo(token)
    expect(info.team_id).toBe(team.FREE_TIER_TEAM_ID)
    expect(info.max_budget).toBe(0.5)
    expect(info.budget_duration).toBe('30d')
  })

  it('a paid-plan key does not', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'pro')
    expect((await keyInfo(token)).team_id ?? null).toBeNull()
  })

  it('without a ceiling (self-host default) keys get no team', async () => {
    process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = ''
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'free')
    expect((await keyInfo(token)).team_id ?? null).toBeNull()
  })
})

describe('free-tier pool: migrating existing keys', () => {
  it('moves legacy keys into the pool with the current allowance, idempotently', async () => {
    const a = await createUser()
    const b = await createUser()
    const tokenA = await legacyKey(a.id)
    const tokenB = await legacyKey(b.id)

    const first = await reconcileUserKeys()
    expect(first).toMatchObject({ checked: 2, updated: 2, missing: 0, failed: 0 })
    for (const token of [tokenA, tokenB]) {
      const info = await keyInfo(token)
      expect(info.team_id).toBe(team.FREE_TIER_TEAM_ID)
      expect(info.max_budget).toBe(0.5)
      expect(info.budget_duration).toBe('30d')
    }

    const second = await reconcileUserKeys()
    expect(second).toMatchObject({ checked: 2, updated: 0, failed: 0 })
  })

  it('a lowered per-user allowance reaches keys already in the pool', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'free')
    process.env.TIER_FREE_LITELLM_BUDGET_USD = '0.25'
    try {
      expect((await reconcileUserKeys()).updated).toBe(1)
      const info = await keyInfo(token)
      expect(info.max_budget).toBe(0.25)
      expect(info.team_id).toBe(team.FREE_TIER_TEAM_ID)
    } finally {
      process.env.TIER_FREE_LITELLM_BUDGET_USD = '0.5'
    }
  })

  it('a plan change moves the key out of the pool and back in (Stripe webhook path)', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'free')
    await updateUserKeyBudget(u.id, 'pro')
    expect((await keyInfo(token)).team_id ?? null).toBeNull()
    await updateUserKeyBudget(u.id, 'free')
    const info = await keyInfo(token)
    expect(info.team_id).toBe(team.FREE_TIER_TEAM_ID)
    expect(info.max_budget).toBe(0.5)
  })

  it('takes keys back out when the ceiling is removed', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'free')
    process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = '0'
    const summary = await reconcileUserKeys()
    expect(summary.updated).toBe(1)
    expect((await keyInfo(token)).team_id ?? null).toBeNull()
  })
})

/**
 * Use the pool up for real: spend on a pool key, then lower the ceiling
 * below what the team has spent. LiteLLM refuses only once spend is
 * STRICTLY above `max_budget` (a 0 / 0 team still passes, verified), so
 * the team needs real spend. The dictation billing tick
 * (`voxtral-realtime-tick`, $0.006, no upstream) provides it without a
 * provider key: and is itself a platform-paid call the pool must cover.
 */
async function exhaustPool(token: string): Promise<void> {
  const before = Number((await teamInfo()).spend ?? 0)
  await useLitellmForUser(token).chat.completions.create({ model: 'voxtral-realtime-tick', messages: [{ role: 'user', content: 'tick' }] })
  const spent = await waitFor(async () => {
    const s = Number((await teamInfo()).spend ?? 0)
    return s > before ? s : null
  }, 45_000, 'the tick to reach the team spend')
  await setTeamBudget(spent / 2)
}

describe('free-tier pool: exhaustion', () => {
  it('rejects platform-paid calls with the team error, mapped to 402 ai/free-allowance-exhausted', async () => {
    const u = await createUser()
    await createUserKey(u.id, 'free')
    const token = await getUserKeyToken(u.id, 'free')
    await exhaustPool(token)

    let caught: unknown = null
    try {
      await useLitellmForUser(token).chat.completions.create({
        model: 'zai-glm-5-3-flash',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5
      })
    } catch (e) {
      caught = e
    }
    expect(caught).not.toBeNull()
    expect(team.isFreeAllowanceExhaustedError(caught)).toBe(true)

    const httpError = freeAllowanceExhaustedHttpError()
    expect(httpError.statusCode).toBe(402)
    expect(httpError.data).toMatchObject({
      code: 'ai/free-allowance-exhausted',
      messageKey: 'ai.freeAllowanceExhausted',
      recovery: { kind: 'link', href: '/settings/ai', labelKey: 'ai.freeAllowanceCta' }
    })

    // The up-front check the prompt endpoints run refuses the same way…
    const platformChat: ResolvedAiProvider = { capability: 'chat', source: 'instance', model: 'zai-glm-5-3-flash', credentials: null, supportsVision: true }
    team.resetFreeTierTeamMemo()
    await expect(assertFreeAllowanceAvailable(platformChat, 'free')).rejects.toMatchObject({ statusCode: 402 })
    // …but never refuses a user on their own key.
    const ownKey: ResolvedAiProvider = { ...platformChat, source: 'user', model: 'fake-chat', credentials: { baseUrl: fakeOpenAiBaseUrl(), apiKey: 'sk-own' } }
    await expect(assertFreeAllowanceAvailable(ownKey, 'free')).resolves.toBeUndefined()
  }, 90_000)

  it('zero-cost BYOK calls on a key in an exhausted pool still go through', async () => {
    const u = await createUser()
    await createUserKey(u.id, 'free')
    const token = await getUserKeyToken(u.id, 'free')
    await exhaustPool(token)
    const spendBefore = await waitFor(async () => {
      const s = Number((await keyInfo(token)).spend ?? 0)
      return s > 0 ? s : null
    }, 45_000, 'the tick to reach the key spend')
    const resp = await useLitellmForUser(token).chat.completions.create({
      model: 'byok/fake-chat',
      messages: [{ role: 'user', content: 'hi' }],
      // LiteLLM clientside credentials (the app's providerRequestFields shape).
      ...{ api_key: 'sk-byok-free-allowance', api_base: fakeOpenAiBaseUrl() }
    })
    expect(resp.choices[0]?.message).toBeDefined()
    // BYOK is zero-cost: the user's allowance is untouched.
    await new Promise(r => setTimeout(r, 12_000))
    expect(Number((await keyInfo(token)).spend ?? 0)).toBe(spendBefore)
  }, 120_000)
})

describe.skipIf(process.env.FREE_ALLOWANCE_LIVE !== '1')('free-tier pool: live GLM-5.3 Flash call (opt-in)', () => {
  it('a free user\'s call succeeds and debits both the key and the team, at the cached-aware price', async () => {
    await setTeamBudget(500)
    const u = await createUser()
    await createUserKey(u.id, 'free')
    const token = await getUserKeyToken(u.id, 'free')
    const teamBefore = Number((await teamInfo()).spend ?? 0)

    const resp = await useLitellmForUser(token).chat.completions.create({
      model: 'zai-glm-5-3-flash',
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_tokens: 200
    })
    expect(resp.model).toContain('glm')
    const usage = resp.usage
    expect(usage?.prompt_tokens).toBeGreaterThan(0)
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
    const expected = ((usage?.prompt_tokens ?? 0) - cached) * 0.165e-6 + cached * 0.033e-6 + (usage?.completion_tokens ?? 0) * 0.55e-6

    const keySpend = await waitFor(async () => {
      const s = Number((await keyInfo(token)).spend ?? 0)
      return s > 0 ? s : null
    }, 30_000, 'key spend to be recorded')
    expect(keySpend).toBeCloseTo(expected, 9)
    const teamAfter = await waitFor(async () => {
      const s = Number((await teamInfo()).spend ?? 0)
      return s > teamBefore ? s : null
    }, 30_000, 'team spend to be recorded')
    expect(teamAfter - teamBefore).toBeCloseTo(expected, 9)
  }, 90_000)
})
