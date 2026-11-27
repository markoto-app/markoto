// @vitest-environment nuxt
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { H3Event } from 'h3'
import AdminStatsPage from '~/pages/admin/stats/index.vue'
import InvestorPage from '~/pages/admin/stats/investor.vue'
import AdminHubPage from '~/pages/admin/index.vue'
import { funnelRows, type AiStats, type ContentStats, type FunnelStats, type OpsStats, type OverviewStats, type RevenueStats, type StatsWindow, type UsersStats } from '~~/shared/contracts/adminStats'

// The admin's product stats: tabs and range live in the URL, every tab
// renders its numbers from its endpoint, tables download as CSV, and the
// investor summary prints.

const { charts } = vi.hoisted(() => ({ charts: [] as unknown[] }))
vi.mock('chart.js', () => {
  class Chart {
    static register(): void {}
    constructor(_el: unknown, config: unknown) {
      charts.push(config)
    }

    destroy(): void {}
  }
  const part = {}
  return {
    Chart, LineController: part, BarController: part, LineElement: part, BarElement: part, PointElement: part,
    CategoryScale: part, LinearScale: part, Tooltip: part, Legend: part, Filler: part
  }
})

mockNuxtImport('useUserSession', () => () => ({ loggedIn: ref(true), user: ref({ id: 1, name: 'Ada' }), session: ref({}), fetch: vi.fn(), clear: vi.fn() }))
mockNuxtImport('useAccountStatus', () => () => ({ status: ref({ isAdmin: true }) }))

const window: StatsWindow = { range: '30', from: '2026-10-19', to: '2026-11-18', prevFrom: '2026-09-19', bucket: 'day' }
const series = [{ t: '2026-11-16', v: 2 }, { t: '2026-11-17', v: 3 }]
const kpi = (value: number, previous: number | null = 1) => ({ value, previous })

