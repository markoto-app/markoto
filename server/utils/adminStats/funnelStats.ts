import { acquisitionFunnel, type SourceFunnelCounts } from '../../repos/productStats'
import { landingVisits, type LandingVisitRow } from '../../repos/umamiVisits'
import type { AdminActor } from '../../repos/proofs'
import { useLogger } from '../platform/logger'
import { acquisitionTrackingEnabled } from '../analytics/acquisitionSource'
import { acquisitionSourceOf, funnelSourceOf, type FunnelSource } from '~~/shared/analytics/acquisition'
import { searchToQuery } from '~~/shared/analytics/attribution'
import { funnelRows, type FunnelRow, type FunnelStats, type StatsWindow } from '~~/shared/contracts/adminStats'
import { useEnv } from '~~/shared/env/load'

const log = useLogger('admin-stats')

// The admin's "Funnel by source" (docs/contributing/admin-metrics.md#funnel-by-source):
// documents, sign-ups, checkouts and paid accounts from the app database
// (works even where an ad blocker stopped the statistics requests), landing
// visits from Umami's database where it can be read.

type Counts = Partial<Record<FunnelSource, Partial<Omit<FunnelRow, 'source'>>>>

/** Umami's landing rows per source, classified like the browser does. */
export function visitsBySource(rows: readonly LandingVisitRow[], ownHost: string): Partial<Record<FunnelSource, number>> {
  const out: Partial<Record<FunnelSource, number>> = {}
  for (const r of rows) {
    const source = funnelSourceOf(acquisitionSourceOf({ query: searchToQuery(r.query ?? ''), referrer: r.referrerDomain ?? '', ownHost }))
    out[source] = (out[source] ?? 0) + r.visits
  }
  return out
}

/** The app database's counts per source (`direct` or an unknown value = direct). */
export function dbCountsBySource(rows: readonly SourceFunnelCounts[]): Counts {
  const out: Counts = {}
  for (const r of rows) {
    const source = funnelSourceOf(r.source)
    const c = out[source] ?? {}
    out[source] = {
      documents: (c.documents ?? 0) + r.documents,
      signups: (c.signups ?? 0) + r.signups,
      checkouts: (c.checkouts ?? 0) + r.checkouts,
      paid: (c.paid ?? 0) + r.paid
    }
  }
  return out
}

function siteHost(): string {
  const url = useEnv().core.siteUrl
  try {
    return url ? new URL(url).hostname : ''
  } catch {
    return ''
  }
}

async function readVisits(by: AdminActor, w: StatsWindow): Promise<Partial<Record<FunnelSource, number>> | null> {
  const websiteId = useEnv().analytics.websiteId
  if (!websiteId) return null
  try {
    return visitsBySource(await landingVisits(by, websiteId, w.from, w.to), siteHost())
  } catch (err) {
    log.warn('umami visits unavailable', { reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function buildFunnelStats(by: AdminActor, w: StatsWindow): Promise<FunnelStats> {
  const [db, visits] = await Promise.all([acquisitionFunnel(by, w), readVisits(by, w)])
  const counts = dbCountsBySource(db)
  if (visits) {
    for (const [source, n] of Object.entries(visits) as Array<[FunnelSource, number]>) {
      counts[source] = { ...counts[source], visits: n }
    }
  }
  const { rows, total } = funnelRows(counts, visits !== null)
  return { window: w, trackingEnabled: acquisitionTrackingEnabled(), visitsAvailable: visits !== null, rows, total }
}
