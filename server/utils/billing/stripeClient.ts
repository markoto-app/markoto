import Stripe from 'stripe'
import { STRIPE_API_VERSION } from '~~/shared/contracts/stripe'
import { useEnv } from '~~/shared/env/load'

// Stripe SDK singleton. One client per process; constructed lazily so
// tests that never touch Stripe don't pay for it, and so a test-mode
// override of `env.billing.stripeApiBase` (pointing at stripe-mock) is
// picked up correctly when the first caller shows up.
//
// Why a singleton: Stripe's SDK is cheap to construct but holds an
// internal HTTP agent + retry config. Re-creating it per request
// would drop connection pooling and recompute the idempotency-key
// retry map. One instance, module-level.
//
// Why the apiBase override: in integration tests we point at the
// `stripe-mock` container so `stripe.subscriptions.create(...)` etc.
// hit a local fixture server that speaks Stripe's wire protocol. In
// prod, `apiBase` is empty and the SDK defaults to api.stripe.com.

let client: Stripe | null = null

/**
 * Resolve the configured Stripe client. Returns `null` when
 * `secretKey` is missing (dev without env vars), callers MUST check
 * for null and fail with a clear error, not silently skip the call.
 *
 * Prod deployments set `secretKey` + `webhookSecret` + three price
 * IDs via `NUXT_STRIPE_*` env vars; a fail-fast check in the
 * webhook-handler / checkout-endpoint validates the full set at
 * first-use so misconfiguration surfaces immediately (not hours later
 * when a user tries to check out).
 */
// Stripe API version is centralised in `shared/contracts/stripe.ts`
// so every consumer (this client, the dispatcher, test fixtures) pins
// to the same wire shape. See that file for upgrade-guide notes.

export function useStripeClient(): Stripe | null {
  if (client) return client
  const env = useEnv()
  const secret = env.billing.stripeSecretKey
  if (!secret) return null
  client = new Stripe(secret, {
    // Cast required because the SDK constructor types `apiVersion` as
    // a literal-union of the SDK's "preferred" version, but we
    // INTENTIONALLY pin an older version (`STRIPE_API_VERSION` in
    // `shared/contracts/stripe.ts`): see that file for the upgrade
    // playbook. The cast routes around the SDK's narrower type to
    // honor our explicit pin.
    apiVersion: STRIPE_API_VERSION as NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion'],
    // Override the API base URL when pointed at `stripe-mock`. Stripe's
    // SDK requires both `host` (hostname) and `port` + `protocol`
    // separately. Do the parsing here so callers only need one env var.
    ...buildHostOverride(env.billing.stripeApiBase || '')
  })
  return client
}

/**
 * Parse `apiBase` (e.g. `http://stripe-mock:12111`) into the Stripe
 * SDK's `{host, port, protocol}` shape. Empty input → no override,
 * SDK defaults to api.stripe.com.
 *
 * Invalid non-empty URLs throw, the secrets-validation plugin catches
 * them at boot, so reaching this function with a malformed value means
 * someone bypassed the validator.
 */
export function buildHostOverride(apiBase: string): Partial<NonNullable<ConstructorParameters<typeof Stripe>[1]>> {
  if (!apiBase) return {}
  const u = new URL(apiBase)
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol.replace(':', '') as 'http' | 'https'
  }
}
