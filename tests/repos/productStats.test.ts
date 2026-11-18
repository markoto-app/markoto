import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { Pool } from 'pg'
import { nanoid } from 'nanoid'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace } from '../integration/setup/fixtures'
import { adminAs, asUser, sys } from '../helpers/access'
import { stubEnv } from '../helpers/env'
import {
  activation, cancellingGroups, documentStats, editors, firstSignupDay, opsCounts, retentionCohorts,
  revenueCounts, signups, storedContentStats, subscriptionGroups, userTotals, workspaceStats, aiAppStats
} from '../../server/repos/productStats'
import { listSpendUserIds, spendByFeature } from '../../server/repos/litellmSpend'
import { anonymiseSubscriptionEventsOfUser, listSubscriptionEventsOfUser, recordSubscriptionEvent } from '../../server/repos/subscriptionEvents'
import { runAiSpendRollup } from '../../server/utils/litellm/aiSpendRollup'
import { markSessionUserActive, findSessionUser } from '../../server/repos/users'
import {
  buildAiStats, buildContentStats, buildOpsStats, buildOverviewStats, buildRevenueStats, buildUsersStats,
  mondayWeeksBack, resolveStatsWindow, spendLogFloor, sumSpendRows
} from '../../server/utils/adminStats/productStats'
import { DEFAULT_PLAN_PRICES } from '../../shared/config/pricing'
import { isoDay, recurringRevenue, statsWindow } from '../../shared/contracts/adminStats'

// Admin product stats against a seeded database: anonymous documents,
// deleted / pending-deletion accounts, monthly vs yearly plans, cancelled
// and ended subscriptions, and LiteLLM spend rows carrying several tags.

const LITELLM_DB_URL = process.env.NUXT_LITELLM_DB_URL ?? 'postgres://ypad:testpassword@localhost:5433/litellm_test'
const admin = adminAs(1)
const DAY = 86_400_000
const now = new Date()
const ago = (days: number): string => new Date(now.getTime() - days * DAY).toISOString()
const w30 = statsWindow('30', now, null)

let litellm: Pool

async function q(text: string, params: unknown[] = []): Promise<void> {
  await testDb().query(text, params)
}

