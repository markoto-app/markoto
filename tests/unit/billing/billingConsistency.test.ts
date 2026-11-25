import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { stubEnv } from '../../helpers/env'
import { captureLogs } from '../../helpers/logs'

// The billing consistency check compares Stripe's live subscriptions with
// markoto's rows both ways and reports every drift with ids only; the
// daily job logs it, reports it to Sentry and emails the operator.

const { db, sentry, emails } = vi.hoisted(() => ({
  db: { users: [] as unknown[], workspaces: [] as unknown[] },
  sentry: { messages: [] as Array<{ msg: string, ctx: unknown }> },
  emails: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../server/repos/userBilling', () => ({ listTrackedUserSubscriptions: async () => db.users }))
vi.mock('../../../server/repos/workspaceSubscriptions', () => ({ listAllWorkspaceSubscriptions: async () => db.workspaces }))
vi.mock('@sentry/nuxt', () => ({ captureMessage: (msg: string, ctx: unknown) => sentry.messages.push({ msg, ctx }), captureException: () => {} }))
vi.mock('../../../server/utils/email/sendEmail', () => ({
  safeSendTransactionalEmail: async (args: Record<string, unknown>) => {
    emails.push(args)
  }
}))

const { checkBillingConsistency } = await import('../../../server/utils/billing/billingConsistency')
const { runBillingConsistencyCheck, buildConsistencyEmail } = await import('../../../server/utils/billing/billingConsistencySweep')

const logs = captureLogs()

async function* items<T>(list: T[]): AsyncGenerator<T> {
  for (const item of list) yield item
}

function sub(id: string, opts: { status?: string, lookupKey?: string | null, priceId?: string, quantity?: number, customer?: string, metadata?: Record<string, string> } = {}): Stripe.Subscription {
  return {
    id,
    status: opts.status ?? 'active',
    customer: opts.customer ?? `cus_${id}`,
    metadata: opts.metadata ?? {},
    items: { data: [{ quantity: opts.quantity ?? 1, price: { id: opts.priceId ?? `price_${id}`, lookup_key: opts.lookupKey === undefined ? 'markoto_pro_month_eur' : opts.lookupKey } }] }
  } as unknown as Stripe.Subscription
}

function fakeStripe(live: Stripe.Subscription[], others: Record<string, string | 'missing'> = {}) {
  const list = vi.fn((params: Stripe.SubscriptionListParams) => items(live.filter(s => s.status === params.status)))
  const retrieve = vi.fn(async (id: string) => {
    const status = others[id]
    if (!status || status === 'missing') throw Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 })
    return { id, status }
  })
  const stripe = { subscriptions: { list, retrieve }, prices: { list: async () => ({ data: [] }) } } as unknown as Stripe
  return { stripe, list, retrieve }
}

function userRow(userId: number, subscriptionId: string, over: Record<string, unknown> = {}) {
  return { userId, subscriptionId, customerId: `cus_${subscriptionId}`, plan: 'pro', interval: 'month', status: 'active', ...over }
}

function wsRow(workspaceId: string, subscriptionId: string | null, over: Record<string, unknown> = {}) {
  return { workspaceId, stripeSubscriptionId: subscriptionId, stripeCustomerId: subscriptionId ? `cus_${subscriptionId}` : null, plan: 'team', interval: 'month', seats: 5, status: 'active', ...over }
}

beforeEach(() => {
  db.users = []
  db.workspaces = []
  sentry.messages = []
  emails.length = 0
  stubEnv({ NUXT_STRIPE_PRICE_IDS: undefined, NUXT_STRIPE_LOOKUP_KEY_PREFIX: undefined, NUXT_BILLING_NOTIFY_EMAIL: undefined, NUXT_SITE_URL: 'https://markoto.test' })
})

describe('checkBillingConsistency', () => {
  it('reports nothing when Stripe and markoto agree, paging Stripe 100 at a time per live status', async () => {
    db.users = [userRow(1, 'sub_u'), userRow(2, 'sub_old', { status: 'canceled' })]
    db.workspaces = [wsRow('ws1', 'sub_w'), wsRow('ws2', null, { status: 'canceled' })]
    const f = fakeStripe([
      sub('sub_u'),
      sub('sub_w', { status: 'past_due', lookupKey: 'markoto_team_month_eur', quantity: 5 })
    ])
    db.workspaces = [wsRow('ws1', 'sub_w', { status: 'past_due' })]
    const report = await checkBillingConsistency(f.stripe, new Date('2026-11-25T00:00:00Z'))
    expect(report).toEqual({ checkedAt: '2026-11-25T00:00:00.000Z', stripeLive: 2, trackedLive: { users: 1, workspaces: 1 }, mismatches: [] })
    expect(f.list.mock.calls.map(c => c[0])).toEqual([
      { status: 'active', limit: 100 },
      { status: 'trialing', limit: 100 },
      { status: 'past_due', limit: 100 }
    ])
    expect(f.retrieve).not.toHaveBeenCalled()
  })

  it('a live Stripe subscription no row tracks is untracked (subject from its metadata); the test suite\'s are ignored', async () => {
    const f = fakeStripe([
      sub('sub_orphan', { metadata: { subject_type: 'user', subject_id: '7' } }),
      sub('sub_bare'),
      sub('sub_ci', { metadata: { markoto_test_run: 'run1' } })
    ])
    const report = await checkBillingConsistency(f.stripe)
    expect(report.stripeLive).toBe(2)
    expect(report.mismatches).toEqual([
      { kind: 'untracked', subscriptionId: 'sub_orphan', subject: { type: 'user', id: '7' }, stripe: 'active', markoto: null },
      { kind: 'untracked', subscriptionId: 'sub_bare', subject: null, stripe: 'active', markoto: null }
    ])
  })

  it('a row tracking a subscription Stripe no longer bills is reported with Stripe\'s status', async () => {
    db.users = [userRow(1, 'sub_gone'), userRow(2, 'sub_unknown', { status: null })]
    db.workspaces = [wsRow('ws1', 'sub_ws_gone', { status: 'trialing' })]
    const f = fakeStripe([], { sub_gone: 'canceled', sub_ws_gone: 'unpaid' })
    const report = await checkBillingConsistency(f.stripe)
    expect(report.trackedLive).toEqual({ users: 2, workspaces: 1 })
    expect(report.mismatches).toEqual(expect.arrayContaining([
      { kind: 'not-live-in-stripe', subscriptionId: 'sub_gone', subject: { type: 'user', id: '1' }, stripe: 'canceled', markoto: 'active' },
      { kind: 'not-live-in-stripe', subscriptionId: 'sub_unknown', subject: { type: 'user', id: '2' }, stripe: 'missing', markoto: 'tracked' },
      { kind: 'not-live-in-stripe', subscriptionId: 'sub_ws_gone', subject: { type: 'workspace', id: 'ws1' }, stripe: 'unpaid', markoto: 'trialing' }
    ]))
    expect(report.mismatches).toHaveLength(3)
  })

  it('reports status, plan, interval, seats and customer differences', async () => {
    db.users = [userRow(1, 'sub_u', { plan: 'free', interval: 'year', status: 'past_due', customerId: 'cus_other' })]
    db.workspaces = [wsRow('ws1', 'sub_w', { plan: 'business', seats: 3 })]
    const f = fakeStripe([
      sub('sub_u'),
      sub('sub_w', { lookupKey: 'markoto_team_year_eur', quantity: 8 })
    ])
    const kinds = (await checkBillingConsistency(f.stripe)).mismatches.map(m => [m.subscriptionId, m.kind, m.stripe, m.markoto])
    expect(kinds).toEqual([
      ['sub_u', 'status', 'active', 'past_due'],
      ['sub_u', 'customer', 'cus_sub_u', 'cus_other'],
      ['sub_u', 'plan', 'pro', 'free'],
      ['sub_u', 'interval', 'month', 'year'],
      ['sub_w', 'plan', 'team', 'business'],
      ['sub_w', 'interval', 'year', 'month'],
      ['sub_w', 'seats', 8, 3]
    ])
  })

  it('a price that is not ours is an unknown price; a row without status or interval skips those checks', async () => {
    db.users = [userRow(1, 'sub_u', { status: null, interval: null })]
    const f = fakeStripe([sub('sub_u', { lookupKey: null, priceId: 'price_foreign' })])
    expect((await checkBillingConsistency(f.stripe)).mismatches).toEqual([
      { kind: 'unknown-price', subscriptionId: 'sub_u', subject: { type: 'user', id: '1' }, stripe: 'price_foreign', markoto: 'pro' }
    ])
  })

  it('a Stripe failure other than a missing subscription stops the check', async () => {
    db.users = [userRow(1, 'sub_x')]
    const f = fakeStripe([])
    f.retrieve.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { statusCode: 429 }))
    await expect(checkBillingConsistency(f.stripe)).rejects.toThrow('rate limited')
  })
})

