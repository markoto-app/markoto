import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'

// Schema contract tests. These verify DB-level guarantees TypeScript
// can't check at compile time: column defaults, FK cascade behaviour,
// composite PK semantics, and the atomic-increment pattern the
// charger relies on.
//
// We deliberately do NOT test "plan accepts only free|pro|max|ultra" —
// drizzle's text-enum is TypeScript-only and the DB column is plain
// `text`. App-layer enforcement (Stripe webhook is the only writer)
// guards against bad values; the documented-gap test below pins that
// expectation.

describe('users.plan — default behaviour', () => {
  beforeEach(async () => { await resetDb() })

  it('new users default to plan="free"', async () => {
    // Every new OAuth signup inherits Free. The Stripe webhook is
    // the only other writer to this column.
    const user = await createUser()
    const db = testDb()
    const r = await db.query<{ plan: string, plan_valid_until: Date | null }>(
      'SELECT plan, plan_valid_until FROM users WHERE id = $1',
      [user.id]
    )
    expect(r.rows[0].plan).toBe('free')
    expect(r.rows[0].plan_valid_until).toBeNull()
  })

  it('plan_valid_until is NULL on a fresh user', async () => {
    // A free user has no expiry. The plan-lapse sweep's partial index
    // is specifically `WHERE plan_valid_until IS NOT NULL` so these
    // rows never show up in the scan — verifying the default prevents
    // a silent "every free user appears in the sweep" perf bug.
    const user = await createUser()
    const db = testDb()
    const r = await db.query<{ v: Date | null }>(
      'SELECT plan_valid_until AS v FROM users WHERE id = $1',
      [user.id]
    )
    expect(r.rows[0].v).toBeNull()
  })

  it('multiple users can have NULL stripe_customer_id simultaneously', async () => {
    // Postgres allows multiple NULLs in a UNIQUE column. If we ever
    // accidentally wrote the constraint as NOT NULL UNIQUE, every new
    // free-tier signup would fail with a unique-violation on the
    // second user. Pin it.
    const u1 = await createUser()
    const u2 = await createUser()
    const u3 = await createUser()
    const db = testDb()
    const r = await db.query<{ c: string }>(
      'SELECT COUNT(*) AS c FROM users WHERE stripe_customer_id IS NULL AND id IN ($1, $2, $3)',
      [u1.id, u2.id, u3.id]
    )
    expect(Number(r.rows[0].c)).toBe(3)
  })

  it('stripe_customer_id uniqueness is enforced among non-NULL values', async () => {
    const u1 = await createUser()
    const u2 = await createUser()
    const db = testDb()
    await db.query(`UPDATE users SET stripe_customer_id = 'cus_shared' WHERE id = $1`, [u1.id])
    await expect(
      db.query(`UPDATE users SET stripe_customer_id = 'cus_shared' WHERE id = $1`, [u2.id])
    ).rejects.toThrow(/unique/i)
  })

  it('DOCUMENTED GAP: DB accepts arbitrary plan strings — app layer must defend', async () => {
    // Drizzle's `text('plan', { enum: [...] })` is a TypeScript-only
    // narrowing; the generated DDL is plain `text`. Nothing stops a
    // raw SQL write from setting plan='enterprise' or anything else.
    //
    // This test documents the gap rather than asserting correctness —
    // we EXPECT the insert to succeed today. The Stripe webhook
    // (only the Stripe webhook writes `plan`) defends at the app
    // layer. If we later add a DB CHECK constraint, flip this test to
    // assert rejection.
    const user = await createUser()
    const db = testDb()
    await expect(
      db.query(`UPDATE users SET plan = 'enterprise' WHERE id = $1`, [user.id])
    ).resolves.toBeDefined()
    // Cleanup so the next test's createUser doesn't see a phantom plan.
    await db.query(`UPDATE users SET plan = 'free' WHERE id = $1`, [user.id])
  })
})

describe('workspaces — billing columns', () => {
  beforeEach(async () => { await resetDb() })

  it('new workspaces default to ai_enabled=false and billing_owner_id=NULL', async () => {
    // Safety default: `(+)` is opt-in. If this ever flipped to true
    // by mistake, every new workspace would try to bill its admin for
    // member activity without the admin ever asking.
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const db = testDb()
    const r = await db.query<{ ai_enabled: boolean, billing_owner_id: number | null }>(
      'SELECT ai_enabled, billing_owner_id FROM workspaces WHERE workspace_id = $1',
      [ws.workspaceId]
    )
    expect(r.rows[0].ai_enabled).toBe(false)
    expect(r.rows[0].billing_owner_id).toBeNull()
  })

  it('billing_owner_id FK uses SET NULL on delete, not CASCADE', async () => {
    // CRITICAL: if we ever flip this to CASCADE, deleting the billing
    // owner's account would delete every `(+)` workspace they paid
    // for — nuking the whole team's docs with it. SET NULL lets the
    // workspace gracefully revert to "no (+)" while keeping docs.
    const owner = await createUser()
    const billingOwner = await createUser()
    const ws = await createWorkspace(owner.id)
    const db = testDb()

    // Set billing owner + enable (+).
    await db.query(
      'UPDATE workspaces SET billing_owner_id = $1, ai_enabled = true WHERE workspace_id = $2',
      [billingOwner.id, ws.workspaceId]
    )

    // Delete the billing-owner user (not the workspace creator).
    await db.query('DELETE FROM users WHERE id = $1', [billingOwner.id])

    // Workspace must survive with billing_owner_id nulled. ai_enabled
    // stays true in the DB — the plan-lapse sweep flips it back to
    // false; the FK only handles the null, not the boolean.
    const r = await db.query<{ billing_owner_id: number | null, ai_enabled: boolean }>(
      'SELECT billing_owner_id, ai_enabled FROM workspaces WHERE workspace_id = $1',
      [ws.workspaceId]
    )
    expect(r.rows).toHaveLength(1) // workspace not deleted
    expect(r.rows[0].billing_owner_id).toBeNull()
    expect(r.rows[0].ai_enabled).toBe(true) // plan-lapse sweep's job
  })
})

