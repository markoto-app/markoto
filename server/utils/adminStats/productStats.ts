import {
  activation, aiAppStats, cancellingGroups, countExistingUsers, documentStats, editors, firstSignupDay, opsCounts,
  retentionCohorts, revenueCounts, signups, storedContentStats, subscriptionGroups, subscriptionStepSeries, subscriptionSteps,
  userTotals, workspaceStats, type SubscriptionStep
} from '../../repos/productStats'
import { aiSpendDailyByBucket, earliestAiSpendDay } from '../../repos/aiSpendDaily'
import { ROLLUP_DAYS } from '../litellm/aiSpendRollup'
import { useEnv } from '~~/shared/env/load'
import { listSpendUserIds, spendByFeature, sumTeamSpend, type FeatureSpendRow } from '../../repos/litellmSpend'
import type { AdminActor } from '../../repos/proofs'
import { getBillingMode } from '../billing/billingMode'
import { getPlanPrices } from '../billing/tierConfig'
import { useStripeClient } from '../billing/stripeClient'
import { livePlanPriceTable } from '../billing/stripePrices'
import { FREE_TIER_TEAM_ID, freeTierTotalBudgetUsd } from '../litellm/freeTierTeam'
import { useLogger } from '../platform/logger'
import { DAY_MS } from '~~/shared/config/units'
import type { PlanPriceTable } from '~~/shared/config/pricing'
import {
  combinedRevenueChf, estimateContribution, isoDay, pct, recurringRevenue, round2, statsWindow,
  type EstimateAssumptions,
  type AiStats, type ContentStats, type Kpi, type OpsStats, type OverviewStats, type RevenueStats,
  type StatsBucket, type StatsRange, type StatsWindow, type UsersStats
} from '~~/shared/contracts/adminStats'

// Builds the admin's product stats from the repos (app database) and the
// LiteLLM spend logs. Definitions: docs/contributing/admin-metrics.md.

/** Weekly sign-up cohorts in the retention table, and weeks followed per cohort. */
export const COHORT_WEEKS = 12

export async function resolveStatsWindow(by: AdminActor, range: StatsRange, bucket?: StatsBucket, now: Date = new Date()): Promise<StatsWindow> {
  return statsWindow(range, now, range === 'all' ? await firstSignupDay(by) : null, bucket)
}

/** Monday (UTC) of the week `weeksBack` weeks before the week of `now`. */
export function mondayWeeksBack(now: Date, weeksBack: number): string {
  const day = (now.getUTCDay() + 6) % 7
  return isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day - weeksBack * 7)))
}

/**
 * Retention table: one row per weekly cohort, `retention[k]` = % of the
 * cohort that edited in week k after signing up, null for weeks that have
 * not started yet.
 */
export function buildCohortTable(
  sizes: Array<{ week: string, size: number }>,
  retained: Array<{ week: string, offset: number, users: number }>,
  currentWeek: string
): UsersStats['cohorts'] {
  const current = Date.parse(`${currentWeek}T00:00:00Z`)
  return sizes.map(({ week, size }) => {
    const elapsed = Math.round((current - Date.parse(`${week}T00:00:00Z`)) / (7 * DAY_MS))
    const retention = Array.from({ length: COHORT_WEEKS }, (_, k) => {
      if (k > elapsed) return null
      const users = retained.find(r => r.week === week && r.offset === k)?.users ?? 0
      return pct(users, size)
    })
    return { week, size, retention }
  })
}

export async function buildUsersStats(by: AdminActor, w: StatsWindow, now: Date = new Date()): Promise<UsersStats> {
  const [totals, sign, edit, act, cohorts] = await Promise.all([
    userTotals(by, w),
    signups(by, w),
    editors(by, w),
    activation(by, w),
    retentionCohorts(by, mondayWeeksBack(now, COHORT_WEEKS - 1))
  ])
  return {
    window: w,
    registered: totals.registered,
    pendingDeletion: totals.pendingDeletion,
    signups: sign.kpi,
    signupSeries: sign.series,
    active: {
      day: totals.activeDay,
      week: totals.activeWeek,
      month: totals.activeMonth,
      stickinessPct: pct(totals.activeDay, totals.activeMonth),
      inWindow: totals.activeInWindow
    },
    editors: edit.kpi,
    editorSeries: edit.series,
    activation: act,
    providers: { github: totals.github, google: totals.google, oidc: totals.oidc, sso: totals.sso },
    plans: { free: totals.free, pro: totals.pro },
    cohorts: buildCohortTable(cohorts.sizes, cohorts.retained, mondayWeeksBack(now, 0))
  }
}

