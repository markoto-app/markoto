import { validateSecrets } from '../../shared/utils/security/validateSecrets'
import { isBillingEnabled } from '../utils/billing/billingMode'
import { stripeStartupErrors } from '../utils/billing/stripeStartupCheck'
import { oidcRedirectErrors, resolveOidcSettings } from '../utils/oidc/settings'
import { byokUrlPolicyErrors } from '../utils/aiProviders/config'
import { legalSurfacesEnabled } from '../utils/platform/instanceConfig'
import { legalEntityErrors } from '../../shared/legal/entity'
import { isTestModeEnabled, testModeBootError } from '../../shared/utils/security/testMode'
import { siteUrlErrors } from '../utils/platform/siteUrl'
import { anonGateEnabled } from '../utils/anonGate/gate'
import { publishPagesErrors } from '../utils/publish/pagesHost'

// Fail-fast at boot if any critical config is missing or malformed. Runs
// right after `00-db-migrate` so a misconfigured deploy crashes visibly
// during startup instead of silently 500-ing later when a request actually
// reaches the signing/encryption/upload/AI path.
//
// Policy: dev and prod enforce the same surface. We do NOT silently boot
// with degraded features (no AI, no uploads, broken sync, half-wired OAuth).
// The only escape is `TEST_MODE=1`, which the integration suite sets so the
// stubbed fixtures don't need to wire up every third-party key.
//
// `*_PREVIOUS` rotation variants stay optional but length-checked when set.

type RuntimeCfg = ReturnType<typeof useRuntimeConfig>

export default defineNitroPlugin(() => {
  // `bun run build` boots Nitro in prerender mode (PWA workbox needs `/`
  // pre-rendered), which fires every plugin against runtimeConfig defaults
  // (empty strings). The validator runs at every real container start; the
  // build-time pass has nothing to validate.
  if (import.meta.prerender) return
  // A stray TEST_MODE=1 on a real deployment would expose the test login
  // shim; refuse to boot instead of silently ignoring it.
  const testModeError = testModeBootError()
  if (testModeError) throw new Error(`[secrets] ${testModeError}`)
  if (isTestModeEnabled()) return

  const config = useRuntimeConfig()
  const errors: string[] = []

  errors.push(...validateSecrets([
    { name: 'NUXT_SESSION_PASSWORD', value: config.session?.password },
    { name: 'NUXT_JWT_SECRET', value: config.jwtSecret },
    { name: 'NUXT_INTERNAL_API_SECRET', value: config.internalApiSecret },
    { name: 'NUXT_JWT_SECRET_PREVIOUS', value: config.jwtSecretPrevious, required: false },
    { name: 'NUXT_INTERNAL_API_SECRET_PREVIOUS', value: config.internalApiSecretPrevious, required: false },
    // Imports, knowledge uploads and design extraction all go through
    // markitdown (NUXT_MARKITDOWN_URL is required below), which refuses
    // every unauthenticated request, so a missing secret is a broken
    // deploy rather than a disabled feature.
    { name: 'NUXT_MARKITDOWN_API_SECRET', value: process.env.NUXT_MARKITDOWN_API_SECRET?.trim() },
    // Anonymous gate (ALTCHA bot check + remembered-terms cookie): the key
    // is only needed while the gate is on, but then it must be real.
    { name: 'NUXT_ALTCHA_HMAC_KEY', value: process.env.NUXT_ALTCHA_HMAC_KEY, required: anonGateEnabled() }
  ]))
  checkPresenceFields(config, errors)
  checkOAuthPairs(config, errors)
  // Generic OIDC (WP7b): issuer + id + secret all-or-nothing, https
  // issuer, parseable redirect URL. See server/utils/oidc/settings.ts.
  const oidc = resolveOidcSettings(process.env)
  errors.push(...oidc.errors)
  errors.push(...oidcRedirectErrors(oidc.settings, config.siteUrl))
  // BYOK provider URLs: the hosted shape must run with an allowlist.
  errors.push(...byokUrlPolicyErrors(process.env, legalSurfacesEnabled()))
  if (legalSurfacesEnabled()) errors.push(...legalEntityErrors(process.env))
  // Published pages: their own hostname, required for the hosted shape.
  errors.push(...publishPagesErrors(process.env, legalSurfacesEnabled()))
  checkUrlFields(config, errors)
  errors.push(...siteUrlErrors(config.siteUrl, process.env.NODE_ENV === 'production'))
  // Stripe is only validated when billing is switched on. With
  // NUXT_BILLING_ENABLED unset/false (self-hosted + free-only SaaS) no
  // code path touches Stripe, so requiring its secrets would just block
  // boot. With billing ON the check below is exactly as strict as before.
  errors.push(...stripeStartupErrors(config.stripe, {
    billingEnabled: isBillingEnabled(),
    isProduction: process.env.NODE_ENV === 'production'
  }))

  if (errors.length > 0) {
    throw new Error(`[secrets] Startup validation failed:\n  - ${errors.join('\n  - ')}`)
  }
})

