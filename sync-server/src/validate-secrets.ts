import { validateSecrets } from '../../shared/utils/validateSecrets'

// Fail-fast at startup. Must be imported before ./auth and ./internal-http
// so the existence/length check runs before those modules grab their own
// process.env references. On failure we log every offending secret at once
// and exit 1 — throwing from module-top would only surface the first.

const errors = validateSecrets([
  { name: 'JWT_SECRET', value: process.env.JWT_SECRET },
  { name: 'INTERNAL_API_SECRET', value: process.env.INTERNAL_API_SECRET },
  { name: 'JWT_SECRET_PREVIOUS', value: process.env.JWT_SECRET_PREVIOUS, required: false },
  { name: 'INTERNAL_API_SECRET_PREVIOUS', value: process.env.INTERNAL_API_SECRET_PREVIOUS, required: false }
])

if (errors.length > 0) {
  console.error('[secrets] Startup validation failed:')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
