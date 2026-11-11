import { and, isNull, lt, lte, or } from 'drizzle-orm'
import { documents } from '../../db/schema'
import { useDatabase } from '../platform/database'

// Candidate query for the inactive-doc sweep (server/plugins/inactive-doc-sweep.ts).
//
// An anonymous document (no owner, no workspace) is deleted once it has
// had no activity for `ttlDays` (NUXT_INACTIVE_DOC_TTL_DAYS, default 30 —
// the period the Terms and the privacy policy state) AND its
// `sweep_not_before` floor, if any, has passed. The floor was set by
// migration 0024 on the anonymous docs that existed when the period went
// from 180 to 30 days, so none of them is deleted without a full 30-day
// window after the change (or earlier than the old 180-day rule).
//
// Owned and workspace docs are never candidates.

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse NUXT_INACTIVE_DOC_TTL_DAYS: a positive integer, else 0 (= sweep off). */
export function parseInactiveDocTtlDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : 0
}

export async function loadInactiveAnonymousDocs(
  ttlDays: number,
  now: Date = new Date()
): Promise<Array<{ docId: string }>> {
  if (ttlDays <= 0) return []
  const cutoff = new Date(now.getTime() - ttlDays * DAY_MS)
  return useDatabase()
    .select({ docId: documents.docId })
    .from(documents)
    .where(and(
      isNull(documents.ownerId),
      isNull(documents.workspaceId),
      lt(documents.lastActive, cutoff),
      or(isNull(documents.sweepNotBefore), lte(documents.sweepNotBefore, now))
    ))
}