export async function buildContentStats(by: AdminActor, w: StatsWindow): Promise<ContentStats> {
  const [docs, ws, stored] = await Promise.all([documentStats(by, w), workspaceStats(by, w), storedContentStats(by, w)])
  const { series, ...documents } = docs
  return { window: w, documents, documentSeries: series, workspaces: ws, ...stored }
}

/** The last day of a window that ends before `toExclusive` (the spend queries take inclusive days). */
function lastDay(toExclusive: string): string {
  return isoDay(new Date(Date.parse(`${toExclusive}T00:00:00Z`) - DAY_MS))
}

/** Spend and requests over spend-log groups; each logged call is in exactly one group. */
export function sumSpendRows(rows: readonly FeatureSpendRow[]): { spend: number, requests: number } {
  return rows.reduce((t, r) => ({ spend: t.spend + Number(r.spend), requests: t.requests + Number(r.requests) }), { spend: 0, requests: 0 })
}

/**
 * First day read from the raw spend logs for a window ending `w.to`; the
 * days before come from the rollup (`ai_spend_daily`), which holds every
 * finished day the logs fully covered (`ROLLUP_DAYS`).
 */
export function spendLogFloor(w: StatsWindow): string {
  return isoDay(new Date(Date.parse(`${w.to}T00:00:00Z`) - (ROLLUP_DAYS + 1) * DAY_MS))
}

type SpendTotals = { spend: number, requests: number }

/** Cost and requests in [from, to) (days): rollup before `floor`, raw logs from it. */
async function spendBetween(by: AdminActor, from: string, to: string, floor: string, bucket: StatsBucket): Promise<SpendBucket[]> {
  const out: SpendBucket[] = []
  if (from < floor) out.push(...await aiSpendDailyByBucket(by, from, floor < to ? floor : to, bucket))
  const rawFrom = laterDay(from, floor)
  if (rawFrom < to) {
    const raw = await spendByFeature(by, { from: rawFrom, to: lastDay(to), bucket })
    out.push(...raw.map(r => ({ t: r.bucket ?? rawFrom, feature: r.feature_tag ?? 'other', spend: Number(r.spend), requests: Number(r.requests) })))
  }
  return out
}

/** The later of two days. */
function laterDay(a: string, b: string): string {
  return a > b ? a : b
}

/** `w.prevFrom` when the data reaches back to it, else null (no comparison). */
function comparableFrom(w: StatsWindow, coveredFrom: string): string | null {
  return w.prevFrom !== null && w.prevFrom >= coveredFrom ? w.prevFrom : null
}

type SpendBucket = { t: string, feature: string, spend: number, requests: number }

/** Totals per feature and the chart series (a bucket that straddles the rollup / raw boundary gets both parts). */
function shapeSpend(buckets: readonly SpendBucket[]): Pick<AiStats, 'byFeature' | 'series'> {
  const byFeature = new Map<string, SpendTotals>()
  const series = new Map<string, AiStats['series'][number]>()
  for (const b of buckets) {
    const f = byFeature.get(b.feature) ?? { spend: 0, requests: 0 }
    f.spend += b.spend
    f.requests += b.requests
    byFeature.set(b.feature, f)
    const key = `${b.t} ${b.feature}`
    const point = series.get(key) ?? { t: b.t, feature: b.feature, spendUsd: 0 }
    point.spendUsd += b.spend
    series.set(key, point)
  }
  return {
    byFeature: [...byFeature.entries()]
      .map(([feature, f]) => ({ feature, spendUsd: round2(f.spend), requests: f.requests }))
      .sort((a, b) => b.spendUsd - a.spendUsd),
    series: [...series.values()]
      .map(p => ({ ...p, spendUsd: round2(p.spendUsd) }))
      .sort((a, b) => a.t.localeCompare(b.t) || a.feature.localeCompare(b.feature))
  }
}

function totalsOf(rows: ReadonlyArray<{ spend: number, requests: number }>): SpendTotals {
  return rows.reduce((t, r) => ({ spend: t.spend + r.spend, requests: t.requests + r.requests }), { spend: 0, requests: 0 })
}

