import { validateSecrets } from '../../shared/utils/validateSecrets'

// Fail-fast at boot if any critical secret is missing or too short. Runs
// right after `00-db-migrate` so a misconfigured deploy crashes visibly
// during startup instead of silently 500-ing later when a request actually
// reaches the signing/encryption path.
//
// Previous-secret variants (for dual-secret rotation per
// docs/SECRETS-ROTATION.md) are optional but length-checked when present.
//
// Prod-only checks: Gemini/STT API keys and Stripe secret are required in
// prod where the corresponding features ship. In dev + tests we skip them
// so contributors can boot without wiring up every third-party key.

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  const isProd = process.env.NODE_ENV === 'production'
  const errors = validateSecrets([
    { name: 'SESSION_PASSWORD', value: config.session?.password },
    { name: 'JWT_SECRET', value: config.jwtSecret },
    { name: 'INTERNAL_API_SECRET', value: config.internalApiSecret },
    { name: 'JWT_SECRET_PREVIOUS', value: config.jwtSecretPrevious, required: false },
    { name: 'INTERNAL_API_SECRET_PREVIOUS', value: config.internalApiSecretPrevious, required: false }
  ])

  // Valkey URL is a hard dependency on every request path that matters
  // (rate-limiting + session locks). Validate at boot rather than crashing
  // on the first rate-limit call after a user arrives.
  if (!process.env.VALKEY_URL) {
    errors.push('VALKEY_URL is not set')
  }

  // Stripe base override, when present, must be a parseable URL. Silently
  // falling back to api.stripe.com on a typo would be worse than refusing
  // to start — a dev pointing at stripe-mock with a broken URL would hit
  // real Stripe.
  const apiBase = config.stripe?.apiBase
  if (typeof apiBase === 'string' && apiBase.length > 0) {
    try {
      new URL(apiBase)
    } catch {
      errors.push(`NUXT_STRIPE_API_BASE is not a valid URL: "${apiBase}"`)
    }
  }

  if (isProd) {
    // Prod requires the external-API keys that the feature set depends on.
    // We don't length-check these (provider-defined format) — just presence.
    if (!config.google?.geminiApiKey) errors.push('NUXT_GOOGLE_GEMINI_API_KEY is not set')
    if (!config.google?.speechToTextApiKey) errors.push('NUXT_GOOGLE_SPEECH_TO_TEXT_API_KEY is not set')
    if (!config.stripe?.secretKey) errors.push('NUXT_STRIPE_SECRET_KEY is not set')
    if (!config.stripe?.webhookSecret) errors.push('NUXT_STRIPE_WEBHOOK_SECRET is not set')
  }

  if (errors.length > 0) {
    throw new Error(`[secrets] Startup validation failed:\n  - ${errors.join('\n  - ')}`)
  }
})