const users: UsersStats = {
  window,
  registered: 1234,
  pendingDeletion: 2,
  signups: kpi(30, 20),
  signupSeries: series,
  active: { day: 40, week: 90, month: 200, stickinessPct: 20, inWindow: 200 },
  editors: kpi(80, 100),
  editorSeries: series,
  activation: { cohort: 30, createdDoc: 20, edited: 15, usedAi: 5 },
  providers: { github: 700, google: 500, oidc: 10, sso: 3 },
  plans: { free: 1200, pro: 34 },
  cohorts: [{ week: '2026-11-09', size: 10, retention: [100, 40, null] }]
}
const overview: OverviewStats = {
  window,
  users: { registered: 1234, signups: kpi(30, 20), active: users.active, editors: kpi(80, 100), signupSeries: series, editorSeries: series },
  content: { documents: 5678, created: kpi(9), documentSeries: series, workspaces: 12, knowledgeFiles: 44, publishedPages: 3 },
  revenue: { revenue: [{ currency: 'chf', mrr: 37.5, arr: 450 }], combinedChf: { mrr: 37.5, arr: 450 }, contributionChf: 28.4, payingCustomers: 3, billingEnabled: true, plansComingSoon: false, waitlistConfirmed: 0 },
  ai: { spendUsd: kpi(12.5, 10), aiUsers: kpi(7), spendAvailable: true }
}
const content: ContentStats = {
  window,
  documents: { total: 5678, owned: 5000, anonymous: 678, inWorkspaces: 100, words: 99999, created: kpi(9), edited: kpi(50) },
  documentSeries: series,
  workspaces: { total: 12, created: kpi(2), guests: 4, memberBuckets: [{ bucket: '1', workspaces: 10 }, { bucket: '2-5', workspaces: 2 }, { bucket: '6-20', workspaces: 0 }, { bucket: '21+', workspaces: 0 }] },
  knowledge: { files: 44, ready: 40, failed: 4, bytes: 5_000_000, chunks: 900, tokens: 100000, uploaded: kpi(6) },
  images: { files: 300, bytes: 70_000_000, uploaded: kpi(20) },
  published: { pages: 3, indexable: 1, customDomains: 1, verifiedDomains: 1 },
  comments: { total: 77, added: kpi(7) },
  savedThemes: 5
}
const ai: AiStats = {
  window,
  spendAvailable: true,
  spendFrom: '2026-10-19',
  aiUsersFrom: '2026-10-25',
  spendUsd: kpi(12.5, 10),
  requests: kpi(900),
  aiUsers: kpi(7),
  costPerAiUserUsd: 1.79,
  costPerActiveUserUsd: 0.06,
  byFeature: [{ feature: 'feature:text-loop', spendUsd: 10, requests: 800 }, { feature: 'feature:unknown-x', spendUsd: 2.5, requests: 100 }],
  series: [{ t: '2026-11-16', feature: 'feature:text-loop', spendUsd: 10 }, { t: '2026-11-17', feature: 'feature:unknown-x', spendUsd: 2.5 }],
  freePool: { capUsd: 500, spentThisMonthUsd: 125, pct: 25 },
  byok: { users: 3, chat: 3, image: 1, transcription: 0 },
  mcp: { activeTokens: 2, sessions: kpi(5) }
}
const revenue: RevenueStats = {
  window,
  billingEnabled: false,
  plansComingSoon: true,
  priceSource: 'planned',
  revenue: [{ currency: 'chf', mrr: 37.5, arr: 450 }],
  groups: [{ plan: 'team', currency: 'chf', interval: 'year', subscriptions: 1, units: 3 }],
  payingCustomers: 1,
  trialing: 0,
  pastDue: 0,
  scheduledCancellations: { subscriptions: 1, revenue: [{ currency: 'chf', mrr: 30, arr: 360 }] },
  churn: {
    started: kpi(4, 2),
    cancelScheduled: kpi(1, 0),
    ended: kpi(1, 1),
    newMrr: [{ currency: 'chf', mrr: 36, arr: 432 }],
    lostMrr: [{ currency: 'eur', mrr: 9, arr: 108 }],
    startedSeries: series,
    endedSeries: series
  },
  combinedChf: { mrr: 37.5, arr: 450 },
  estimate: {
    assumptions: { taxPct: 8.1, paymentFeePct: 3.5, paymentFeeFixed: 0.3, eurChfRate: 0.93, usdChfRate: 0.8 },
    perCurrency: [{ currency: 'chf', gross: 37.5, tax: 2.81, fees: 1.39, net: 33.3 }],
    combinedChf: { gross: 37.5, tax: 2.81, fees: 1.39, net: 33.3, aiCost: 4.9, contribution: 28.4 },
    aiCostUsd: null
  },
  topups: [{ currency: 'eur', amount: 25, count: 1 }],
  waitlist: { confirmed: 321, unconfirmed: 4, newConfirmed: kpi(21) },
  planMix: { free: 1200, pro: 0, team: 1, business: 0 }
}
const ops: OpsStats = {
  window,
  storage: { databaseBytes: 2_000_000_000, imageBytes: 70_000_000, knowledgeBytes: 5_000_000, publishedPages: 3 },
  exports: { queued: 0, running: 0, ready: 1, failed: 0, expired: 2 },
  abuse: { open: 1, acknowledged: 0, actioned: 2, dismissed: 3, received: kpi(1) },
  pendingDeletion: 2,
  knowledgeFailed: 4,
  restrictedDocuments: 0,
  openInvites: 6,
  pendingStripeEvents: 0
}

const funnelCounts = funnelRows({
  producthunt: { visits: 400, documents: 100, signups: 40, checkouts: 8, paid: 2 },
  direct: { visits: 50, documents: 10, signups: 5 }
}, true)
const funnel: FunnelStats = { window, trackingEnabled: true, visitsAvailable: true, ...funnelCounts }

const queries: Array<{ tab: string, query: Record<string, unknown> }> = []
function stats(tab: string, body: unknown) {
  registerEndpoint(`/api/admin/stats/${tab}`, async (event: H3Event) => {
    const { getQuery } = await import('h3')
    queries.push({ tab, query: getQuery(event) })
    return body
  })
}
stats('overview', overview)
stats('users', users)
stats('funnel', funnel)
stats('content', content)
stats('ai', ai)
stats('revenue', revenue)
stats('ops', ops)