export async function buildAiStats(by: AdminActor, w: StatsWindow, activeUsers: number, now: Date = new Date()): Promise<AiStats> {
  const app = await aiAppStats(by, w)
  const floor = spendLogFloor(w)
  const capUsd = freeTierTotalBudgetUsd()
  const empty: AiStats = {
    window: w,
    spendAvailable: false,
    spendFrom: laterDay(w.from, floor),
    aiUsersFrom: laterDay(w.from, floor),
    spendUsd: { value: 0, previous: null },
    requests: { value: 0, previous: null },
    aiUsers: { value: 0, previous: null },
    costPerAiUserUsd: 0,
    costPerActiveUserUsd: 0,
    byFeature: [],
    series: [],
    freePool: { capUsd, spentThisMonthUsd: 0, pct: 0 },
    ...app
  }
  try {
    // Cost history: the rollup's first day, else what the raw logs cover.
    const earliest = await earliestAiSpendDay(by)
    const historyFrom = earliest !== null && earliest < floor ? earliest : floor
    const spendFrom = laterDay(w.from, historyFrom)
    const usersFrom = laterDay(w.from, floor)
    // A previous window is compared only where the history covers it.
    const prevFrom = comparableFrom(w, historyFrom)
    const prevUsersFrom = comparableFrom(w, floor)
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const [buckets, prevRows, userIds, prevUserIds, freeSpent] = await Promise.all([
      spendBetween(by, spendFrom, w.to, floor, w.bucket),
      prevFrom === null ? Promise.resolve(null) : spendBetween(by, prevFrom, w.from, floor, 'month'),
      listSpendUserIds(by, { from: usersFrom, to: lastDay(w.to) }),
      prevUsersFrom === null ? Promise.resolve(null) : listSpendUserIds(by, { from: prevUsersFrom, to: lastDay(w.from) }),
      capUsd === null ? Promise.resolve(0) : sumTeamSpend(FREE_TIER_TEAM_ID, monthStart, now)
    ])
    const cur = totalsOf(buckets)
    const prev = prevRows === null ? null : totalsOf(prevRows)
    // The spend logs keep the calls of accounts deleted since: "people
    // using AI" counts only accounts that still exist, so it can never
    // exceed the accounts. The cost per AI user divides by everyone who
    // made a call, because the cost includes theirs.
    const [users, prevUsers] = await Promise.all([
      countExistingUsers(by, userIds),
      prevUserIds === null ? Promise.resolve(null) : countExistingUsers(by, prevUserIds)
    ])
    return {
      ...empty,
      ...shapeSpend(buckets),
      spendAvailable: true,
      spendFrom,
      aiUsersFrom: usersFrom,
      spendUsd: { value: round2(cur.spend), previous: prev === null ? null : round2(prev.spend) },
      requests: { value: cur.requests, previous: prev?.requests ?? null },
      aiUsers: { value: users, previous: prevUsers },
      costPerAiUserUsd: userIds.length > 0 ? round2(cur.spend / userIds.length) : 0,
      costPerActiveUserUsd: activeUsers > 0 ? round2(cur.spend / activeUsers) : 0,
      freePool: { capUsd, spentThisMonthUsd: round2(freeSpent), pct: capUsd ? pct(freeSpent, capUsd) : 0 }
    }
  } catch (err) {
    // The proxy database is optional for the rest of the page.
    useLogger('admin-stats').warn('LiteLLM spend logs unavailable', { err })
    return empty
  }
}

/** Platform-paid AI cost (USD) of the 30 days ending today; null when the spend logs cannot be read. */
async function aiCostLast30Days(by: AdminActor, now: Date): Promise<number | null> {
  const today = isoDay(now)
  try {
    // Calls on a user's own key are logged at zero cost, so the sum is the platform-paid cost.
    return round2(sumSpendRows(await spendByFeature(by, { from: isoDay(new Date(now.getTime() - 29 * DAY_MS)), to: today })).spend)
  } catch (err) {
    useLogger('admin-stats').warn('LiteLLM spend logs unavailable', { err })
    return null
  }
}

/** The estimate assumptions from the configuration (`NUXT_STATS_*`). */
function estimateAssumptions(): EstimateAssumptions {
  const b = useEnv().billing
  return {
    taxPct: b.statsTaxPct,
    paymentFeePct: b.statsPaymentFeePct,
    paymentFeeFixed: b.statsPaymentFeeFixed,
    eurChfRate: b.statsEurChfRate,
    usdChfRate: b.statsUsdChfRate
  }
}

/** The price list MRR is valued at: live Stripe prices with billing on, the planned ones otherwise. */
async function priceTable(billingEnabled: boolean): Promise<{ prices: PlanPriceTable, source: 'stripe' | 'planned' }> {
  const stripe = billingEnabled ? useStripeClient() : null
  if (stripe) {
    try {
      return { prices: await livePlanPriceTable(stripe), source: 'stripe' }
    } catch (err) {
      useLogger('admin-stats').warn('Stripe prices unavailable, valuing at planned prices', { err })
    }
  }
  return { prices: getPlanPrices(), source: 'planned' }
}