async function seed(): Promise<{ u1: number, u2: number, u3: number, u4: number, ws: string }> {
  const u1 = (await createUser()).id
  const u2 = (await createUser()).id
  const u3 = (await createUser()).id
  const u4 = (await createUser()).id
  // u1: new, monthly EUR Pro, cancelled but still running; active today.
  await q(`UPDATE users SET plan = 'pro', stripe_customer_id = 'cus_1', stripe_subscription_id = 'sub_1', subscription_status = 'active',
    billing_currency = 'eur', billing_interval = 'month', plan_valid_until = $2, plan_cancel_at = $2, last_active_on = $3, created_at = $4 WHERE id = $1`,
  [u1, ago(-20), isoDay(now), ago(3)])
  // u2: signed up 40 days ago, yearly CHF Pro without a recorded interval (judged by its period length).
  await q(`UPDATE users SET plan = 'pro', google_id = 'g-2', github_id = NULL, stripe_customer_id = 'cus_2', stripe_subscription_id = 'sub_2', subscription_status = 'past_due',
    billing_currency = 'chf', stripe_current_period_start = $2, plan_valid_until = $3, last_active_on = $4, created_at = $5 WHERE id = $1`,
  [u2, ago(30), ago(-335), isoDay(new Date(now.getTime() - 10 * DAY)), ago(40)])
  // u3: today, OIDC, account deletion requested.
  await q(`UPDATE users SET oidc_issuer = 'https://idp.test', oidc_subject = 's-3', github_id = NULL, deletion_requested_at = now(), created_at = $2 WHERE id = $1`, [u3, ago(0)])
  // u4: Pro trial (not paying yet), created 5 days ago.
  await q(`UPDATE users SET plan = 'pro', stripe_customer_id = 'cus_4', stripe_subscription_id = 'sub_4', subscription_status = 'trialing',
    billing_currency = 'eur', billing_interval = 'month', plan_valid_until = $2, created_at = $3 WHERE id = $1`, [u4, ago(-7), ago(5)])

  const ws = (await createWorkspace(u1)).workspaceId
  await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor'), ($1, $3, 'guest')`, [ws, u2, u3])
  await q(`INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, currency, interval, valid_until)
    VALUES ($1, 'team', 3, 'active', 'chf', 'year', $2)`, [ws, ago(-200)])
  const ws2 = (await createWorkspace(u2)).workspaceId
  await q(`INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, currency, interval, valid_until, updated_at)
    VALUES ($1, 'business', 5, 'canceled', 'eur', 'month', $2, $2)`, [ws2, ago(2)])

  const d1 = (await createDoc({ ownerId: u1, workspaceId: ws })).docId
  const d2 = (await createDoc()).docId
  const d3 = (await createDoc({ ownerId: u2 })).docId
  await q(`UPDATE documents SET created_at = $2, word_count = 100 WHERE doc_id = $1`, [d3, ago(40)])
  await q(`UPDATE documents SET word_count = 50 WHERE doc_id = $1`, [d1])

  await q(`INSERT INTO activity_log (doc_id, user_id, action, created_at) VALUES ($1, $2, 'edit', $3), ($4, $5, 'edit', $6), ($7, NULL, 'edit', $3)`,
    [d1, u1, ago(0), d3, u2, ago(10), d2])
  await q(`INSERT INTO ai_session_messages (doc_id, user_id, session_id, kind, body) VALUES ($1, $2, 's1', 'user_prompt', '{"text":"hi"}')`, [d1, u1])
  await q(`INSERT INTO uploads (doc_id, file_id, uploader_id, content_type, size_bytes, s3_key, confirmed_at) VALUES ($1, 'f1', $2, 'image/png', 2000, $3, now()),
    ($1, 'f2', $2, 'image/png', 500, $4, NULL)`, [d1, u1, `docs/${d1}/f1.png`, `docs/${d1}/f2.png`])
  await q(`INSERT INTO workspace_knowledge (knowledge_id, workspace_id, filename, source_ext, mime_type, size_bytes, s3_key, status, chunk_count, token_count, embedding_version)
    VALUES ('k1', $1, 'a.pdf', 'pdf', 'application/pdf', 10000, 'k/1', 'ready', 4, 400, 'v1'), ('k2', $1, 'b.pdf', 'pdf', 'application/pdf', 300, 'k/2', 'failed', 0, 0, 'v1')`, [ws])
  await q(`INSERT INTO published_pages (id, doc_id, slug, title, html, css, indexable) VALUES ('p1', $1, 'hello', 'Hello', '<p>x</p>', '', true)`, [d1])
  await q(`INSERT INTO custom_domains (id, hostname, user_id, page_id, verify_token, status) VALUES ('cd1', 'docs.example.com', $1, 'p1', 't', 'verified')`, [u1])
  await q(`INSERT INTO document_comments (doc_id, entry_id, author_id, author_name, body, created_at_ms, updated_at_ms) VALUES ($1, 'c1', $2, 'A', 'x', now(), now())`, [d1, u1])
  await q(`INSERT INTO waitlist_signups (email, locale, consent_version, consent_text_id, unsubscribe_token_hash, confirmed_at)
    VALUES ('a@x.test', 'en', 1, 't', 'h1', now()), ('b@x.test', 'en', 1, 't', 'h2', NULL)`)
  await q(`INSERT INTO ai_credit_grants (subject_type, subject_id, pack, amount_usd, remaining_usd, amount_paid, currency, stripe_payment_intent_id, expires_at)
    VALUES ('user', $1, '10', 10, 10, 1000, 'eur', 'pi_1', $2)`, [String(u1), ago(-365)])
  await q(`INSERT INTO abuse_reports (report_id, category, body, status) VALUES ('r1', 'spam', 'x', 'open'), ('r2', 'spam', 'y', 'dismissed')`)
  await q(`INSERT INTO data_export_jobs (job_id, user_id, status) VALUES ('j1', $1, 'ready')`, [u1])
  await q(`INSERT INTO user_ai_providers (user_id, capability, base_url, model, api_key_encrypted, api_key_last4)
    VALUES ($1, 'chat', 'https://api.example.com/v1', 'm', 'enc', '1234'), ($1, 'image', 'https://api.example.com/v1', 'm', 'enc', '1234')`, [u2])
  await q(`INSERT INTO mcp_personal_tokens (token_id, user_id, name, token_hash, scopes) VALUES ('t1', $1, 'cli', 'hash1', '{read}')`, [u1])
  await q(`INSERT INTO mcp_sessions (mcp_session_id, user_id, token_id) VALUES ('m1', $1, 't1')`, [u1])
  // Subscription history: u1's Pro started 3 days ago, the Business plan of ws2 ended 2 days ago, a Team plan ended 40 days ago.
  await q(`INSERT INTO subscription_events (kind, subject_type, user_id, workspace_id, plan, interval, currency, seats, stripe_subscription_id, stripe_event_id, occurred_at) VALUES
    ('started', 'user', $1, NULL, 'pro', 'month', 'eur', 1, 'sub_1', 'evt_1', $3),
    ('cancel_scheduled', 'user', $1, NULL, 'pro', 'month', 'eur', 1, 'sub_1', 'evt_2', $4),
    ('ended', 'workspace', NULL, $2, 'business', 'month', 'eur', 5, 'sub_ws2', 'evt_3', $5),
    ('ended', 'workspace', NULL, 'gone', 'team', 'year', 'chf', 2, 'sub_old', 'evt_4', $6)`,
  [u1, ws2, ago(3), ago(1), ago(2), ago(40)])
  return { u1, u2, u3, u4, ws }
}

