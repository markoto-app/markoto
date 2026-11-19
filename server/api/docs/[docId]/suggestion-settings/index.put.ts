import { setSuggestionPolicy } from '../../../../repos/documents'
import { appendAuditEvent } from '../../../../repos/audit'
import { AUDIT_DOC_SUGGESTION_SETTINGS_CHANGED } from '../../../../legal/auditActions'
import { notifySyncReauthDocument } from '../../../../utils/documents/syncNotify'
import { MINUTE_MS } from '~~/shared/config/units'
import { updateSuggestionSettingsBody } from '~~/shared/api/docs'
import type { SuggestionPolicy } from '~~/shared/utils/suggestions/record'

/** Changes per user per 10 minutes, a person sets these by hand. */
const SUGGESTION_SETTINGS_RATE_LIMIT = 30

// PUT /api/docs/:docId/suggestion-settings: {required, exemptRoles,
// viewersMaySuggest}, each optional. Owner and workspace admins. Free on
// every plan. Connected editors re-authenticate at once, so a supervisor
// who turns suggestion mode on doesn't wait for tokens to expire.
// Audited `doc.suggestion_settings_changed`.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'share/not-allowed' }),
  body: updateSuggestionSettingsBody,
  invalidCode: 'suggestion/invalid',
  rateLimit: { namespace: 'suggestion-settings', max: SUGGESTION_SETTINGS_RATE_LIMIT, windowMs: 10 * MINUTE_MS, key: 'user', error: 'suggestion/rate-limited' },
  handler: async ({ event, docId, doc, docAccess, body }) => {
    const before = doc.suggestionPolicy
    const next: SuggestionPolicy = {
      required: body.required ?? before.required,
      exemptRoles: [...new Set(body.exemptRoles ?? before.exemptRoles)],
      viewersMaySuggest: body.viewersMaySuggest ?? before.viewersMaySuggest
    }
    if (JSON.stringify(next) === JSON.stringify(before)) return next
    await setSuggestionPolicy(docAccess, next)
    // Every connection's write level may have changed (suggest-only or
    // not, a viewer who may now suggest): reconnect with fresh tokens.
    notifySyncReauthDocument(docId)
    await appendAuditEvent({
      by: docAccess,
      actorIp: getClientIp(event),
      scope: 'doc',
      scopeId: docId,
      workspaceId: doc.workspaceId,
      action: AUDIT_DOC_SUGGESTION_SETTINGS_CHANGED,
      before,
      after: next
    })
    return next
  }
})
