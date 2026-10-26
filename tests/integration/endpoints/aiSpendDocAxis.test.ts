import { describe, it, expect, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { ALL_FEATURE_TAGS } from '../../../server/utils/litellm/featureTags'

// Pin the doc-axis spend tag END-TO-END.
//
// Unit tests in `featureTags.test.ts` already pin the helper.
// Integration tests in `aiAxisSpend.test.ts` already pin the
// `/api/admin/axis-spend` endpoint shape with empty data.
//
// The gap: NOTHING pins that a real spend-log row carrying our
// `doc:`/`workspace:`/`user:` tag actually flows through the proxy
// and surfaces in the dashboard breakdown. A regression where a
// call-site forgets `featureMetadata({ ..., docId })` or LiteLLM
// silently drops unknown metadata keys would NOT be caught.
//
// Approach (tags live in LiteLLM's `request_tags` column, verified live
// against v1.106.4; `metadata->'tags'` is empty): seed `LiteLLM_SpendLogs` directly with a known
// (feature, workspace, user, doc) combination, then query
// /api/admin/axis-spend?axis=doc&value=X and assert the seeded
// spend lands in the response.

const LITELLM_DB_URL = process.env.NUXT_LITELLM_DB_URL
  ?? `postgres://ypad:testpassword@localhost:5433/litellm_test`

async function promoteToAdmin(userId: number): Promise<void> {
  await testDb().query('UPDATE users SET is_admin = true WHERE id = $1', [userId])
}

async function seedSpendLog(opts: {
  spend: number
  tags: string[]
  startTime: Date
}): Promise<string> {
  const requestId = `test-${Math.random().toString(36).slice(2)}`
  const pool = new Pool({ connectionString: LITELLM_DB_URL, max: 1 })
  try {
    await pool.query(
      `INSERT INTO "LiteLLM_SpendLogs"
        (request_id, call_type, api_key, spend, total_tokens, prompt_tokens, completion_tokens,
         "startTime", "endTime", model, request_tags)
       VALUES ($1, 'completion', '', $2, 100, 50, 50, $3, $3, 'mistral-small-2603', $4::jsonb)`,
      [
        requestId,
        opts.spend,
        opts.startTime.toISOString(),
        JSON.stringify(opts.tags)
      ]
    )
  } finally {
    await pool.end()
  }
  return requestId
}

async function clearSeededSpendLogs(): Promise<void> {
  const pool = new Pool({ connectionString: LITELLM_DB_URL, max: 1 })
  try {
    await pool.query(`DELETE FROM "LiteLLM_SpendLogs" WHERE request_id LIKE 'test-%'`)
  } finally {
    await pool.end()
  }
}

describe('Multi-axis spend tagging — end-to-end', () => {
  beforeEach(async () => {
    await resetDb()
    await clearSeededSpendLogs()
  })

  it('seeded spend tagged with feature + workspace + user + doc surfaces in axis-spend?axis=doc', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)

    // Seed a spend row carrying every axis dimension. Use today's
    // date so it falls within the default 30-day window.
    const today = new Date()
    await seedSpendLog({
      spend: 0.0123,
      tags: [
        'feature:text-loop',
        'workspace:ws-axis-test-abc',
        `user:${u.id}`,
        'doc:doc-axis-test-xyz'
      ],
      startTime: today
    })

    const client = await loggedInClient(u.id)
    const res = await client.get('/api/admin/axis-spend?axis=doc&value=doc-axis-test-xyz')
    expect(res.status).toBe(200)

    const body = await res.json() as {
      axis: string
      value: string
      totalSpendUsd: number
      breakdown: Array<{ tag: string, spendUsd: number }>
    }
    expect(body.axis).toBe('doc')
    expect(body.value).toBe('doc-axis-test-xyz')

    // The seeded $0.0123 should match: doc:doc-axis-test-xyz total
    // and the feature:text-loop row should reflect it.
    expect(body.totalSpendUsd).toBeCloseTo(0.0123, 4)
    const textLoopRow = body.breakdown.find(r => r.tag === 'feature:text-loop')
    expect(textLoopRow).toBeDefined()
    expect(textLoopRow!.spendUsd).toBeCloseTo(0.0123, 4)
  })

  it('different docs do NOT cross-contaminate when filtered by axis=doc', async () => {
    const u = await createUser()
    await promoteToAdmin(u.id)

    const today = new Date()
    await seedSpendLog({
      spend: 0.05,
      tags: ['feature:image-gen', 'doc:doc-A'],
      startTime: today
    })
    await seedSpendLog({
      spend: 0.07,
      tags: ['feature:image-gen', 'doc:doc-B'],
      startTime: today
    })

    const client = await loggedInClient(u.id)
    const docA = await client.get('/api/admin/axis-spend?axis=doc&value=doc-A')
    const bodyA = await docA.json() as { totalSpendUsd: number }
    expect(bodyA.totalSpendUsd).toBeCloseTo(0.05, 4)

    const docB = await client.get('/api/admin/axis-spend?axis=doc&value=doc-B')
    const bodyB = await docB.json() as { totalSpendUsd: number }
    expect(bodyB.totalSpendUsd).toBeCloseTo(0.07, 4)
  })

  it('canonical feature tags all show up as zero-rows even when only doc tag has data', async () => {
    // Sanity: a fresh `axis=doc` query for a doc with only one
    // feature still returns rows for every canonical feature tag
    // (zero-spend). This is what the dashboard renders.
    const u = await createUser()
    await promoteToAdmin(u.id)

    await seedSpendLog({
      spend: 0.001,
      tags: ['feature:transcribe', 'doc:doc-only-transcribe'],
      startTime: new Date()
    })

    const client = await loggedInClient(u.id)
    const res = await client.get('/api/admin/axis-spend?axis=doc&value=doc-only-transcribe')
    const body = await res.json() as {
      breakdown: Array<{ tag: string, spendUsd: number }>
    }

    const tags = body.breakdown.map(r => r.tag)
    for (const expected of ALL_FEATURE_TAGS) {
      expect(tags).toContain(expected)
    }
    const transcribeRow = body.breakdown.find(r => r.tag === 'feature:transcribe')!
    expect(transcribeRow.spendUsd).toBeCloseTo(0.001, 4)
    const imageRow = body.breakdown.find(r => r.tag === 'feature:image-gen')!
    expect(imageRow.spendUsd).toBe(0)
  })
})
