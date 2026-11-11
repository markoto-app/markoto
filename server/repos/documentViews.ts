import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { documentViewDays } from '../db/schema'
import { useDatabase } from '../utils/platform/database'

// View counts of shared documents: opens per document and UTC day by
// people other than the owner and workspace members. Aggregate only.

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export async function recordDocumentOpen(docId: string, now: Date = new Date()): Promise<void> {
  await useDatabase().insert(documentViewDays)
    .values({ docId, day: utcDay(now), opens: 1 })
    .onConflictDoUpdate({ target: [documentViewDays.docId, documentViewDays.day], set: { opens: sql`${documentViewDays.opens} + 1` } })
}

export interface DocumentViews {
  /** Opens in the last `days` days (today included). */
  total: number
  /** The most recent day with an open, YYYY-MM-DD (null = none in the window). */
  lastDay: string | null
  /** Per day, oldest first, days without opens left out. */
  byDay: Array<{ day: string, opens: number }>
}

export async function documentViews(docId: string, days = 30, now: Date = new Date()): Promise<DocumentViews> {
  const since = utcDay(new Date(now.getTime() - (days - 1) * 86_400_000))
  const rows = await useDatabase().select({ day: documentViewDays.day, opens: documentViewDays.opens })
    .from(documentViewDays)
    .where(and(eq(documentViewDays.docId, docId), gte(documentViewDays.day, since)))
    .orderBy(desc(documentViewDays.day))
  return {
    total: rows.reduce((n, r) => n + r.opens, 0),
    lastDay: rows[0]?.day ?? null,
    byDay: rows.slice().reverse()
  }
}
