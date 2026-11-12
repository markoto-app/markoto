import { resolveBillingContext } from '../../../../utils/billing/billing'
import { getAiProvider, markAiProviderVerified } from '../../../../repos/aiProviders'
import { reverifyUserProvider } from '../../../../utils/aiProviders/store'
import { aiProviderParams } from '~~/shared/api/account'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/user/ai-providers/:capability/verify — re-run the
// verification probe against the STORED config (the settings page's
// "Verify" button). Records `last_verified_at` + the tool-calling result
// on success; never deletes on failure (a transient provider outage
// shouldn't wipe the user's config).

export default defineApiHandler({
  access: allow.user(),
  params: aiProviderParams,
  invalidCode: 'ai-provider/invalid',
  body: 'none',
  // Same budget as saving: both make the server call the provider.
  rateLimit: { namespace: 'ai-provider-save', max: 20, windowMs: 10 * MINUTE_MS, key: 'user', error: 'ai-provider/rate-limited' },
  handler: async ({ user, params, self }) => {
    const userId = user.id
    const { capability } = params
    const row = await getAiProvider(userId, capability)
    if (!row) throw apiError('ai-provider/not-configured')

    const billing = await resolveBillingContext(userId, null)
    const result = await reverifyUserProvider(row, billing.virtualKey)
    if (result.ok) {
      await markAiProviderVerified(self, capability, { supportsTools: result.supportsTools, verifiedAt: new Date() })
    }
    return { ok: result.ok, code: result.code, message: result.message }
  }
})
