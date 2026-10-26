import { checkRateLimit } from '../../../../utils/rateLimit'
import { resolveBillingContext } from '../../../../utils/billing'
import { getAiProvider, markAiProviderVerified } from '../../../../repos/aiProviders'
import { reverifyUserProvider } from '../../../../utils/aiProviders/store'
import { isAiCapability } from '~~/shared/ai/providers'

// POST /api/user/ai-providers/:capability/verify — re-run the
// verification probe against the STORED config (the settings page's
// "Verify" button). Records `last_verified_at` + the tool-calling result
// on success; never deletes on failure (a transient provider outage
// shouldn't wipe the user's config).

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
  const row = await getAiProvider(userId, capability)
  if (!row) throw createError({ statusCode: 404, message: 'No provider configured for this capability' })

  const billing = await resolveBillingContext(userId, null)
  const result = await reverifyUserProvider(row, billing.virtualKey)
  if (result.ok) {
    await markAiProviderVerified(userId, capability, { supportsTools: result.supportsTools, verifiedAt: new Date() })
  }
  return { ok: result.ok, code: result.code, message: result.message }
})
