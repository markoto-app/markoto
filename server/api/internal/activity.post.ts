import { eq, sql } from 'drizzle-orm'
import { activityLog, documents } from '../../db/schema'
import { matchesCurrentOrPrevious } from '../../../shared/utils/secrets'

// Internal endpoint called by the sync-server to log user activity.
// Auth: shared secret header X-Internal-Secret (must match INTERNAL_API_SECRET env var).
// Never exposed publicly — public routes whitelist excludes /api/internal/*.

const MAX_ACTIVITY_ENTRIES_PER_DOC = 500

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const providedSecret = getRequestHeader(event, 'x-internal-secret')

  if (!config.internalApiSecret) {
    throw createError({ statusCode: 500, message: 'Internal API secret not configured' })
  }
  if (!providedSecret || !matchesCurrentOrPrevious(
    providedSecret,
    config.internalApiSecret,
    config.internalApiSecretPrevious || undefined
  )) {
    throw createError({ statusCode: 401, message: 'Invalid internal secret' })
  }

  const body = await readBody(event) as {
    docId?: string
    userName?: string | null
    action?: 'edit' | 'join' | 'leave'
    wordCount?: number | null
    linesAdded?: number | null
    linesRemoved?: number | null
  }

  if (!body.docId || typeof body.docId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing docId' })
  }
  if (!body.action || !['edit', 'join', 'leave'].includes(body.action)) {
    throw createError({ statusCode: 400, message: 'Invalid action' })
  }

  const db = useDatabase()

  // Only log activity for documents that exist in the DB.
  // Anonymous/direct-URL docs without a DB row are skipped.
  const doc = (await db.select({ docId: documents.docId }).from(documents).where(eq(documents.docId, body.docId)).limit(1))[0]
  if (!doc) return { success: true, logged: false }

  await db.insert(activityLog).values({
    docId: body.docId,
    userName: body.userName || null,
    action: body.action,
    wordCount: typeof body.wordCount === 'number' ? Math.round(body.wordCount) : null,
    linesAdded: typeof body.linesAdded === 'number' ? Math.max(0, Math.round(body.linesAdded)) : null,
    linesRemoved: typeof body.linesRemoved === 'number' ? Math.max(0, Math.round(body.linesRemoved)) : null
  })

  // Edit events bump `lastActive`, which the inactive-doc sweep reads. Without
  // this, a document actively being edited but never hitting `meta.put` would
  // age out at the TTL and get reaped. Non-edit actions (join/leave) don't
  // count — a passive viewer shouldn't keep an abandoned doc alive.
  if (body.action === 'edit') {
    await db.update(documents)
      .set({ lastActive: new Date() })
      .where(eq(documents.docId, body.docId))
  }

  // Cap the log: keep only the latest N entries per document to prevent unbounded growth.
  // Postgres returns count(*) as a string (bigint) for sql<number>`count(*)` so we cast
  // explicitly to ::int and coerce the result through Number() for safety.
  const excess = (await db.select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(eq(activityLog.docId, body.docId)))[0]

  if (excess && Number(excess.count) > MAX_ACTIVITY_ENTRIES_PER_DOC) {
    // Delete everything older than the most recent MAX entries
    const cutoff = (await db.select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.docId, body.docId))
      .orderBy(sql`${activityLog.id} DESC`)
      .limit(1)
      .offset(MAX_ACTIVITY_ENTRIES_PER_DOC - 1))[0]
    if (cutoff) {
      await db.delete(activityLog)
        .where(sql`${activityLog.docId} = ${body.docId} AND ${activityLog.id} < ${cutoff.id}`)
    }
  }

  return { success: true, logged: true }
})
