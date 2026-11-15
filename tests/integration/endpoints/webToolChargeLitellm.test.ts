import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createError } from 'h3'
import { resetDb } from '../setup/db'
import { createUser } from '../setup/fixtures'
import { applyTestEnv } from '../setup/testEnv'
import { LITELLM_MASTER_KEY, LITELLM_URL, waitFor } from '../setup/byok'

// Web search / page fetch are charged to the caller's AI budget through the
// billing-only tick models `web-search-tick` / `web-fetch-tick`
// (deploy/config/litellm/config.yaml, custom_handlers.py
// `WebToolTickProvider`), against the REAL `litellm-test` proxy. Runs
// `chargeWebToolCall` in-process:
//
//   - each tick debits the key the configured per-call price;
//   - a used-up key is refused with 402 `ai/budget-exhausted`;
//   - a used-up free-tier pool with 402 `ai/free-allowance-exhausted`;
//   - a proxy without the tick model lets the call go ahead.
//
// No upstream provider is involved: the ticks make no outbound request.

// The integration project runs files in ONE worker without isolation:
// snapshot what this file changes and put it back in afterAll.
const envBefore = { ...process.env }
const globalsBefore = { createError: Reflect.get(globalThis, 'createError') }

applyTestEnv()
process.env.LITELLM_TEST_STUB = ''
process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = '500'
process.env.TIER_FREE_LITELLM_BUDGET_USD = '0.5'
process.env.NUXT_LITELLM_URL = LITELLM_URL
process.env.NUXT_LITELLM_MASTER_KEY = LITELLM_MASTER_KEY
process.env.NUXT_LITELLM_WEB_SEARCH_TICK_MODEL = 'web-search-tick'
process.env.NUXT_LITELLM_WEB_FETCH_TICK_MODEL = 'web-fetch-tick'
Object.assign(globalThis, { createError })

const { createUserKey, getUserKeyToken } = await import('../../../server/utils/litellm/userKeys')
const team = await import('../../../server/utils/litellm/freeTierTeam')
const { chargeWebToolCall } = await import('../../../server/utils/ai/webToolCharge')

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

async function keySpend(token: string): Promise<number> {
  const { status, json } = await admin(`/key/info?key=${encodeURIComponent(token)}`)
  expect(status).toBe(200)
  const info = json.info as Record<string, unknown> | undefined
  return Number(info?.spend ?? 0)
}

async function teamSpend(): Promise<number> {
  const { json } = await admin(`/team/info?team_id=${team.FREE_TIER_TEAM_ID}`)
  const info = json.team_info as Record<string, unknown> | undefined
  return Number(info?.spend ?? 0)
}

async function setTeamBudget(maxBudget: number): Promise<void> {
  expect((await admin('/team/update', { team_id: team.FREE_TIER_TEAM_ID, max_budget: maxBudget })).status).toBe(200)
  team.resetFreeTierTeamMemo()
}

/** Wait until the key's spend passed `above` (spend is written asynchronously). */
async function spendAbove(token: string, above: number): Promise<number> {
  return waitFor(async () => {
    const s = await keySpend(token)
    return s > above + 1e-9 ? s : null
  }, 45_000, 'the tick to reach the key spend')
}

beforeEach(async () => {
  await resetDb()
  process.env.NUXT_FREE_TIER_TOTAL_BUDGET_USD = '500'
  team.resetFreeTierTeamMemo()
  await team.ensureFreeTierTeam()
  await setTeamBudget(500)
})

afterAll(async () => {
  await setTeamBudget(500)
  for (const k of Object.keys(process.env)) {
    if (!(k in envBefore)) Reflect.deleteProperty(process.env, k)
  }
  Object.assign(process.env, envBefore)
  Object.assign(globalThis, globalsBefore)
})

describe('web-tool charges against the real proxy', () => {
  it('a search costs $0.005 and a page fetch $0.001 on the caller key', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'pro')

    await chargeWebToolCall('web_search', { virtualKey: token, userId: u.id, attributedTo: `user:${u.id}` })
    const afterSearch = await spendAbove(token, 0)
    expect(afterSearch).toBeCloseTo(0.005, 6)

    await chargeWebToolCall('fetch_url', { virtualKey: token, userId: u.id, attributedTo: `user:${u.id}` })
    const afterFetch = await spendAbove(token, afterSearch)
    expect(afterFetch - afterSearch).toBeCloseTo(0.001, 6)
  }, 120_000)

  it('a key over its budget is refused with 402 ai/budget-exhausted', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'pro')
    await chargeWebToolCall('web_search', { virtualKey: token, userId: u.id })
    const spent = await spendAbove(token, 0)
    expect((await admin('/key/update', { key: token, max_budget: spent / 2 })).status).toBe(200)

    await expect(chargeWebToolCall('web_search', { virtualKey: token, userId: u.id, attributedTo: `user:${u.id}` }))
      .rejects.toMatchObject({ statusCode: 402, data: { code: 'ai/budget-exhausted' } })
  }, 120_000)

  it('a free user draws on the shared pool and is refused once it is used up', async () => {
    const u = await createUser()
    await createUserKey(u.id, 'free')
    const token = await getUserKeyToken(u.id, 'free')
    const before = await teamSpend()

    await chargeWebToolCall('web_search', { virtualKey: token, userId: u.id })
    const spent = await waitFor(async () => {
      const s = await teamSpend()
      return s > before ? s : null
    }, 45_000, 'the tick to reach the team spend')
    await setTeamBudget(spent / 2)

    await expect(chargeWebToolCall('fetch_url', { virtualKey: token, userId: u.id, attributedTo: `user:${u.id}` }))
      .rejects.toMatchObject({ statusCode: 402, data: { code: 'ai/free-allowance-exhausted' } })
  }, 120_000)

  it('a proxy without the tick model lets the call go ahead', async () => {
    const u = await createUser()
    const { token } = await createUserKey(u.id, 'pro')
    process.env.NUXT_LITELLM_WEB_SEARCH_TICK_MODEL = 'no-such-web-search-tick'
    try {
      await expect(chargeWebToolCall('web_search', { virtualKey: token, userId: u.id })).resolves.toBeUndefined()
    } finally {
      process.env.NUXT_LITELLM_WEB_SEARCH_TICK_MODEL = 'web-search-tick'
    }
  }, 60_000)
})
