import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createError } from 'h3'
import { Pool } from 'pg'
import { resetDb, testDb } from '../setup/db'
import { createUser } from '../setup/fixtures'
import { applyTestEnv } from '../setup/testEnv'
import { TEST_LITELLM_DB_PASSWORD, TEST_LITELLM_DB_USER } from '../setup/env'
import { LITELLM_MASTER_KEY, LITELLM_URL, waitFor } from '../setup/byok'
import { sys } from '../../helpers/access'

// AI credit top-ups against the REAL `litellm-test` proxy, in
// process: a Pro user's key budget includes their credits, and the
// settlement reads the key's spend from LiteLLM's spend logs (by the
// stored key id) and takes what passed the plan budget from the credits —
// the budget itself stays put for the rest of the month.
// Spend comes from the dictation billing tick ($0.006, no upstream).

const envBefore = { ...process.env }
const globalsBefore = { createError: Reflect.get(globalThis, 'createError') }

applyTestEnv()
process.env.LITELLM_TEST_STUB = ''
process.env.NUXT_BILLING_ENABLED = 'true'
// A Pro plan budget so small that every tick is paid from credits.
process.env.TIER_PRO_LITELLM_BUDGET_USD = '0.001'
// Free below Pro, so a cancellation lowers today's plan budget.
process.env.TIER_FREE_LITELLM_BUDGET_USD = '0.0005'
process.env.NUXT_LITELLM_DB_NAME = 'litellm_test'
process.env.NUXT_LITELLM_DB_USER = TEST_LITELLM_DB_USER
process.env.NUXT_LITELLM_DB_PASSWORD = TEST_LITELLM_DB_PASSWORD
// The code under test reads the proxy from the typed env (shared/env).
process.env.NUXT_LITELLM_URL = LITELLM_URL
process.env.NUXT_LITELLM_MASTER_KEY = LITELLM_MASTER_KEY
Object.assign(globalThis, { createError })

const { createUserKey, getUserKeyToken } = await import('../../../server/utils/litellm/userKeys')
const { insertCreditGrant, sumUsableCredits } = await import('../../../server/repos/aiCreditGrants')
const { settleSubject, monthSpendUsd } = await import('../../../server/utils/billing/aiCredits')
const { creditPeriod } = await import('../../../server/utils/billing/aiCreditBudget')
const { useLitellmForUser } = await import('../../../server/utils/ai/litellmClient')
const { litellmDbUrl } = await import('../../../server/db/litellm')

async function keyInfo(token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${LITELLM_URL}/key/info?key=${encodeURIComponent(token)}`, { headers: { Authorization: `Bearer ${LITELLM_MASTER_KEY}` } })
  expect(res.status).toBe(200)
  return ((await res.json()) as { info: Record<string, unknown> }).info
}

beforeEach(async () => {
  await resetDb()
})

afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in envBefore)) Reflect.deleteProperty(process.env, k)
  }
  Object.assign(process.env, envBefore)
  Object.assign(globalThis, globalsBefore)
})

describe('credit settlement (real LiteLLM)', () => {
  it('budget = plan + credits; spend above the plan comes out of the credits, the budget holds', async () => {
    const u = await createUser()
    await testDb().query(`UPDATE users SET plan = 'pro', plan_valid_until = now() + interval '30 days' WHERE id = $1`, [u.id])
    await insertCreditGrant(sys(), {
      subject: { type: 'user', id: String(u.id) },
      pack: '10', amountUsd: 1, amountPaid: 100, currency: 'eur',
      stripePaymentIntentId: `pi_settle_${u.id}_${Date.now()}`, stripeCheckoutSessionId: null,
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000)
    })
    // resetDb restarts user ids, so LiteLLM may still hold a user record
    // with this id (and its spend) from an earlier test: start clean.
    await fetch(`${LITELLM_URL}/user/delete`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LITELLM_MASTER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_ids: [String(u.id)] })
    })
    await createUserKey(u.id, 'pro')
    const token = await getUserKeyToken(u.id, 'pro')
    expect(Number((await keyInfo(token)).max_budget)).toBeCloseTo(1.001, 6)

    // Two billing ticks = $0.012 — well above the $0.001 plan budget.
    const ai = useLitellmForUser(token)
    for (let i = 0; i < 2; i++) await ai.chat.completions.create({ model: 'voxtral-realtime-tick', messages: [{ role: 'user', content: 'tick' }] })

    // The spend logs carry the stored key id (LiteLLM writes them in batches).
    const subject = { type: 'user' as const, id: String(u.id) }
    const spend = await waitFor(async () => {
      const s = await monthSpendUsd(subject, creditPeriod())
      return s >= 0.012 - 1e-9 ? s : null
    }, 90_000, 'the ticks to reach the spend logs')

    await settleSubject(subject)
    expect(await sumUsableCredits(subject)).toBeCloseTo(1 - (spend - 0.001), 6)
    // Plan + credits left + credits used this month: unchanged.
    expect(Number((await keyInfo(token)).max_budget)).toBeCloseTo(1.001, 6)

    // A second run settles nothing more.
    await settleSubject(subject)
    expect(await sumUsableCredits(subject)).toBeCloseTo(1 - (spend - 0.001), 6)

    // The plan is cancelled mid-month: the spend Pro already covered is
    // still measured against the Pro budget recorded for this month, not
    // today's (lower) Free budget — no further credits are taken.
    await testDb().query(`UPDATE users SET plan = 'free', plan_valid_until = NULL WHERE id = $1`, [u.id])
    await settleSubject(subject)
    expect(await sumUsableCredits(subject)).toBeCloseTo(1 - (spend - 0.001), 6)
  }, 150_000)

  it('the spend query reads the right database', async () => {
    const pool = new Pool({ connectionString: litellmDbUrl(), max: 1 })
    try {
      const r = await pool.query('SELECT 1 FROM "LiteLLM_SpendLogs" LIMIT 1')
      expect(r).toBeTruthy()
    } finally {
      await pool.end()
    }
  })
})
