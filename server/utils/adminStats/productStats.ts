import {
  activation, aiAppStats, cancellingGroups, documentStats, editors, firstSignupDay, opsCounts,
  retentionCohorts, revenueCounts, signups, storedContentStats, subscriptionGroups, userTotals, workspaceStats
} from '../../repos/productStats'
import { countSpendUsers, spendByFeature, sumTeamSpend, type FeatureSpendRow } from '../../repos/litellmSpend'
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
  isoDay, pct, recurringRevenue, round2, statsWindow,
  type AiStats, type ContentStats, type Kpi, type OpsStats, type OverviewStats, type RevenueStats,
  type StatsBucket, type StatsRange, type StatsWindow, type UsersStats
} from '~~/shared/contracts/adminStats'

// Builds the admin's product stats from the repos (app database) and the
// LiteLLM spend logs. Definitions: docs/contributing/admin-metrics.md.

/** LiteLLM spend rows are deleted after 90 days (`spend-logs-sweep`). */
const SPEND_LOG_DAYS = 90

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

/** First day the spend logs still cover, for a window ending `w.to`. */
export function spendLogFloor(w: StatsWindow): string {
  return isoDay(new Date(Date.parse(`${w.to}T00:00:00Z`) - SPEND_LOG_DAYS * DAY_MS))
}

export async function buildAiStats(by: AdminActor, w: StatsWindow, activeUsers: number, now: Date = new Date()): Promise<AiStats> {
  const app = await aiAppStats(by, w)
  const floor = spendLogFloor(w)
  const spendFrom = w.from > floor ? w.from : floor
  // The previous window is comparable only while the logs still cover it.
  const prevFrom = w.prevFrom !== null && w.prevFrom >= floor ? w.prevFrom : null
  const capUsd = freeTierTotalBudgetUsd()
  const empty: AiStats = {
    window: w,
    spendAvailable: false,
    spendFrom,
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
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const [buckets, prevRows, users, prevUsers, freeSpent] = await Promise.all([
      spendByFeature(by, { from: spendFrom, to: lastDay(w.to), bucket: w.bucket }),
      prevFrom === null ? Promise.resolve(null) : spendByFeature(by, { from: prevFrom, to: lastDay(w.from) }),
      countSpendUsers(by, { from: spendFrom, to: lastDay(w.to) }),
      prevFrom === null ? Promise.resolve(null) : countSpendUsers(by, { from: prevFrom, to: lastDay(w.from) }),
      capUsd === null ? Promise.resolve(0) : sumTeamSpend(FREE_TIER_TEAM_ID, monthStart, now)
    ])
    const cur = { ...sumSpendRows(buckets), users }
    const prev = prevRows === null ? null : { ...sumSpendRows(prevRows), users: prevUsers ?? 0 }
    const kpiOf = (pick: (t: { spend: number, requests: number, users: number }) => number): Kpi =>
      ({ value: pick(cur), previous: prev === null ? null : pick(prev) })
    const byFeature = new Map<string, { spendUsd: number, requests: number }>()
    const series: AiStats['series'] = []
    for (const b of buckets) {
      const feature = b.feature_tag ?? 'other'
      const f = byFeature.get(feature) ?? { spendUsd: 0, requests: 0 }
      f.spendUsd += Number(b.spend)
      f.requests += Number(b.requests)
      byFeature.set(feature, f)
      series.push({ t: b.bucket ?? spendFrom, feature, spendUsd: round2(Number(b.spend)) })
    }
    series.sort((a, b) => a.t.localeCompare(b.t) || a.feature.localeCompare(b.feature))
    return {
      ...empty,
      spendAvailable: true,
      spendUsd: kpiOf(t => round2(t.spend)),
      requests: kpiOf(t => t.requests),
      aiUsers: kpiOf(t => t.users),
      costPerAiUserUsd: cur.users > 0 ? round2(cur.spend / cur.users) : 0,
      costPerActiveUserUsd: activeUsers > 0 ? round2(cur.spend / activeUsers) : 0,
      byFeature: [...byFeature.entries()]
        .map(([feature, f]) => ({ feature, spendUsd: round2(f.spendUsd), requests: f.requests }))
        .sort((a, b) => b.spendUsd - a.spendUsd),
      series,
      freePool: { capUsd, spentThisMonthUsd: round2(freeSpent), pct: capUsd ? pct(freeSpent, capUsd) : 0 }
    }
  } catch (err) {
    // The proxy database is optional for the rest of the page.
    useLogger('admin-stats').warn('LiteLLM spend logs unavailable', { err })
    return empty
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

export async function buildRevenueStats(by: AdminActor, w: StatsWindow): Promise<RevenueStats> {
  const mode = getBillingMode()
  const [billed, trialing, cancelling, counts, { prices, source }] = await Promise.all([
    subscriptionGroups(by, 'billed'),
    subscriptionGroups(by, 'trialing'),
    cancellingGroups(by),
    revenueCounts(by, w),
    priceTable(mode.billingEnabled)
  ])
  const sum = (groups: typeof billed): number => groups.reduce((n, g) => n + g.subscriptions, 0)
  return {
    window: w,
    billingEnabled: mode.billingEnabled,
    plansComingSoon: mode.plansComingSoon,
    priceSource: source,
    revenue: recurringRevenue(billed, prices),
    groups: billed,
    payingCustomers: sum(billed),
    trialing: sum(trialing),
    pastDue: counts.pastDue,
    scheduledCancellations: { subscriptions: sum(cancelling), revenue: recurringRevenue(cancelling, prices) },
    endedWorkspaceSubscriptions: counts.endedWorkspaceSubscriptions,
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
      payingCustomers: revenue.payingCustomers,
      billingEnabled: revenue.billingEnabled,
      plansComingSoon: revenue.plansComingSoon,
      waitlistConfirmed: revenue.waitlist.confirmed
    },
    ai: { spendUsd: ai.spendUsd, aiUsers: ai.aiUsers, spendAvailable: ai.spendAvailable }
  }
}
