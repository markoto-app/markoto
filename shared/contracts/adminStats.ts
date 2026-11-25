// Admin product stats (`/admin/stats`, `/api/admin/stats/*`): the date
// windows, the response shapes and the pure arithmetic behind them (period
// change, MRR). Every number is an aggregate; no response names a person.
// Metric definitions: docs/contributing/admin-metrics.md.

import { DAY_MS } from '../config/units'
import type { BillingInterval, Currency, PaidPlanName, PlanPriceTable } from '../config/pricing'
import { FUNNEL_SOURCES, type FunnelSource } from '../analytics/acquisition'

export const STATS_RANGES = ['7', '30', '90', '365', 'all'] as const
export type StatsRange = typeof STATS_RANGES[number]

export const STATS_BUCKETS = ['day', 'week', 'month'] as const
export type StatsBucket = typeof STATS_BUCKETS[number]

/** `all` reaches back at most this many months (the series stay readable). */
export const ALL_TIME_MAX_MONTHS = 60

/**
 * A reporting window: `[from, to)` in whole UTC days, the equally long
 * window right before it (for the period-over-period change), and the
 * size of one point of the time series. `all` has no previous window.
 */
export interface StatsWindow {
  range: StatsRange
  /** First day (inclusive), `YYYY-MM-DD`. */
  from: string
  /** Day after the last day (exclusive), `YYYY-MM-DD`: tomorrow, so today counts. */
  to: string
  prevFrom: string | null
  bucket: StatsBucket
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(day: string, n: number): string {
  return isoDay(new Date(new Date(`${day}T00:00:00Z`).getTime() + n * DAY_MS))
}

/** The bucket a range is charted in when the caller does not choose one. */
export function defaultBucket(range: StatsRange): StatsBucket {
  if (range === 'all') return 'month'
  return range === '365' ? 'week' : 'day'
}

/**
 * The window for a range ending today. `firstDay` is the earliest day with
 * data (the first sign-up), used as the start of `all`; it is clamped to
 * `ALL_TIME_MAX_MONTHS` before today.
 */
export function statsWindow(range: StatsRange, now: Date, firstDay: string | null, bucket?: StatsBucket): StatsWindow {
  const to = addDays(isoDay(now), 1)
  if (range === 'all') {
    const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ALL_TIME_MAX_MONTHS + 1, 1))
    const from = firstDay && firstDay > isoDay(floor) ? firstDay : isoDay(floor)
    return { range, from, to, prevFrom: null, bucket: bucket ?? 'month' }
  }
  const days = Number(range)
  const from = addDays(to, -days)
  return { range, from, to, prevFrom: addDays(from, -days), bucket: bucket ?? defaultBucket(range) }
}

/** A number with the same number for the previous window (null = no comparison). */
export interface Kpi {
  value: number
  previous: number | null
}

/** Relative change in percent, or null when there is nothing to compare with. */
export function percentChange(kpi: Kpi): number | null {
  if (kpi.previous === null) return null
  if (kpi.previous === 0) return kpi.value === 0 ? 0 : null
  return ((kpi.value - kpi.previous) / kpi.previous) * 100
}

/** One point of a time series: the bucket's first day and its value. */
export interface SeriesPoint {
  t: string
  v: number
}

// Revenue

/** One group of live subscriptions with the same price. */
export interface SubscriptionGroup {
  plan: PaidPlanName
  currency: Currency
  interval: BillingInterval
  /** Subscriptions in the group. */
  subscriptions: number
  /** Billed units: 1 per Pro subscription, the seats of a Team / Business one. */
  units: number
}

export interface CurrencyRevenue {
  currency: Currency
  /** Monthly recurring revenue at list price; yearly plans count 1/12 per month. */
  mrr: number
  /** 12 x MRR. */
  arr: number
}

/**
 * MRR and ARR per currency at list price. Discounts, coupons, taxes and
 * payment fees are not in the subscription rows, so this is gross list
 * revenue, not cash collected.
 */
