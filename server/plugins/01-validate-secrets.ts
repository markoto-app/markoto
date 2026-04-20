import { validateSecrets } from '../../shared/utils/validateSecrets'

// Fail-fast at boot if any critical secret is missing or too short. Runs
// right after `00-db-migrate` so a misconfigured deploy crashes visibly
// during startup instead of silently 500-ing later when a request actually
// reaches the signing/encryption path.
//
// Previous-secret variants (for dual-secret rotation per
// docs/SECRETS-ROTATION.md) are optional but length-checked when present.

export default defineNitroPlugin(() => {
  const config = useRuntimeConfig()
  const errors = validateSecrets([
    { name: 'SESSION_PASSWORD', value: config.session?.password },
    { name: 'JWT_SECRET', value: config.jwtSecret },
    { name: 'INTERNAL_API_SECRET', value: config.internalApiSecret },
    { name: 'JWT_SECRET_PREVIOUS', value: config.jwtSecretPrevious, required: false },
    { name: 'INTERNAL_API_SECRET_PREVIOUS', value: config.internalApiSecretPrevious, required: false }
  ])

  if (errors.length > 0) {
    throw new Error(`[secrets] Startup validation failed:\n  - ${errors.join('\n  - ')}`)
  }
})
