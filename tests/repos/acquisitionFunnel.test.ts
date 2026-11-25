import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { resetDb, testDb } from '../integration/setup/db'
import { TEST_DB_NAME, TEST_DB_URL } from '../integration/setup/env'
import { createDoc, createUser, createWorkspace } from '../integration/setup/fixtures'
import { adminAs, asUser } from '../helpers/access'
import { stubEnv } from '../helpers/env'
import { acquisitionFunnel } from '../../server/repos/productStats'
import { getAccountAcquisitionSource, recordAccountAcquisitionSource, recordCheckoutStarted } from '../../server/repos/acquisition'
import { landingVisits } from '../../server/repos/umamiVisits'
import { closeUmamiPool } from '../../server/db/umami'
import { buildFunnelStats } from '../../server/utils/adminStats/funnelStats'
import { statsWindow } from '../../shared/contracts/adminStats'

// The admin's "Funnel by source" against a seeded database
// (docs/contributing/admin-metrics.md#funnel-by-source): first documents
// per creator, the sign-up cohort with its checkouts and paying accounts,
// and Umami's landing visits (a stand-in `website_event` table in the
// test stack's `umami_test` database; Umami itself does not run there).

const admin = adminAs(1)
const DAY = 86_400_000
const now = new Date()
const ago = (days: number): string => new Date(now.getTime() - days * DAY).toISOString()
const w7 = statsWindow('7', now, null)
const SITE = '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc'
const OTHER_SITE = '11111111-2222-4333-8444-555555555555'

const UMAMI_URL = TEST_DB_URL.replace(new RegExp(`/${TEST_DB_NAME}$`), '/umami_test')
  .replace(/\/\/[^@]+@/, '//umami_test:umamitestpassword@')

async function q(text: string, params: unknown[] = []): Promise<void> {
  await testDb().query(text, params)
}

async function withUmami<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: UMAMI_URL })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function seed(): Promise<void> {
  // ph1: Product Hunt, signed up 2 days ago, Pro, first opened a checkout.
  const ph1 = (await createUser()).id
  await q(`UPDATE users SET acquisition_source = 'producthunt', checkout_started_at = now(), plan = 'pro', stripe_customer_id = 'cus_a',
    stripe_subscription_id = 'sub_a', subscription_status = 'active', plan_valid_until = $2, created_at = $3 WHERE id = $1`, [ph1, ago(-30), ago(2)])
  // ph2: Product Hunt, opened a checkout, never paid.
  const ph2 = (await createUser()).id
  await q(`UPDATE users SET acquisition_source = 'producthunt', checkout_started_at = now(), created_at = $2 WHERE id = $1`, [ph2, ago(1)])
  // hn: Hacker News, billing admin of a live Team workspace.
  const hn = (await createUser()).id
  await q(`UPDATE users SET acquisition_source = 'hackernews', checkout_started_at = now(), created_at = $2 WHERE id = $1`, [hn, ago(3)])
  const ws = (await createWorkspace(hn)).workspaceId
  await q(`INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, currency, interval, valid_until, billing_admin_id)
    VALUES ($1, 'team', 3, 'active', 'eur', 'month', $2, $3)`, [ws, ago(-20), hn])
  // direct: no source, signed up today; trialing Pro does not count as paying.
  const direct = (await createUser()).id
  await q(`UPDATE users SET plan = 'pro', stripe_subscription_id = 'sub_t', subscription_status = 'trialing', plan_valid_until = $2 WHERE id = $1`, [direct, ago(-7)])
  // old: Product Hunt but signed up 40 days ago: outside the cohort.
  const old = (await createUser()).id
  await q(`UPDATE users SET acquisition_source = 'producthunt', checkout_started_at = now(), created_at = $2 WHERE id = $1`, [old, ago(40)])

  // Documents. ph1 writes twice (counts once); old's first document is 40 days old.
  const d1 = (await createDoc({ ownerId: ph1 })).docId
  const d2 = (await createDoc({ ownerId: ph1 })).docId
  await q(`UPDATE documents SET acquisition_source = 'producthunt', created_at = $2 WHERE doc_id = $1`, [d1, ago(2)])
  await q(`UPDATE documents SET acquisition_source = 'producthunt', created_at = $2 WHERE doc_id = $1`, [d2, ago(1)])
  const d3 = (await createDoc({ ownerId: old })).docId
  const d4 = (await createDoc({ ownerId: old })).docId
  await q(`UPDATE documents SET acquisition_source = 'producthunt', created_at = $2 WHERE doc_id = $1`, [d3, ago(40)])
  await q(`UPDATE documents SET acquisition_source = 'producthunt' WHERE doc_id = $1`, [d4])
  // Two anonymous browsers from Product Hunt (one wrote twice), one from GitHub, one direct.
  for (const [key, source] of [['k-a', 'producthunt'], ['k-a', 'producthunt'], ['k-b', 'producthunt'], ['k-c', 'github'], ['k-d', null]] as const) {
    const id = (await createDoc()).docId
    await q(`UPDATE documents SET anon_creator_key_hash = $2, acquisition_source = $3 WHERE doc_id = $1`, [id, key, source])
  }
  // An older anonymous document without a creator key counts on its own.
  const legacy = (await createDoc()).docId
  await q(`UPDATE documents SET acquisition_source = 'other' WHERE doc_id = $1`, [legacy])
}