describe('ai_usage_period — composite PK + atomic increment', () => {
  beforeEach(async () => { await resetDb() })

  it('allows same attributed_to across different periods', async () => {
    // A user's April row and May row must coexist — months don't
    // merge. If the PK were on attributed_to alone, the second INSERT
    // would conflict and we'd overwrite April with May's counter.
    const db = testDb()
    await db.query(`
      INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
      VALUES ('user:1', '2026-04-01', 50)
    `)
    await db.query(`
      INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
      VALUES ('user:1', '2026-05-01', 10)
    `)
    const r = await db.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ai_usage_period WHERE attributed_to = 'user:1'`
    )
    expect(Number(r.rows[0].c)).toBe(2)
  })

  it('rejects duplicate (attributed_to, period_start)', async () => {
    const db = testDb()
    await db.query(`
      INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
      VALUES ('user:1', '2026-04-01', 50)
    `)
    await expect(
      db.query(`
        INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
        VALUES ('user:1', '2026-04-01', 0)
      `)
    ).rejects.toThrow(/duplicate|unique/i)
  })

  it('INSERT ... ON CONFLICT DO UPDATE increments atomically (charge pattern)', async () => {
    // Exact pattern `chargeInteractions` uses: one INSERT that
    // either creates the period row at N or bumps the existing
    // counter by N. Verified here against the schema so a bad PK
    // shape would surface at test time, not charge time.
    // wrong for this write pattern.
    const db = testDb()
    const stmt = `
      INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
      VALUES ('user:1', '2026-04-01', $1)
      ON CONFLICT (attributed_to, period_start)
      DO UPDATE SET interactions_used = ai_usage_period.interactions_used + EXCLUDED.interactions_used,
                    updated_at = now()
      RETURNING interactions_used
    `
    const r1 = await db.query<{ interactions_used: number }>(stmt, [3])
    expect(r1.rows[0].interactions_used).toBe(3)
    const r2 = await db.query<{ interactions_used: number }>(stmt, [2])
    expect(r2.rows[0].interactions_used).toBe(5)
    const r3 = await db.query<{ interactions_used: number }>(stmt, [10])
    expect(r3.rows[0].interactions_used).toBe(15)
  })

  it('different attribution keys do not collide — user vs workspace', async () => {
    // `user:1` and `workspace:1` must live in separate rows even
    // though they share a numeric suffix. The `attributed_to` column
    // being a full string (not two numeric FK columns) prevents this
    // class of bug entirely, but pin the property so a future "split
    // into two columns" refactor doesn't break attribution.
    const db = testDb()
    await db.query(`
      INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
      VALUES ('user:1', '2026-04-01', 5)
    `)
    await db.query(`
      INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
      VALUES ('workspace:1', '2026-04-01', 7)
    `)
    const r = await db.query<{ attributed_to: string, interactions_used: number }>(
      `SELECT attributed_to, interactions_used FROM ai_usage_period ORDER BY attributed_to`
    )
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0].attributed_to).toBe('user:1')
    expect(r.rows[0].interactions_used).toBe(5)
    expect(r.rows[1].attributed_to).toBe('workspace:1')
    expect(r.rows[1].interactions_used).toBe(7)
  })
})

describe('schema — perf invariants for plan-lapse sweep', () => {
  it('users.plan_valid_until has a PARTIAL index (not full)', async () => {
    // The plan-lapse sweep runs `WHERE plan_valid_until < now()
    // AND plan != 'free'`. A full index on plan_valid_until would
    // bloat with every free-tier signup (all NULL). The partial
    // index keeps the scan tight as the user table grows. Verified by
    // reading pg_indexes for the `WHERE` clause on the index.
    const db = testDb()
    const r = await db.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'users'
        AND indexname = 'idx_users_plan_valid_until'
    `)
    expect(r.rows).toHaveLength(1)
    // `indexdef` looks like: "CREATE INDEX ... ON users USING btree
    // (plan_valid_until) WHERE (plan_valid_until IS NOT NULL)"
    expect(r.rows[0].indexdef.toLowerCase()).toMatch(/where .*plan_valid_until.* is not null/)
  })

  it('workspaces.billing_owner_id is indexed', async () => {
    // Billing resolver will query by workspaceId (already indexed via
    // unique constraint) but the plan-lapse sweep runs by billingOwnerId
    // — "find all (+) workspaces whose billing owner lapsed". Without
    // an index, that's a full-table scan. Pin the index exists.
    const db = testDb()
    const r = await db.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'workspaces'
        AND indexname = 'idx_workspaces_billing_owner'
    `)
    expect(r.rows).toHaveLength(1)
  })
})