/**
 * Bare presence checks — third-party formats vary, we only verify that
 * a human filled the slot. `process.env` for vars consumed outside the
 * runtimeConfig graph (POSTGRES_*, VALKEY_*); `config.*` for the rest.
 * Postgres + Valkey are atomic parts (user/password/host/port/db) so
 * `.env` never has to carry a composed URL alongside the parts that
 * built it; `shared/utils/runtime/connectionStrings.ts` owns the construction.
 */
function checkPresenceFields(config: RuntimeCfg, errors: string[]): void {
  const fields: Array<{ name: string, value: unknown }> = [
    { name: 'POSTGRES_USER', value: process.env.POSTGRES_USER },
    { name: 'POSTGRES_PASSWORD', value: process.env.POSTGRES_PASSWORD },
    { name: 'POSTGRES_HOST', value: process.env.POSTGRES_HOST },
    { name: 'POSTGRES_PORT', value: process.env.POSTGRES_PORT },
    { name: 'POSTGRES_DB', value: process.env.POSTGRES_DB },
    { name: 'VALKEY_HOST', value: process.env.VALKEY_HOST },
    { name: 'VALKEY_PORT', value: process.env.VALKEY_PORT },
    { name: 'NUXT_S3_ENDPOINT', value: config.s3?.endpoint },
    { name: 'NUXT_S3_ACCESS_KEY', value: config.s3?.accessKey },
    { name: 'NUXT_S3_SECRET_KEY', value: config.s3?.secretKey },
    { name: 'NUXT_S3_BUCKET', value: config.s3?.bucket },
    { name: 'NUXT_MARKITDOWN_URL', value: config.markitdownUrl },
    { name: 'NUXT_SYNC_INTERNAL_URL', value: config.syncInternalUrl },
    { name: 'NUXT_PUBLIC_SYNC_URL', value: config.public?.syncUrl },
    { name: 'NUXT_LITELLM_URL', value: config.litellm?.url },
    { name: 'NUXT_LITELLM_MASTER_KEY', value: config.litellm?.masterKey }
  ]
  for (const { name, value } of fields) {
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${name} is not set`)
    }
  }
}

/**
 * OAuth: pair-validate per provider. Login is optional (anonymous
 * editing is a first-class flow), so a fully-empty pair is allowed.
 * But a partial pair — id without secret, or vice versa — silently
 * bricks the OAuth callback later, which is exactly the degraded-
 * feature failure mode we're closing. Force both-or-neither.
 */
function checkOAuthPairs(config: RuntimeCfg, errors: string[]): void {
  for (const provider of ['github', 'google'] as const) {
    const id = config.oauth?.[provider]?.clientId
    const secret = config.oauth?.[provider]?.clientSecret
    const hasId = typeof id === 'string' && id.length > 0
    const hasSecret = typeof secret === 'string' && secret.length > 0
    if (hasId === hasSecret) continue
    const upper = provider.toUpperCase()
    errors.push(
      `NUXT_OAUTH_${upper}_CLIENT_ID and NUXT_OAUTH_${upper}_CLIENT_SECRET must be set together (got: id=${hasId ? 'set' : 'empty'}, secret=${hasSecret ? 'set' : 'empty'})`
    )
  }
}

/**
 * URL fields must parse — typos that fall back to defaults are worse
 * than a hard crash. `NUXT_PUBLIC_SYNC_URL` is a ws(s):// URL;
 * everything else is http(s)://.
 *
 * Empty strings are skipped (already flagged by checkPresenceFields).
 */
function checkUrlFields(config: RuntimeCfg, errors: string[]): void {
  const urlChecks: Array<{ name: string, value: unknown, schemes: string[] }> = [
    { name: 'NUXT_S3_ENDPOINT', value: config.s3?.endpoint, schemes: ['http:', 'https:'] },
    // Optional (empty skipped): browser-facing base URL for presigned S3 URLs.
    { name: 'NUXT_S3_PUBLIC_ENDPOINT', value: config.s3?.publicEndpoint, schemes: ['http:', 'https:'] },
    { name: 'NUXT_MARKITDOWN_URL', value: config.markitdownUrl, schemes: ['http:', 'https:'] },
    { name: 'NUXT_SYNC_INTERNAL_URL', value: config.syncInternalUrl, schemes: ['http:', 'https:'] },
    { name: 'NUXT_PUBLIC_SYNC_URL', value: config.public?.syncUrl, schemes: ['ws:', 'wss:'] },
    { name: 'NUXT_LITELLM_URL', value: config.litellm?.url, schemes: ['http:', 'https:'] }
  ]
  for (const { name, value, schemes } of urlChecks) {
    if (typeof value !== 'string' || value.length === 0) continue
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      errors.push(`${name} is not a valid URL: "${value}"`)
      continue
    }
    if (!schemes.includes(parsed.protocol)) {
      errors.push(`${name} must use ${schemes.join(' or ')} (got "${parsed.protocol}")`)
    }
  }
}