describe('acquisition funnel', () => {
  beforeEach(async () => {
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined })
    await resetDb()
    await seed()
  })

  it('counts first documents per creator and the sign-up cohort per source', async () => {
    const rows = await acquisitionFunnel(admin, w7)
    const by = Object.fromEntries(rows.map(r => [r.source, r]))
    expect(by.producthunt).toEqual({ source: 'producthunt', documents: 3, signups: 2, checkouts: 2, paid: 1 })
    expect(by.hackernews).toEqual({ source: 'hackernews', documents: 0, signups: 1, checkouts: 1, paid: 1 })
    expect(by.github).toEqual({ source: 'github', documents: 1, signups: 0, checkouts: 0, paid: 0 })
    expect(by.other).toEqual({ source: 'other', documents: 1, signups: 0, checkouts: 0, paid: 0 })
    expect(by.direct).toEqual({ source: 'direct', documents: 1, signups: 1, checkouts: 0, paid: 0 })
    expect(rows).toHaveLength(5)
  })

  it('stores an account\'s source and first checkout once', async () => {
    const id = (await createUser()).id
    const self = asUser(id)
    expect(await getAccountAcquisitionSource(self)).toBeNull()
    expect(await recordAccountAcquisitionSource(self, 'github')).toBe(true)
    expect(await recordAccountAcquisitionSource(self, 'google')).toBe(false)
    expect(await getAccountAcquisitionSource(self)).toBe('github')

    await recordCheckoutStarted(self)
    const first = (await testDb().query<{ t: Date }>('SELECT checkout_started_at AS t FROM users WHERE id = $1', [id])).rows[0]!.t
    await q(`UPDATE users SET checkout_started_at = $2 WHERE id = $1`, [id, ago(5)])
    await recordCheckoutStarted(self)
    const kept = (await testDb().query<{ t: Date }>('SELECT checkout_started_at AS t FROM users WHERE id = $1', [id])).rows[0]!.t
    expect(first).toBeInstanceOf(Date)
    expect(kept.toISOString()).toBe(ago(5))
  })
})

describe('landing visits from Umami', () => {
  beforeEach(async () => {
    stubEnv({
      NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: SITE,
      NUXT_SITE_URL: 'http://localhost:3000',
      NUXT_ANALYTICS_DB_USER: 'umami_test',
      NUXT_ANALYTICS_DB_PASSWORD: 'umamitestpassword',
      NUXT_ANALYTICS_DB_NAME: 'umami_test'
    })
    await resetDb()
    await seed()
    await closeUmamiPool()
    await withUmami(async (c) => {
      await c.query('DROP TABLE IF EXISTS website_event')
      await c.query(`CREATE TABLE website_event (event_id uuid DEFAULT gen_random_uuid(), website_id uuid, visit_id uuid, event_type int,
        url_query text, referrer_domain text, created_at timestamptz)`)
    })
  })

  afterAll(async () => {
    await closeUmamiPool()
    await withUmami(c => c.query('DROP TABLE IF EXISTS website_event'))
  })

  async function visit(site: string, startedDaysAgo: number, first: { query: string | null, referrer: string | null }, eventType = 1): Promise<void> {
    await withUmami(async (c) => {
      const v = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id
      await c.query(`INSERT INTO website_event (website_id, visit_id, event_type, url_query, referrer_domain, created_at) VALUES
        ($1, $2, $3, $4, $5, $6), ($1, $2, 1, 'ref=google', NULL, $7)`,
      [site, v, eventType, first.query, first.referrer, ago(startedDaysAgo), ago(startedDaysAgo - 0.01)])
    })
  }

  it('counts each visit once by its first page view, in the window, for this website', async () => {
    await visit(SITE, 1, { query: 'ref=producthunt', referrer: null })
    await visit(SITE, 2, { query: 'utm_source=producthunt&utm_medium=launch', referrer: null })
    await visit(SITE, 1, { query: null, referrer: 'news.ycombinator.com' })
    await visit(SITE, 1, { query: '', referrer: null })
    // Outside the window, another website: not counted.
    await visit(SITE, 9, { query: 'ref=producthunt', referrer: null })
    await visit(OTHER_SITE, 1, { query: 'ref=producthunt', referrer: null })

    const rows = await landingVisits(admin, SITE, w7.from, w7.to)
    expect(rows.reduce((n, r) => n + r.visits, 0)).toBe(4)

    const stats = await buildFunnelStats(admin, w7)
    expect(stats.visitsAvailable).toBe(true)
    const by = Object.fromEntries(stats.rows.map(r => [r.source, r]))
    expect(by.producthunt).toMatchObject({ visits: 2, documents: 3, signups: 2, checkouts: 2, paid: 1 })
    expect(by.hackernews).toMatchObject({ visits: 1, signups: 1 })
    expect(by.direct).toMatchObject({ visits: 1 })
    expect(stats.total.visits).toBe(4)
  })
})
