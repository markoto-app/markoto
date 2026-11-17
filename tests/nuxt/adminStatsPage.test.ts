// @vitest-environment nuxt
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { H3Event } from 'h3'
import AdminStatsPage from '~/pages/admin/stats/index.vue'
import InvestorPage from '~/pages/admin/stats/investor.vue'
import type { AiStats, ContentStats, OpsStats, OverviewStats, RevenueStats, StatsWindow, UsersStats } from '~~/shared/contracts/adminStats'

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
  revenue: { revenue: [{ currency: 'chf', mrr: 37.5, arr: 450 }], payingCustomers: 3, billingEnabled: true, plansComingSoon: false, waitlistConfirmed: 0 },
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
  endedWorkspaceSubscriptions: kpi(0, 0),
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
    const rev = await open('?tab=revenue')
    expect(rev.text()).toContain('Billing is off')
    expect(rev.text()).toContain('321')
    expect((await open('?tab=ops')).text()).toContain('2 GB')
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
    await w.get('[data-testid="admin-stats-print"]').trigger('click')
    expect(print).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
