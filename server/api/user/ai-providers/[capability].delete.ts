import { deleteAiProvider } from '../../../repos/aiProviders'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_AI_PROVIDER_DELETED } from '../../../legal/auditActions'
import { isAiCapability } from '~~/shared/ai/providers'

// DELETE /api/user/ai-providers/:capability — forget the caller's
// provider (and its encrypted key) for one capability. 404 when there
// was nothing to delete.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const capability = getRouterParam(event, 'capability')
  if (!isAiCapability(capability)) {
    throw createError({ statusCode: 400, message: 'Unknown capability' })
  }
  const deleted = await deleteAiProvider(userId, capability)
  if (!deleted) throw createError({ statusCode: 404, message: 'No provider configured for this capability' })

  const ip = getClientIp(event)
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: truncateIp(ip),
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_AI_PROVIDER_DELETED,
    metadata: { capability }
  })
  return { deleted: true }
})