describe('runBillingConsistencyCheck (daily job)', () => {
  it('does nothing without a Stripe client', async () => {
    expect(await runBillingConsistencyCheck(null)).toEqual({ stripeLive: 0, mismatches: 0 })
  })

  it('stays quiet when everything agrees', async () => {
    db.users = [userRow(1, 'sub_u')]
    stubEnv({ NUXT_BILLING_NOTIFY_EMAIL: 'ops@markoto.test' })
    expect(await runBillingConsistencyCheck(fakeStripe([sub('sub_u')]).stripe)).toEqual({ stripeLive: 1, mismatches: 0 })
    expect(sentry.messages).toHaveLength(0)
    expect(emails).toHaveLength(0)
    expect(logs.find('warn')).toBeUndefined()
  })

  it('logs every mismatch (ids only), reports to Sentry, and without a notify address sends no email', async () => {
    const f = fakeStripe([sub('sub_orphan')])
    expect(await runBillingConsistencyCheck(f.stripe)).toEqual({ stripeLive: 1, mismatches: 1 })
    expect(logs.find('warn', 'billing mismatch')).toMatchObject({ kind: 'untracked', subscriptionId: 'sub_orphan' })
    expect(sentry.messages[0]).toMatchObject({ msg: 'billing consistency check found mismatches', ctx: { level: 'warning', extra: { count: 1, kinds: ['untracked'] } } })
    expect(emails).toHaveLength(0)
  })

  it('emails NUXT_BILLING_NOTIFY_EMAIL a summary with a link to the admin page', async () => {
    stubEnv({ NUXT_BILLING_NOTIFY_EMAIL: 'ops@markoto.test' })
    await runBillingConsistencyCheck(fakeStripe([sub('sub_orphan')]).stripe)
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({ kind: 'billing.consistency_report', to: 'ops@markoto.test', locale: null })
    expect(emails[0]!.subject).toBe('markoto billing check: 1 mismatch between Stripe and markoto')
    expect(emails[0]!.body).toContain('- untracked: sub_orphan (no subject), Stripe active, markoto -')
    expect(emails[0]!.body).toContain('https://markoto.test/admin/billing-consistency')
  })
})

describe('buildConsistencyEmail', () => {
  it('lists at most 50 mismatches and says how many more there are', () => {
    const mismatches = Array.from({ length: 53 }, (_, i) => ({ kind: 'seats' as const, subscriptionId: `sub_${i}`, subject: { type: 'workspace' as const, id: `ws${i}` }, stripe: 2, markoto: 3 }))
    const { subject, body } = buildConsistencyEmail({ checkedAt: 'now', stripeLive: 53, trackedLive: { users: 0, workspaces: 53 }, mismatches }, null)
    expect(subject).toContain('53 mismatches')
    expect(body.split('\n').filter(l => l.startsWith('- seats'))).toHaveLength(50)
    expect(body).toContain('... and 3 more')
    expect(body).not.toContain('/admin/billing-consistency')
  })
})
