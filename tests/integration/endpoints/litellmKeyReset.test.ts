import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { DEFAULT_TIERS as TIERS } from '../../../shared/config/tiers'

// `resetUserKeySpend` against the real `litellm-test` proxy. LiteLLM
// v1.106 answers a bodyless `POST /key/{key}/reset_spend` with 422; the
// helper must send `{"reset_to": 0}`. The helper swallows proxy errors
// (logs a warning), which is how the 422 went unnoticed — so the test
// endpoint surfaces its boolean result.

describe('resetUserKeySpend wire contract', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('reset_spend is accepted by the proxy and leaves max_budget intact', async () => {
    const u = await createUser()
    const res = await anonClient().post('/api/_test/reset-litellm-spend', { userId: u.id })
    expect(res.status).toBe(200)
    const body = await res.json() as { reset: boolean, spend: number, maxBudget: number }
    expect(body.reset).toBe(true)
    expect(body.spend).toBe(0)
    expect(body.maxBudget).toBe(TIERS.free.litellmBudgetUsd)
  })

  it('rejects a missing userId', async () => {
    const res = await anonClient().post('/api/_test/reset-litellm-spend', {})
    expect(res.status).toBe(400)
  })
})
