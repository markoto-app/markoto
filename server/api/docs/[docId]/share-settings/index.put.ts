import { requireShareManager, SHARE_EXPIRY_MAX_DAYS } from '../../../../utils/documents/shareSettings'
import { getDocWithActorRole, setShareSettings } from '../../../../repos/documents'
import { appendAuditEvent } from '../../../../repos/audit'
import { assertPlanFeature, resolveDocPlanFor } from '../../../../utils/billing/entitlements'
import { AUDIT_DOC_SHARE_SETTINGS_CHANGED } from '../../../../legal/auditActions'
import { notifySyncReauthDocument } from '../../../../utils/documents/syncNotify'

// An ISO 8601 date-time with a zone (what the client sends: toISOString()).
/** Changes per user per 10 minutes — a person sets these by hand. */
export const SHARE_SETTINGS_RATE_LIMIT = 30

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

// PUT /api/docs/:docId/share-settings — {expiresAt: ISO | null, noDownload:
// boolean} (WP9). Owner and workspace admins. Setting an expiry or
// view-only needs the plan feature `shareControls`; clearing them always
// works (also after a downgrade — settings already in force stay in force,
// they only restrict). Audited `doc.share_settings_changed`.
export default defineEventHandler(async (event) => {
  const { userId, docId, doc } = await requireShareManager(event)
  if (!(await checkRateLimit('share-settings', String(userId), SHARE_SETTINGS_RATE_LIMIT, 10 * 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many changes. Try again in a few minutes.', data: { code: 'share/rate-limited', messageKey: 'error.rateLimited' } })
  }
  const body = await readBody<{ expiresAt?: unknown, noDownload?: unknown }>(event)
  const before = (await getDocWithActorRole(docId, userId))!

  let expiresAt: Date | null = before.shareExpiresAt
  if (body?.expiresAt !== undefined) {
    if (body.expiresAt === null) {
      expiresAt = null
    } else if (typeof body.expiresAt === 'string' && ISO_DATE_TIME.test(body.expiresAt) && Number.isFinite(Date.parse(body.expiresAt))) {
      expiresAt = new Date(body.expiresAt)
      if (expiresAt.getTime() <= Date.now()) {
        throw createError({ statusCode: 400, message: 'The expiry must be in the future.', data: { code: 'share/invalid', field: 'expiresAt' } })
      }
      if (expiresAt.getTime() > Date.now() + SHARE_EXPIRY_MAX_DAYS * 86_400_000) {
        throw createError({ statusCode: 400, message: `The expiry can be at most ${SHARE_EXPIRY_MAX_DAYS} days away.`, data: { code: 'share/invalid', field: 'expiresAt' } })
      }
    } else {
      throw createError({ statusCode: 400, message: 'expiresAt must be a date or null.', data: { code: 'share/invalid', field: 'expiresAt' } })
    }
  }
  let noDownload = before.shareNoDownload
  if (body?.noDownload !== undefined) {
    if (typeof body.noDownload !== 'boolean') throw createError({ statusCode: 400, message: 'noDownload must be true or false.', data: { code: 'share/invalid', field: 'noDownload' } })
    noDownload = body.noDownload
  }

  // New restrictions need the plan; clearing never does.
  const adds = (expiresAt !== null && expiresAt.getTime() !== before.shareExpiresAt?.getTime()) || (noDownload && !before.shareNoDownload)
  if (adds) assertPlanFeature(await resolveDocPlanFor(doc), 'shareControls', 'Link expiry and view-only sharing are part of the paid plans.')

  await setShareSettings(docId, { shareExpiresAt: expiresAt, shareNoDownload: noDownload })
  // An earlier expiry or view-only applies to visitors already in the
  // editor too: they re-authenticate and get a token (and download
  // rights) matching the new settings.
  if (tightensShareLink(before, expiresAt, noDownload)) notifySyncReauthDocument(docId)
  if (expiresAt?.getTime() !== before.shareExpiresAt?.getTime() || noDownload !== before.shareNoDownload) {
    await appendAuditEvent({
      actorUserId: userId,
      actorIp: getClientIp(event),
      scope: 'doc',
      scopeId: docId,
      workspaceId: doc.workspaceId,
      action: AUDIT_DOC_SHARE_SETTINGS_CHANGED,
      before: { expiresAt: before.shareExpiresAt?.toISOString() ?? null, noDownload: before.shareNoDownload },
      after: { expiresAt: expiresAt?.toISOString() ?? null, noDownload }
    })
  }
  return { expiresAt: expiresAt?.toISOString() ?? null, noDownload }
})

function tightensShareLink(
  before: { shareExpiresAt: Date | null, shareNoDownload: boolean },
  expiresAt: Date | null,
  noDownload: boolean
): boolean {
  const earlierExpiry = expiresAt !== null
    && (before.shareExpiresAt === null || expiresAt.getTime() < before.shareExpiresAt.getTime())
  return earlierExpiry || (noDownload && !before.shareNoDownload)
}
