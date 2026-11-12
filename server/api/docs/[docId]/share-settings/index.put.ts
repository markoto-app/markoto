import { SHARE_EXPIRY_MAX_DAYS } from '../../../../utils/access/shareSettings'
import { setShareSettings } from '../../../../repos/documents'
import { appendAuditEvent } from '../../../../repos/audit'
import { assertPlanFeature, resolveDocPlanFor } from '../../../../utils/billing/entitlements'
import { AUDIT_DOC_SHARE_SETTINGS_CHANGED } from '../../../../legal/auditActions'
import { notifySyncReauthDocument } from '../../../../utils/documents/syncNotify'
import { MINUTE_MS, DAY_MS } from '~~/shared/config/units'
import { updateShareSettingsBody } from '~~/shared/api/docs'

/** Changes per user per 10 minutes, a person sets these by hand. */
const SHARE_SETTINGS_RATE_LIMIT = 30

// PUT /api/docs/:docId/share-settings: {expiresAt: ISO | null, noDownload:
// boolean}. Owner and workspace admins. Setting an expiry or
// view-only needs the plan feature `shareControls`; clearing them always
// works (also after a downgrade, settings already in force stay in force,
// they only restrict). Audited `doc.share_settings_changed`.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'share/not-allowed' }),
  body: updateShareSettingsBody,
  invalidCode: 'share/invalid',
  rateLimit: { namespace: 'share-settings', max: SHARE_SETTINGS_RATE_LIMIT, windowMs: 10 * MINUTE_MS, key: 'user', error: 'share/rate-limited' },
  handler: async ({ event, docId, doc, docAccess, body }) => {
    let expiresAt: Date | null = doc.shareExpiresAt
    if (body?.expiresAt !== undefined) {
      expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt)
      if (expiresAt && expiresAt.getTime() <= Date.now()) throw apiError('share/expiry-past', { field: 'expiresAt' })
      if (expiresAt && expiresAt.getTime() > Date.now() + SHARE_EXPIRY_MAX_DAYS * DAY_MS) {
        throw apiError('share/expiry-too-far', { field: 'expiresAt', maxDays: SHARE_EXPIRY_MAX_DAYS })
      }
    }
    const noDownload = body?.noDownload ?? doc.shareNoDownload

    // New restrictions need the plan; clearing never does.
    const adds = (expiresAt !== null && expiresAt.getTime() !== doc.shareExpiresAt?.getTime()) || (noDownload && !doc.shareNoDownload)
    if (adds) assertPlanFeature(await resolveDocPlanFor(doc), 'shareControls', 'Link expiry and view-only sharing are part of the paid plans.')

    await setShareSettings(docAccess, { shareExpiresAt: expiresAt, shareNoDownload: noDownload })
    // An earlier expiry or view-only applies to visitors already in the
    // editor too: they re-authenticate and get a token (and download
    // rights) matching the new settings.
    if (tightensShareLink(doc, expiresAt, noDownload)) notifySyncReauthDocument(docId)
    if (expiresAt?.getTime() !== doc.shareExpiresAt?.getTime() || noDownload !== doc.shareNoDownload) {
      await appendAuditEvent({
        by: docAccess,
        actorIp: getClientIp(event),
        scope: 'doc',
        scopeId: docId,
        workspaceId: doc.workspaceId,
        action: AUDIT_DOC_SHARE_SETTINGS_CHANGED,
        before: { expiresAt: doc.shareExpiresAt?.toISOString() ?? null, noDownload: doc.shareNoDownload },
        after: { expiresAt: expiresAt?.toISOString() ?? null, noDownload }
      })
    }
    return { expiresAt: expiresAt?.toISOString() ?? null, noDownload }
  }
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