afterEach(() => {
  queries.length = 0
  charts.length = 0
  vi.restoreAllMocks()
})

async function open(query: string) {
  const w = await mountSuspended(AdminStatsPage, { route: `/admin/stats${query}` })
  await flushPromises()
  await vi.waitFor(() => expect(w.text()).not.toContain('Loading…'))
  return w
}

describe('admin product stats page', () => {
  it('shows the overview for 30 days by default, with KPIs and charts', async () => {
    const w = await open('')
    expect(queries.at(-1)).toEqual({ tab: 'overview', query: { range: '30' } })
    expect(w.text()).toContain('1,234')
    expect(w.text()).toContain('5,678')
    expect(w.text()).toContain('MRR CHF')
    expect(w.text()).toContain('+50 %')
    await vi.waitFor(() => expect(charts.length).toBeGreaterThan(0))
  })

  it('steps count axes in whole numbers and keeps decimals on money axes', async () => {
    type Scale = { suggestedMax?: number, ticks: { precision?: number } }
    type Config = { options: { scales: { x: Scale, y: Scale } } }
    await open('')
    await vi.waitFor(() => expect(charts.length).toBeGreaterThan(0))
    for (const c of charts as Config[]) {
      expect(c.options.scales.y.ticks.precision).toBe(0)
      expect(c.options.scales.y.suggestedMax).toBe(4)
    }
    charts.length = 0
    await open('?tab=users')
    // The activation chart lies on its side: its values are on the x axis.
    await vi.waitFor(() => expect((charts as Config[]).some(c => c.options.scales.x.ticks.precision === 0)).toBe(true))
    charts.length = 0
    await open('?tab=ai')
    // Only the AI cost chart is in money.
    await vi.waitFor(() => expect((charts as Config[]).some(c => c.options.scales.y.ticks.precision === undefined)).toBe(true))
    const money = (charts as Config[]).find(c => c.options.scales.y.ticks.precision === undefined)!
    expect(money.options.scales.y.suggestedMax).toBeUndefined()
  })

  it('reads tab and range from the URL', async () => {
    const w = await open('?tab=users&range=7')
    expect(queries.at(-1)).toEqual({ tab: 'users', query: { range: '7' } })
    expect(w.find('[data-testid="admin-stats-cohorts"]').exists()).toBe(true)
    expect(w.text()).toContain('GitHub')
    expect(w.text()).toContain('Stickiness')
  })

  it('renders every other tab', async () => {
    expect((await open('?tab=content')).text()).toContain('99,999')
    const aiTab = await open('?tab=ai')
    expect(aiTab.text()).toContain('Writing assistant')
    expect(aiTab.text()).toContain('feature:unknown-x')
    expect(aiTab.text()).toContain('25 %')
    expect(aiTab.text()).toContain('counted from 2026-10-25')
    const rev = await open('?tab=revenue')
    expect(rev.text()).toContain('Billing is off')
    expect(rev.text()).toContain('321')
    expect(rev.text()).toContain('Estimated monthly contribution')
    expect(rev.text()).toContain('Tax contained (8.1 %)')
    expect(rev.text()).toContain('counts as 0')
    expect(rev.text()).toContain('Lost MRR EUR')
    expect((await open('?tab=ops')).text()).toContain('2 GB')
  })

  it('shows the funnel by source with step-to-step conversion', async () => {
    const w = await open('?tab=funnel&range=7')
    expect(queries.at(-1)).toEqual({ tab: 'funnel', query: { range: '7' } })
    const text = w.get('[data-testid="admin-stats-funnel"]').text()
    expect(text).toContain('Product Hunt')
    expect(text).toContain('Direct or unknown')
    // Visits, then each step with its share of the step before.
    expect(text).toContain('400')
    expect(text).toContain('100 · 25 %')
    expect(text).toContain('40 · 40 %')
    expect(text).toContain('8 · 20 %')
    expect(text).toContain('2 · 25 %')
    expect(text).toContain('450')
    expect(w.find('[data-testid="admin-stats-funnel-off"]').exists()).toBe(false)
    expect(w.find('[data-testid="admin-stats-funnel-no-visits"]').exists()).toBe(false)
    expect(w.find('[data-testid="admin-stats-funnel-exceeds"]').exists()).toBe(false)
  })

  it('shows no share where a step outgrows the one before, and says visits are undercounted', async () => {
    const { rows, total } = funnelRows({ direct: { visits: 1, documents: 65, signups: 13 } }, true)
    registerEndpoint('/api/admin/stats/funnel', () => ({ window, trackingEnabled: true, visitsAvailable: true, rows, total }))
    const w = await open('?tab=funnel&range=30')
    const text = w.get('[data-testid="admin-stats-funnel"]').text()
    expect(text).not.toContain('6,500')
    expect(text).not.toContain('6500')
    expect(text).toContain('13 · 20 %')
    expect(w.find('[data-testid="admin-stats-funnel-exceeds"]').text()).toContain('Visits are undercounted')
    stats('funnel', funnel)
  })

  it('says when sources are not recorded and visits are unavailable', async () => {
    const { rows, total } = funnelRows({ google: { documents: 3 } }, false)
    registerEndpoint('/api/admin/stats/funnel', () => ({ window, trackingEnabled: false, visitsAvailable: false, rows, total }))
    const w = await open('?tab=funnel&range=90')
    expect(w.find('[data-testid="admin-stats-funnel-off"]').exists()).toBe(true)
    expect(w.find('[data-testid="admin-stats-funnel-no-visits"]').exists()).toBe(true)
    expect(w.text()).toContain('n/a')
    stats('funnel', funnel)
  })

  it('falls back to the overview and 30 days for unknown values', async () => {
    const w = await open('?tab=secret&range=13')
    expect(w.get('[data-testid="admin-stats-range-30"]').attributes('aria-pressed')).toBe('true')
    expect(w.text()).toContain('5,678')
  })

  it('downloads a table as CSV', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const w = await open('?tab=ops')
    await w.get('[data-testid="admin-stats-csv-abuse-reports"]').trigger('click')
    expect(click).toHaveBeenCalledOnce()
  })

  it('shows an error when the stats cannot be loaded', async () => {
    registerEndpoint('/api/admin/stats/ops', () => {
      throw new Error('down')
    })
    const w = await mountSuspended(AdminStatsPage, { route: '/admin/stats?tab=ops&range=90' })
    await vi.waitFor(() => expect(w.text()).toContain('Couldn\'t load the stats'))
    stats('ops', ops)
  })
})