async function seedSpend(tags: string[] | null, spend: number, startTime: string): Promise<void> {
  await litellm.query(
    `INSERT INTO "LiteLLM_SpendLogs" (request_id, call_type, api_key, spend, total_tokens, prompt_tokens, completion_tokens, "startTime", "endTime", model, request_tags)
     VALUES ($1, 'completion', '', $2, 10, 5, 5, $3, $3, 'm', $4::jsonb)`,
    [`stats-${nanoid(8)}`, spend, startTime, tags === null ? null : JSON.stringify(tags)]
  )
}

beforeAll(() => {
  litellm = new Pool({ connectionString: LITELLM_DB_URL, max: 1 })
})
afterAll(async () => {
  await litellm.end()
})

describe('product stats', () => {
  let ids: Awaited<ReturnType<typeof seed>>
  beforeEach(async () => {
    stubEnv({ NUXT_LITELLM_DB_URL: LITELLM_DB_URL })
    await resetDb()
    // The whole (test) spend log: these totals are instance-wide.
    await litellm.query(`DELETE FROM "LiteLLM_SpendLogs"`)
    ids = await seed()
  })

  it('counts accounts, sign-ins by provider and active days', async () => {
    const t = await userTotals(admin, w30)
    expect(t).toMatchObject({ registered: 4, pendingDeletion: 1, free: 1, pro: 3, github: 2, google: 1, oidc: 1, sso: 0 })
    expect(t).toMatchObject({ activeDay: 1, activeWeek: 1, activeMonth: 2, activeInWindow: 2 })
    expect(await firstSignupDay(admin)).toBe(isoDay(new Date(ago(40))))
  })

  it('compares sign-ups with the previous window and fills empty days', async () => {
    const s = await signups(admin, w30)
    expect(s.kpi).toEqual({ value: 3, previous: 1 })
    expect(s.series).toHaveLength(30)
    expect(s.series.reduce((n, p) => n + p.v, 0)).toBe(3)
  })

  it('counts signed-in editors only, never anonymous edits', async () => {
    const e = await editors(admin, w30)
    expect(e.kpi).toEqual({ value: 2, previous: 0 })
    expect(await activation(admin, w30)).toEqual({ cohort: 3, createdDoc: 1, edited: 1, usedAi: 1 })
  })

  it('builds weekly retention cohorts', async () => {
    const c = await retentionCohorts(admin, mondayWeeksBack(now, 11))
    expect(c.sizes.reduce((n, s) => n + s.size, 0)).toBe(4)
    expect(c.retained.every(r => r.offset >= 0)).toBe(true)
    const users = await buildUsersStats(admin, w30, now)
    expect(users.cohorts.length).toBeGreaterThan(0)
    expect(users.active.stickinessPct).toBe(50)
    expect(users.providers).toEqual({ github: 2, google: 1, oidc: 1, sso: 0 })
  })

  it('splits documents into owned and anonymous', async () => {
    const d = await documentStats(admin, w30)
    expect(d).toMatchObject({ total: 3, owned: 2, anonymous: 1, inWorkspaces: 1, words: 150 })
    expect(d.created).toEqual({ value: 2, previous: 1 })
    expect(d.edited).toEqual({ value: 3, previous: 0 })
  })

  it('counts workspaces by members without guests', async () => {
    const ws = await workspaceStats(admin, w30)
    expect(ws.total).toBe(2)
    expect(ws.guests).toBe(1)
    expect(ws.memberBuckets).toEqual([
      { bucket: '1', workspaces: 1 }, { bucket: '2-5', workspaces: 1 }, { bucket: '6-20', workspaces: 0 }, { bucket: '21+', workspaces: 0 }
    ])
  })

  it('sums knowledge, images, published pages and comments', async () => {
    const s = await storedContentStats(admin, w30)
    expect(s.knowledge).toMatchObject({ files: 2, ready: 1, failed: 1, bytes: 10300, chunks: 4, tokens: 400 })
    expect(s.images).toMatchObject({ files: 1, bytes: 2000 })
    expect(s.published).toEqual({ pages: 1, indexable: 1, customDomains: 1, verifiedDomains: 1 })
    expect(s.comments.total).toBe(1)
    const content = await buildContentStats(admin, w30)
    expect(content.documentSeries).toHaveLength(30)
  })

  it('values live subscriptions at list price: monthly, yearly, seats, without trials', async () => {
    const billed = await subscriptionGroups(admin, 'billed')
    expect(billed).toEqual(expect.arrayContaining([
      { plan: 'pro', currency: 'eur', interval: 'month', subscriptions: 1, units: 1 },
      { plan: 'pro', currency: 'chf', interval: 'year', subscriptions: 1, units: 1 },
      { plan: 'team', currency: 'chf', interval: 'year', subscriptions: 1, units: 3 }
    ]))
    expect(billed).toHaveLength(3)
    expect(recurringRevenue(billed, DEFAULT_PLAN_PRICES)).toEqual([
      { currency: 'chf', mrr: 37.5, arr: 450 },
      { currency: 'eur', mrr: 9, arr: 108 }
    ])
    expect(await subscriptionGroups(admin, 'trialing')).toEqual([{ plan: 'pro', currency: 'eur', interval: 'month', subscriptions: 1, units: 1 }])
    expect(await cancellingGroups(admin)).toEqual([{ plan: 'pro', currency: 'eur', interval: 'month', subscriptions: 1, units: 1 }])
  })

  it('reports top-ups, the waitlist and the plan mix', async () => {
    const r = await revenueCounts(admin, w30)
    expect(r.pastDue).toBe(1)
    expect(r.topups).toEqual([{ currency: 'eur', amount: 10, count: 1 }])
    expect(r.waitlist).toEqual({ confirmed: 1, unconfirmed: 1, newConfirmed: { value: 1, previous: 0 } })
    expect(r.planMix).toEqual({ free: 1, pro: 3, team: 1, business: 0 })
    const revenue = await buildRevenueStats(admin, w30)
    expect(revenue).toMatchObject({ billingEnabled: false, priceSource: 'planned', payingCustomers: 3, trialing: 1 })
    expect(revenue.scheduledCancellations).toEqual({ subscriptions: 1, revenue: [{ currency: 'eur', mrr: 9, arr: 108 }] })
  })

  it('counts started, scheduled and ended subscriptions from the history, with the MRR they moved', async () => {
    const revenue = await buildRevenueStats(admin, w30, now)
    expect(revenue.churn.started).toEqual({ value: 1, previous: 0 })
    expect(revenue.churn.cancelScheduled).toEqual({ value: 1, previous: 0 })
    expect(revenue.churn.ended).toEqual({ value: 1, previous: 1 })
    expect(revenue.churn.newMrr).toEqual([{ currency: 'eur', mrr: 9, arr: 108 }])
    expect(revenue.churn.lostMrr).toEqual([{ currency: 'eur', mrr: 100, arr: 1200 }])
    expect(revenue.churn.endedSeries.reduce((n, p) => n + p.v, 0)).toBe(1)
    // CHF 37.50 + EUR 9 at the default rate 0.93.
    expect(revenue.combinedChf.mrr).toBeCloseTo(45.87, 2)
    expect(revenue.estimate.assumptions).toMatchObject({ taxPct: 8.1, paymentFeePct: 3.5 })
    expect(revenue.estimate.perCurrency.map(e => e.currency)).toEqual(['chf', 'eur'])
    expect(revenue.estimate.combinedChf.gross).toBeCloseTo(45.87, 2)
  })

  it('records a subscription step once and anonymises it with the account', async () => {
    const event = {
      kind: 'started' as const,
      subject: { kind: 'user' as const, userId: ids.u4 },
      plan: 'pro' as const,
      interval: 'month' as const,
      currency: 'eur' as const,
      seats: 1,
      stripeSubscriptionId: 'sub_4',
      stripeEventId: 'evt_a',
      occurredAt: new Date()
    }
    expect(await recordSubscriptionEvent(sys(), undefined, event)).toBe(true)
    expect(await recordSubscriptionEvent(sys(), undefined, event)).toBe(false)
    // Another event that also says "started" for the same subscription adds nothing.
    expect(await recordSubscriptionEvent(sys(), undefined, { ...event, stripeEventId: 'evt_b' })).toBe(false)
    expect(await recordSubscriptionEvent(sys(), undefined, { ...event, kind: 'cancel_scheduled', stripeEventId: 'evt_b' })).toBe(true)
    expect((await listSubscriptionEventsOfUser(asUser(ids.u4))).map(e => e.kind)).toEqual(['started', 'cancel_scheduled'])
    expect(await anonymiseSubscriptionEventsOfUser(asUser(ids.u4))).toBe(2)
    expect(await listSubscriptionEventsOfUser(asUser(ids.u4))).toEqual([])
    const left = (await testDb().query(`SELECT count(*)::int AS n FROM subscription_events WHERE stripe_subscription_id IS NULL AND user_id IS NULL AND plan = 'pro'`)).rows[0]
    expect(left.n).toBe(2)
  })

  it('reports operational counts', async () => {
    const o = await opsCounts(admin, w30)
    expect(o.databaseBytes).toBeGreaterThan(0)
    expect(o).toMatchObject({ imageBytes: 2500, knowledgeBytes: 10300, publishedPages: 1, pendingDeletion: 1, knowledgeFailed: 1 })
    expect(o.exports.ready).toBe(1)
    expect(o.abuse).toMatchObject({ open: 1, dismissed: 1, received: { value: 2, previous: 0 } })
    expect((await buildOpsStats(admin, w30)).storage.imageBytes).toBe(2500)
  })

  it('counts BYOK users and MCP use', async () => {
    expect(await aiAppStats(admin, w30)).toEqual({
      byok: { users: 1, chat: 1, image: 1, transcription: 0 },
      mcp: { activeTokens: 1, sessions: { value: 1, previous: 0 } }
    })
  })

  it('sums LiteLLM spend once per request, not once per tag', async () => {
    await seedSpend(['feature:text-loop', `user:${ids.u1}`, `workspace:${ids.ws}`, 'doc:d'], 0.5, ago(1))
    await seedSpend(['feature:embeddings', `user:${ids.u2}`], 0.1, ago(2))
    await seedSpend(null, 0.2, ago(3))
    await seedSpend(['feature:text-loop'], 1, ago(45))
    const lastDay = isoDay(now)
    const totals = sumSpendRows(await spendByFeature(admin, { from: w30.from, to: lastDay }))
    expect(totals.spend).toBeCloseTo(0.8)
    expect(totals.requests).toBe(3)
    expect((await listSpendUserIds(admin, { from: w30.from, to: lastDay })).sort((a, b) => a - b)).toEqual([ids.u1, ids.u2].sort((a, b) => a - b))
    const rows = await spendByFeature(admin, { from: w30.from, to: lastDay, bucket: 'day' })
    expect(rows.every(r => typeof r.bucket === 'string')).toBe(true)
    const byFeature = new Map<string | null, number>()
    for (const r of rows) byFeature.set(r.feature_tag, (byFeature.get(r.feature_tag) ?? 0) + Number(r.spend))
    expect(byFeature.get('feature:text-loop')).toBeCloseTo(0.5)
    expect(byFeature.get('feature:embeddings')).toBeCloseTo(0.1)
    expect(byFeature.get(null)).toBeCloseTo(0.2)

    const ai = await buildAiStats(admin, w30, 2, now)
    expect(ai.spendAvailable).toBe(true)
    expect(ai.spendUsd).toEqual({ value: 0.8, previous: 1 })
    expect(ai.costPerAiUserUsd).toBeCloseTo(0.4)
    expect(ai.costPerActiveUserUsd).toBeCloseTo(0.4)
    expect(ai.byFeature[0]).toEqual({ feature: 'feature:text-loop', spendUsd: 0.5, requests: 1 })
  })

  it('counts only existing accounts as people using AI', async () => {
    // A deleted account's calls stay in the spend logs for 90 days.
    const gone = (await createUser()).id
    await seedSpend(['feature:text-loop', `user:${ids.u1}`], 0.3, ago(1))
    await seedSpend(['feature:text-loop', `user:${gone}`], 0.3, ago(1))
    await seedSpend(['feature:text-loop', 'user:not-a-number'], 0.3, ago(1))
    await q('DELETE FROM users WHERE id = $1', [gone])
    const ai = await buildAiStats(admin, w30, 4, now)
    expect(ai.aiUsers.value).toBe(1)
    expect(ai.aiUsers.value).toBeLessThanOrEqual((await userTotals(admin, w30)).registered)
    // The cost per AI user still divides the whole cost by everyone who made a call.
    expect(ai.costPerAiUserUsd).toBeCloseTo(0.45)
  })

  it('has no previous AI window once it is older than the history', async () => {
    const w = statsWindow('90', now, null)
    const ai = await buildAiStats(admin, w, 0, now)
    expect(ai.spendUsd.previous).toBeNull()
    expect(ai.spendFrom).toBe(spendLogFloor(w))
    expect(ai.aiUsersFrom).toBe(spendLogFloor(w))
  })

  it('rolls the spend logs up per day without user ids, and reads older days from the rollup', async () => {
    await seedSpend(['feature:text-loop', `user:${ids.u1}`], 0.5, ago(1))
    await seedSpend(['feature:text-loop', `user:${ids.u2}`], 0.25, ago(1))
    await seedSpend(['feature:image-gen', `user:${ids.u1}`], 0.1, ago(5))
    await seedSpend(['feature:text-loop', `user:${ids.u1}`], 9, ago(0))
    await litellm.query(`INSERT INTO "LiteLLM_SpendLogs" (request_id, call_type, api_key, spend, total_tokens, prompt_tokens, completion_tokens, "startTime", "endTime", model, model_group, request_tags)
      VALUES ('stats-byok', 'completion', '', 0, 1, 1, 0, $1, $1, 'gpt-x', 'byok/*', '["feature:text-loop"]'::jsonb)`, [ago(1)])
    const { rows } = await runAiSpendRollup(now)
    expect(rows).toBe(3)
    const daily = (await testDb().query(`SELECT day::text AS day, feature, model, platform_paid, spend_usd, requests, users FROM ai_spend_daily ORDER BY day, feature, platform_paid`)).rows
    const yesterday = daily.filter(r => r.day === isoDay(new Date(ago(1))))
    expect(yesterday).toEqual([
      expect.objectContaining({ feature: 'feature:text-loop', model: 'gpt-x', platform_paid: false, requests: 1 }),
      expect.objectContaining({ feature: 'feature:text-loop', model: 'm', platform_paid: true, requests: 2, users: 2 })
    ])
    // Today is still being written: not rolled up.
    expect(daily.some(r => r.day === isoDay(now))).toBe(false)
    expect(Object.keys(daily[0] ?? {})).not.toContain('user_id')
    // Running again overwrites, it does not add.
    await runAiSpendRollup(now)
    expect((await testDb().query('SELECT count(*)::int AS n FROM ai_spend_daily')).rows[0].n).toBe(3)

    // A day long gone from the raw logs counts through the rollup.
    await testDb().query(`INSERT INTO ai_spend_daily (day, feature, model, platform_paid, spend_usd, requests, users) VALUES ($1, 'feature:text-loop', 'm', true, 4, 10, 3)`, [isoDay(new Date(ago(200)))])
    const year = statsWindow('365', now, null)
    const ai = await buildAiStats(admin, year, 1, now)
    expect(ai.spendFrom).toBe(isoDay(new Date(ago(200))))
    expect(ai.spendUsd.value).toBeCloseTo(4 + 0.5 + 0.25 + 0.1 + 9, 2)
    expect(ai.aiUsersFrom).toBe(spendLogFloor(year))
  })

  it('answers the overview with the all-time window from the first sign-up', async () => {
    const w = await resolveStatsWindow(admin, 'all', undefined, now)
    expect(w.from).toBe(isoDay(new Date(ago(40))))
    const overview = await buildOverviewStats(admin, w)
    expect(overview.users.registered).toBe(4)
    expect(overview.content.documents).toBe(3)
    expect(overview.revenue.payingCustomers).toBe(3)
    expect(overview.users.signups.previous).toBeNull()
  })
})

describe('last active day', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('records the day once and never moves it back', async () => {
    const id = (await createUser()).id
    await markSessionUserActive(id, '2026-11-10')
    expect((await findSessionUser(id))?.lastActiveOn).toBe('2026-11-10')
    await markSessionUserActive(id, '2026-11-09')
    expect((await findSessionUser(id))?.lastActiveOn).toBe('2026-11-10')
    await markSessionUserActive(id, '2026-11-12')
    expect((await findSessionUser(id))?.lastActiveOn).toBe('2026-11-12')
  })
})