export async function buildRevenueStats(by: AdminActor, w: StatsWindow, now: Date = new Date()): Promise<RevenueStats> {
  const mode = getBillingMode()
  const [billed, trialing, cancelling, counts, { prices, source }, steps, prevSteps, stepSeries, aiCostUsd] = await Promise.all([
    subscriptionGroups(by, 'billed'),
    subscriptionGroups(by, 'trialing'),
    cancellingGroups(by),
    revenueCounts(by, w),
    priceTable(mode.billingEnabled),
    subscriptionSteps(by, w.from, w.to),
    w.prevFrom === null ? Promise.resolve(null) : subscriptionSteps(by, w.prevFrom, w.from),
    subscriptionStepSeries(by, w),
    aiCostLast30Days(by, now)
  ])
  const assumptions = estimateAssumptions()
  const revenue = recurringRevenue(billed, prices)
  const stepCount = (list: typeof steps | null, kind: SubscriptionStep): number | null =>
    list === null ? null : list.filter(g => g.kind === kind).reduce((n, g) => n + g.subscriptions, 0)
  const stepKpi = (kind: SubscriptionStep): Kpi => ({ value: stepCount(steps, kind) ?? 0, previous: stepCount(prevSteps, kind) })
  const sum = (groups: typeof billed): number => groups.reduce((n, g) => n + g.subscriptions, 0)
  return {
    window: w,
    billingEnabled: mode.billingEnabled,
    plansComingSoon: mode.plansComingSoon,
    priceSource: source,
    revenue,
    groups: billed,
    payingCustomers: sum(billed),
    trialing: sum(trialing),
    pastDue: counts.pastDue,
    scheduledCancellations: { subscriptions: sum(cancelling), revenue: recurringRevenue(cancelling, prices) },
    churn: {
      started: stepKpi('started'),
      cancelScheduled: stepKpi('cancel_scheduled'),
      ended: stepKpi('ended'),
      newMrr: recurringRevenue(steps.filter(g => g.kind === 'started'), prices),
      lostMrr: recurringRevenue(steps.filter(g => g.kind === 'ended'), prices),
      startedSeries: stepSeries.started,
      endedSeries: stepSeries.ended
    },
    combinedChf: combinedRevenueChf(revenue, assumptions),
    estimate: {
      assumptions,
      ...estimateContribution(billed, prices, assumptions, aiCostUsd ?? 0),
      aiCostUsd
    },
    topups: counts.topups,
    waitlist: counts.waitlist,
    planMix: counts.planMix
  }
}

export async function buildOpsStats(by: AdminActor, w: StatsWindow): Promise<OpsStats> {
  const o = await opsCounts(by, w)
  return {
    window: w,
    storage: { databaseBytes: o.databaseBytes, imageBytes: o.imageBytes, knowledgeBytes: o.knowledgeBytes, publishedPages: o.publishedPages },
    exports: o.exports,
    abuse: o.abuse,
    pendingDeletion: o.pendingDeletion,
    knowledgeFailed: o.knowledgeFailed,
    restrictedDocuments: o.restrictedDocuments,
    openInvites: o.openInvites,
    pendingStripeEvents: o.pendingStripeEvents
  }
}

export async function buildOverviewStats(by: AdminActor, w: StatsWindow): Promise<OverviewStats> {
  const [users, content, revenue] = await Promise.all([
    buildUsersStats(by, w),
    buildContentStats(by, w),
    buildRevenueStats(by, w)
  ])
  const ai = await buildAiStats(by, w, users.active.inWindow)
  return {
    window: w,
    users: {
      registered: users.registered,
      signups: users.signups,
      active: users.active,
      editors: users.editors,
      signupSeries: users.signupSeries,
      editorSeries: users.editorSeries
    },
    content: {
      documents: content.documents.total,
      created: content.documents.created,
      documentSeries: content.documentSeries,
      workspaces: content.workspaces.total,
      knowledgeFiles: content.knowledge.files,
      publishedPages: content.published.pages
    },
    revenue: {
      revenue: revenue.revenue,
      combinedChf: revenue.combinedChf,
      contributionChf: revenue.estimate.combinedChf.contribution,
      payingCustomers: revenue.payingCustomers,
      billingEnabled: revenue.billingEnabled,
      plansComingSoon: revenue.plansComingSoon,
      waitlistConfirmed: revenue.waitlist.confirmed
    },
    ai: { spendUsd: ai.spendUsd, aiUsers: ai.aiUsers, spendAvailable: ai.spendAvailable }
  }
}
