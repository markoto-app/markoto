import { deleteAiProvider } from '../../../repos/aiProviders'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_AI_PROVIDER_DELETED } from '../../../legal/auditActions'
import { aiProviderParams } from '~~/shared/api/account'

// DELETE /api/user/ai-providers/:capability — forget the caller's
// provider (and its encrypted key) for one capability. 404 when there
// was nothing to delete.

export default defineApiHandler({
  access: allow.user(),
  // Sensitive action: needs a recent sign-in (401 auth/reauth-required).
  recentLogin: true,
  params: aiProviderParams,
  invalidCode: 'ai-provider/invalid',
  handler: async ({ event, user, params, self }) => {
    const userId = user.id
    const { capability } = params
    const deleted = await deleteAiProvider(self, capability)
    if (!deleted) throw apiError('ai-provider/not-configured')

    const ip = getClientIp(event)
    await appendAuditEvent({
      by: self,
      actorIp: truncateIp(ip),
      scope: 'user',
      scopeId: String(userId),
      action: AUDIT_AI_PROVIDER_DELETED,
      metadata: { capability }
    })
    return { deleted: true }
  }
})