describe('investor summary', () => {
  it('shows 12 months of key numbers and prints', async () => {
    const print = vi.fn()
    vi.stubGlobal('print', print)
    const w = await mountSuspended(InvestorPage, { route: '/admin/stats/investor' })
    await vi.waitFor(() => expect(w.text()).toContain('1,234'))
    expect(queries).toEqual(expect.arrayContaining([
      { tab: 'overview', query: { range: '365', bucket: 'month' } },
      { tab: 'users', query: { range: '365', bucket: 'month' } }
    ]))
    expect(w.text()).toContain('321')
    expect(w.text()).toContain('MRR, all in CHF')
    await w.get('[data-testid="admin-stats-print"]').trigger('click')
    expect(print).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})

describe('admin hub', () => {
  it('links every admin page and shows the numbers that need a look', async () => {
    const w = await mountSuspended(AdminHubPage, { route: '/admin' })
    await vi.waitFor(() => expect(w.text()).toContain('1,234'))
    for (const [key, to] of [['stats', '/admin/stats'], ['investor', '/admin/stats/investor'], ['aiSpend', '/admin/ai-spend'], ['abuseReports', '/admin/abuse-reports']]) {
      expect(w.get(`[data-testid="admin-hub-${key}"]`).attributes('href')).toBe(to)
    }
    // One open report: shown as needing attention.
    const abuse = w.get('[data-testid="admin-hub-abuseReports"]')
    expect(abuse.text()).toContain('open or in review')
    expect(abuse.find('.text-error').text()).toBe('1')
    expect(w.text()).toContain('$12.50')
  })
})