export function recurringRevenue(groups: readonly SubscriptionGroup[], prices: PlanPriceTable): CurrencyRevenue[] {
  const byCurrency = new Map<Currency, number>()
  for (const g of groups) {
    const price = prices[g.currency][g.plan][g.interval]
    const monthly = g.interval === 'year' ? price / 12 : price
    byCurrency.set(g.currency, (byCurrency.get(g.currency) ?? 0) + monthly * g.units)
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, mrr]) => ({ currency, mrr: round2(mrr), arr: round2(mrr * 12) }))
}

/**
 * The assumptions of the estimated contribution and the combined CHF
 * figures (`NUXT_STATS_*`). Percentages are 0-100; the fixed fee is in the
 * charge's currency.
 */
export interface EstimateAssumptions {
  taxPct: number
  paymentFeePct: number
  paymentFeeFixed: number
  eurChfRate: number
  usdChfRate: number
}

export function toChf(amount: number, currency: Currency, a: EstimateAssumptions): number {
  return currency === 'chf' ? amount : amount * a.eurChfRate
}

/** MRR and ARR of all currencies together, in CHF at the fixed rate. */
export function combinedRevenueChf(revenue: readonly CurrencyRevenue[], a: EstimateAssumptions): { mrr: number, arr: number } {
  const mrr = revenue.reduce((n, r) => n + toChf(r.mrr, r.currency, a), 0)
  return { mrr: round2(mrr), arr: round2(mrr * 12) }
}

/** One month of one currency: gross list revenue, the tax it contains, payment fees, and what is left. */
export interface CurrencyEstimate {
  currency: Currency
  gross: number
  tax: number
  fees: number
  net: number
}

/** One month in CHF: the currencies together, minus the platform-paid AI cost. */
export interface CombinedEstimate {
  gross: number
  tax: number
  fees: number
  net: number
  aiCost: number
  contribution: number
}

/**
 * Estimated monthly contribution. Per currency: gross = MRR at list price
 * (prices include tax); tax = gross x rate / (100 + rate); fees = gross x
 * fee % + fixed fee x charges per month (a monthly subscription is charged
 * once a month, a yearly one 1/12 times); net = gross - tax - fees. In CHF:
 * the nets together minus the platform-paid AI cost of the last 30 days.
 */
