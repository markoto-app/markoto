import { checkRateLimit } from '../../../utils/rateLimit'
import { resolveBillingContext } from '../../../utils/billing'
import { saveBodySchema, saveUserProvider } from '../../../utils/aiProviders/store'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_AI_PROVIDER_SAVED } from '../../../legal/auditActions'
import { baseUrlHost, codeKey, isAiCapability } from '~~/shared/ai/providers'

// PUT /api/user/ai-providers/:capability — save (create or replace) the
// caller's provider for one capability. Order: URL policy (SSRF) →
// verification through LiteLLM (same path as real calls) → encrypt +
// store. A hard verification failure (auth / unknown model / URL /
// unreachable) is NOT saved; a soft one (`no-tool-support`) is saved and
// returned as a warning.
//
// Rate-limited: every save makes the server call the provider on the
// user's own account, so it must not become a request amplifier.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id
  const capability = getRouterParam(event, 'capability')
  if (!isAiCapability(capability)) {
    throw createError({ statusCode: 400, message: 'Unknown capability' })
  }
  if (!(await checkRateLimit('ai-provider-save', String(userId), 20, 10 * 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many attempts. Try again in a few minutes.', data: { code: 'ai-provider/rate-limited' } })
  }
  const parsed = saveBodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, message: 'Invalid provider settings', data: { code: 'ai-provider/invalid' } })
  }

  const billing = await resolveBillingContext(userId, null)
  const outcome = await saveUserProvider(userId, capability, parsed.data, billing.virtualKey)

  if (outcome.kind === 'url-refused') {
    throw createError({
      statusCode: 422,
      message: outcome.message,
      data: { code: 'ai-provider/url-refused', reason: outcome.code, messageKey: `aiProvider.urlRefused.${codeKey(outcome.code)}` }
    })
  }
  if (outcome.kind === 'key-required') {
    throw createError({
      statusCode: 400,
      message: 'Enter the API key (required when adding a provider or changing its URL).',
      data: { code: 'ai-provider/key-required', messageKey: 'aiProvider.errors.keyRequired' }
    })
  }
  if (outcome.kind === 'verify-failed') {
    throw createError({
      statusCode: 422,
      message: outcome.verify.message,
      data: { code: 'ai-provider/verify-failed', reason: outcome.verify.code, messageKey: `aiProvider.verify.${codeKey(outcome.verify.code)}` }
    })
  }

  const ip = getClientIp(event)
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: truncateIp(ip),
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_AI_PROVIDER_SAVED,
    metadata: { capability, host: baseUrlHost(outcome.view.baseUrl), model: outcome.view.model }
  })

  return { provider: outcome.view, verify: { code: outcome.verify.code, message: outcome.verify.message } }
})
