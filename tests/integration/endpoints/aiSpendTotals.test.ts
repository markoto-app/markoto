import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Pool } from 'pg'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// Every LiteLLM call carries several tags: one `feature:*`, the `user:`,
// `doc:` and `workspace:` axes, and two `User-Agent: ...` tags LiteLLM adds
// itself. Summing per tag (LiteLLM's /spend/tags) counted one call once per
// tag and put the axis + User-Agent tags into "other". The dashboard totals
// must equal the spend-log rows of the window.

const LITELLM_DB_URL = process.env.NUXT_LITELLM_DB_URL
  ?? `postgres://ypad:testpassword@localhost:5433/litellm_test`

const pool = new Pool({ connectionString: LITELLM_DB_URL, max: 1 })

// A single day 60 days back (inside the 90-day spend-log retention): the
// suite's other AI calls log real rows today, which would skew exact totals.
const SEED_TIME = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
const SEED_DAY = SEED_TIME.toISOString().slice(0, 10)
const WINDOW = `from=${SEED_DAY}&to=${SEED_DAY}`

async function seedSpendLog(spend: number, tags: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO "LiteLLM_SpendLogs"
      (request_id, call_type, api_key, spend, total_tokens, prompt_tokens, completion_tokens,
       "startTime", "endTime", model, request_tags)
     VALUES ($1, 'completion', '', $2, 100, 50, 50, $3, $3, 'mistral-small-2603', $4::jsonb)`,
    [`test-${Math.random().toString(36).slice(2)}`, spend, SEED_TIME.toISOString(), JSON.stringify(tags)]
  )
}

function callTags(feature: string, userId: number): string[] {
  return [
    feature,
    `user:${userId}`,
    'doc:doc-totals',
    'workspace:ws-totals',
    'User-Agent: OpenAI/JS 7.43.0',
    'User-Agent: OpenAI/JS'
  ]
}

interface SpendBody {
  totalSpendUsd: number
  totalRequests: number
  breakdown: Array<{ tag: string, spendUsd: number, requests: number, sharePct: number }>
}

describe('admin AI spend totals count every call once', () => {
  beforeEach(async () => {
    await resetDb()
    await pool.query(`DELETE FROM "LiteLLM_SpendLogs" WHERE request_id LIKE 'test-%'`)
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM "LiteLLM_SpendLogs" WHERE request_id LIKE 'test-%'`)
    await pool.end()
  })

  it('ai-spend: totals equal the rows; no "other" when every row has a feature tag', async () => {
    const u = await createUser()
    await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [u.id])
    await seedSpendLog(0.01, callTags('feature:text-loop', u.id))
    await seedSpendLog(0.01, callTags('feature:text-loop', u.id))
    await seedSpendLog(0.005, callTags('feature:embeddings', u.id))

    const res = await (await loggedInClient(u.id)).get(`/api/admin/ai-spend?${WINDOW}`)
    expect(res.status).toBe(200)
    const body = await res.json() as SpendBody
    expect(body.totalSpendUsd).toBeCloseTo(0.025, 4)
    expect(body.totalRequests).toBe(3)
    expect(body.breakdown.find(r => r.tag === 'feature:text-loop')).toMatchObject({ requests: 2, sharePct: 80 })
    expect(body.breakdown.find(r => r.tag === 'feature:embeddings')).toMatchObject({ requests: 1, sharePct: 20 })
    expect(body.breakdown.some(r => r.tag === 'other')).toBe(false)
  })

  it('ai-spend: a row without a feature tag is "other", once', async () => {
    const u = await createUser()
    await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [u.id])
    await seedSpendLog(0.01, callTags('feature:image-gen', u.id))
    await seedSpendLog(0.01, ['user:1', 'User-Agent: OpenAI/JS'])

    const res = await (await loggedInClient(u.id)).get(`/api/admin/ai-spend?${WINDOW}`)
    const body = await res.json() as SpendBody
    expect(body.totalSpendUsd).toBeCloseTo(0.02, 4)
    expect(body.totalRequests).toBe(2)
    expect(body.breakdown.find(r => r.tag === 'other')).toMatchObject({ requests: 1, sharePct: 50 })
  })

  it('axis-spend: the per-workspace totals count each call once', async () => {
    const u = await createUser()
    await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [u.id])
    await seedSpendLog(0.01, callTags('feature:text-loop', u.id))
    await seedSpendLog(0.002, callTags('feature:web-search', u.id))
    await seedSpendLog(0.5, ['feature:text-loop', 'workspace:ws-elsewhere'])

    const res = await (await loggedInClient(u.id)).get(`/api/admin/axis-spend?axis=workspace&value=ws-totals&${WINDOW}`)
    expect(res.status).toBe(200)
    const body = await res.json() as SpendBody
    expect(body.totalSpendUsd).toBeCloseTo(0.012, 4)
    expect(body.totalRequests).toBe(2)
    expect(body.breakdown.find(r => r.tag === 'feature:text-loop')?.requests).toBe(1)
  })
})