export function estimateContribution(
  groups: readonly SubscriptionGroup[],
  prices: PlanPriceTable,
  a: EstimateAssumptions,
  aiCostUsd: number
): { perCurrency: CurrencyEstimate[], combinedChf: CombinedEstimate } {
  const perCurrency = recurringRevenue(groups, prices).map((r): CurrencyEstimate => {
    const charges = groups
      .filter(g => g.currency === r.currency)
      .reduce((n, g) => n + (g.interval === 'year' ? g.subscriptions / 12 : g.subscriptions), 0)
    const tax = r.mrr * a.taxPct / (100 + a.taxPct)
    const fees = r.mrr * a.paymentFeePct / 100 + charges * a.paymentFeeFixed
    return { currency: r.currency, gross: r.mrr, tax: round2(tax), fees: round2(fees), net: round2(r.mrr - tax - fees) }
  })
  const sum = (pick: (e: CurrencyEstimate) => number) => perCurrency.reduce((n, e) => n + toChf(pick(e), e.currency, a), 0)
  const net = sum(e => e.net)
  const aiCost = aiCostUsd * a.usdChfRate
  return {
    perCurrency,
    combinedChf: {
      gross: round2(sum(e => e.gross)),
      tax: round2(sum(e => e.tax)),
      fees: round2(sum(e => e.fees)),
      net: round2(net),
      aiCost: round2(aiCost),
      contribution: round2(net - aiCost)
    }
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Share `part / whole` in percent with one decimal, 0 when `whole` is 0. */
export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

// Response shapes

export interface UsersStats {
  window: StatsWindow
  registered: number
  pendingDeletion: number
  signups: Kpi
  signupSeries: SeriesPoint[]
  /** From `users.last_active_on`: signed-in users seen today / in 7 / in 30 days. */
  active: { day: number, week: number, month: number, stickinessPct: number, inWindow: number }
  /** Signed-in people who edited a document (activity log), per window and per bucket. */
  editors: Kpi
  editorSeries: SeriesPoint[]
  /** Of the accounts created in the window: how many created a document / edited / used the in-editor AI. */
  activation: { cohort: number, createdDoc: number, edited: number, usedAi: number }
  providers: { github: number, google: number, oidc: number, sso: number }
  plans: { free: number, pro: number }
  /** Weekly sign-up cohorts (oldest first): % of the cohort that edited in week 0, 1, 2, ... after signing up. */
  cohorts: Array<{ week: string, size: number, retention: Array<number | null> }>
}

export interface ContentStats {
  window: StatsWindow
  documents: { total: number, owned: number, anonymous: number, inWorkspaces: number, words: number, created: Kpi, edited: Kpi }
  documentSeries: SeriesPoint[]
  workspaces: { total: number, created: Kpi, guests: number, memberBuckets: Array<{ bucket: string, workspaces: number }> }
  knowledge: { files: number, ready: number, failed: number, bytes: number, chunks: number, tokens: number, uploaded: Kpi }
  images: { files: number, bytes: number, uploaded: Kpi }
  published: { pages: number, indexable: number, customDomains: number, verifiedDomains: number }
  comments: { total: number, added: Kpi }
  savedThemes: number
}

export interface AiFeatureSpend {
  feature: string
  spendUsd: number
  requests: number
}

export interface AiStats {
  window: StatsWindow
  /** False when the LiteLLM database could not be read; spend numbers are then 0. */
  spendAvailable: boolean
  /** First day the cost figures cover (the daily rollup, then the raw spend logs). */
  spendFrom: string
  /** First day "people using AI" covers: distinct users exist only in the raw spend logs (90 days). */
  aiUsersFrom: string
  spendUsd: Kpi
  requests: Kpi
  aiUsers: Kpi
  costPerAiUserUsd: number
  costPerActiveUserUsd: number
  byFeature: AiFeatureSpend[]
  series: Array<{ t: string, feature: string, spendUsd: number }>
  freePool: { capUsd: number | null, spentThisMonthUsd: number, pct: number }
  byok: { users: number, chat: number, image: number, transcription: number }
  mcp: { activeTokens: number, sessions: Kpi }
}

export interface RevenueStats {
  window: StatsWindow
  billingEnabled: boolean
  plansComingSoon: boolean
  priceSource: 'stripe' | 'planned'
  revenue: CurrencyRevenue[]
  groups: SubscriptionGroup[]
  payingCustomers: number
  trialing: number
  pastDue: number
  /** Live subscriptions that are set to end, with the MRR they carry. */
  scheduledCancellations: { subscriptions: number, revenue: CurrencyRevenue[] }
  /** From the subscription history: subscriptions started, set to end and ended in the window, and the MRR they brought or took. */
  churn: {
    started: Kpi
    cancelScheduled: Kpi
    ended: Kpi
    newMrr: CurrencyRevenue[]
    lostMrr: CurrencyRevenue[]
    startedSeries: SeriesPoint[]
    endedSeries: SeriesPoint[]
  }
  /** All currencies in CHF at the fixed rate. */
  combinedChf: { mrr: number, arr: number }
  /** Estimated monthly contribution (see `estimateContribution`). */
  estimate: {
    assumptions: EstimateAssumptions
    perCurrency: CurrencyEstimate[]
    combinedChf: CombinedEstimate
    /** Platform-paid AI cost of the last 30 days, USD; null when the spend logs could not be read (then 0 in the contribution). */
    aiCostUsd: number | null
  }
  topups: Array<{ currency: Currency, amount: number, count: number }>
  waitlist: { confirmed: number, unconfirmed: number, newConfirmed: Kpi }
  planMix: { free: number, pro: number, team: number, business: number }
}

export interface OpsStats {
  window: StatsWindow
  storage: { databaseBytes: number, imageBytes: number, knowledgeBytes: number, publishedPages: number }
  exports: Record<'queued' | 'running' | 'ready' | 'failed' | 'expired', number>
  abuse: { open: number, acknowledged: number, actioned: number, dismissed: number, received: Kpi }
  pendingDeletion: number
  knowledgeFailed: number
  restrictedDocuments: number
  openInvites: number
  pendingStripeEvents: number
}

export interface OverviewStats {
  window: StatsWindow
  users: Pick<UsersStats, 'registered' | 'signups' | 'active' | 'editors' | 'signupSeries' | 'editorSeries'>
  content: { documents: number, created: Kpi, documentSeries: SeriesPoint[], workspaces: number, knowledgeFiles: number, publishedPages: number }
  revenue: Pick<RevenueStats, 'revenue' | 'payingCustomers' | 'billingEnabled' | 'plansComingSoon' | 'combinedChf'> & { waitlistConfirmed: number, contributionChf: number }
  ai: Pick<AiStats, 'spendUsd' | 'aiUsers' | 'spendAvailable'>
}

// Funnel by source

/** The funnel's steps, in order (definitions: docs/contributing/admin-metrics.md#funnel-by-source). */
export const FUNNEL_STEPS = ['visits', 'documents', 'signups', 'checkouts', 'paid'] as const
export type FunnelStep = typeof FUNNEL_STEPS[number]

/** One source's counts; `visits` is null where the statistics database cannot be read. */
export interface FunnelRow {
  source: FunnelSource | 'all'
  visits: number | null
  documents: number
  signups: number
  checkouts: number
  paid: number
}

export interface FunnelStats {
  window: StatsWindow
  /** Sources are recorded only where the statistics are on (NUXT_PUBLIC_ANALYTICS_WEBSITE_ID). */
  trackingEnabled: boolean
  /** Visits come from Umami's database; false when it is off or could not be read. */
  visitsAvailable: boolean
  /** One row per source (every source, also empty ones), in `FUNNEL_SOURCES` order. */
  rows: FunnelRow[]
  /** All sources together. */
  total: FunnelRow
}

/** Step-to-step conversion in percent (one decimal); null when the step before is unknown or 0. */
export function stepConversion(row: FunnelRow, step: FunnelStep): number | null {
  const i = FUNNEL_STEPS.indexOf(step)
  if (i <= 0) return null
  const before = row[FUNNEL_STEPS[i - 1] as FunnelStep]
  const value = row[step]
  if (before === null || value === null || before === 0) return null
  return pct(value, before)
}

type Counts = Omit<FunnelRow, 'source'>

/** Rows for every source from the per-source counts (missing sources are 0), plus the total. */
export function funnelRows(counts: Partial<Record<FunnelSource, Partial<Counts>>>, visitsAvailable: boolean): { rows: FunnelRow[], total: FunnelRow } {
  const rows = FUNNEL_SOURCES.map((source): FunnelRow => {
    const c = counts[source] ?? {}
    return {
      source,
      visits: visitsAvailable ? (c.visits ?? 0) : null,
      documents: c.documents ?? 0,
      signups: c.signups ?? 0,
      checkouts: c.checkouts ?? 0,
      paid: c.paid ?? 0
    }
  })
  const sum = (k: Exclude<keyof Counts, 'visits'>) => rows.reduce((n, r) => n + r[k], 0)
  return {
    rows,
    total: {
      source: 'all',
      visits: visitsAvailable ? rows.reduce((n, r) => n + (r.visits ?? 0), 0) : null,
      documents: sum('documents'),
      signups: sum('signups'),
      checkouts: sum('checkouts'),
      paid: sum('paid')
    }
  }
}
