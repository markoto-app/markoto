import { matchesCurrentOrPrevious } from '../../../shared/utils/secrets'
import { docExists, bumpLastActive } from '../../repos/documents'
import { appendActivity, pruneActivity } from '../../repos/activity'

// Internal endpoint called by the sync-server to log user activity.
// Auth: shared secret header X-Internal-Secret (must match INTERNAL_API_SECRET env var).
// Never exposed publicly — public routes whitelist excludes /api/internal/*.

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

  // Only log activity for documents that exist in the DB.
  // Anonymous/direct-URL docs without a DB row are skipped.
  if (!(await docExists(body.docId))) {
    return { success: true, logged: false }
  }

  await appendActivity({
    docId: body.docId,
    userName: body.userName || null,
    action: body.action,
    wordCount: body.wordCount ?? null,
    linesAdded: body.linesAdded ?? null,
    linesRemoved: body.linesRemoved ?? null
  })

  // Edit events bump `lastActive`, which the inactive-doc sweep reads.
  // Without this, a document actively being edited but never hitting
  // `meta.put` would age out at the TTL and get reaped. Non-edit actions
  // (join/leave) don't count — a passive viewer shouldn't keep an
  // abandoned doc alive.
  if (body.action === 'edit') {
    await bumpLastActive(body.docId)
  }

  // Cap the log at MAX_ENTRIES_PER_DOC so edit-heavy docs don't grow
  // unbounded. Cheap (one count + one targeted delete) per append.
  await pruneActivity(body.docId)

  return { success: true, logged: true }
})
