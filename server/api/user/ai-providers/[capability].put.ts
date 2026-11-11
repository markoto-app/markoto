import { resolveBillingContext } from '../../../utils/billing/billing'
import { saveUserProvider } from '../../../utils/aiProviders/store'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_AI_PROVIDER_SAVED } from '../../../legal/auditActions'
import { baseUrlHost, codeKey } from '~~/shared/ai/providers'
import { aiProviderParams, saveAiProviderBody } from '~~/shared/api/account'
import { MINUTE_MS } from '~~/shared/config/units'

// PUT /api/user/ai-providers/:capability — save (create or replace) the
// caller's provider for one capability. Order: URL policy (SSRF) →
// verification through LiteLLM (same path as real calls) → encrypt +
// store. A hard verification failure (auth / unknown model / URL /
// unreachable) is NOT saved; a soft one (`no-tool-support`) is saved and
// returned as a warning.
//
// Rate-limited: every save makes the server call the provider on the
// user's own account, so it must not become a request amplifier (the
// verify route shares the budget).

export default defineApiHandler({
  access: allow.user(),
  // Sensitive action: needs a recent sign-in (401 auth/reauth-required).
  recentLogin: true,
  params: aiProviderParams,
  body: saveAiProviderBody,
  invalidCode: 'ai-provider/invalid',
  rateLimit: { namespace: 'ai-provider-save', max: 20, windowMs: 10 * MINUTE_MS, key: 'user', error: 'ai-provider/rate-limited' },
  handler: async ({ event, user, params, body }) => {
    const userId = user.id
    const { capability } = params

    const billing = await resolveBillingContext(userId, null)
    const outcome = await saveUserProvider(userId, capability, body, billing.virtualKey)

    // The refusal sentences are fixed, key-free texts of the provider layer
    // (`providerErrorMessage`, never upstream text); they stay the message.
    if (outcome.kind === 'url-refused') {
      throw Object.assign(
        apiError('ai-provider/url-refused', { reason: outcome.code, messageKey: `aiProvider.urlRefused.${codeKey(outcome.code)}` }),
        { message: outcome.message }
      )
    }
    if (outcome.kind === 'key-required') {
      throw apiError('ai-provider/key-required')
    }
    if (outcome.kind === 'verify-failed') {
      throw Object.assign(
        apiError('ai-provider/verify-failed', { reason: outcome.verify.code, messageKey: `aiProvider.verify.${codeKey(outcome.verify.code)}` }),
        { message: outcome.verify.message }
      )
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
  }
})
