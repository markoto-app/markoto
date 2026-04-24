import Stripe from 'stripe'

// Stripe SDK singleton. One client per process; constructed lazily so
// tests that never touch Stripe don't pay for it, and so a test-mode
// override of `config.stripe.apiBase` (pointing at stripe-mock) is
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
 * `secretKey` is missing (dev without env vars) — callers MUST check
 * for null and fail with a clear error, not silently skip the call.
 *
 * Prod deployments set `secretKey` + `webhookSecret` + three price
 * IDs via `NUXT_STRIPE_*` env vars; a fail-fast check in the
 * webhook-handler / checkout-endpoint validates the full set at
 * first-use so misconfiguration surfaces immediately (not hours later
 * when a user tries to check out).
 */
export function useStripeClient(): Stripe | null {
  if (client) return client
  const config = useRuntimeConfig()
  const secret = config.stripe.secretKey
  if (!secret) return null
  client = new Stripe(secret, {
    // Override the API base URL when pointed at `stripe-mock`. Stripe's
    // SDK requires both `host` (hostname) and `port` + `protocol`
    // separately. Do the parsing here so callers only need one env var.
    ...buildHostOverride(config.stripe.apiBase || '')
  })
  return client
}

/**
 * Parse `apiBase` (e.g. `http://stripe-mock:12111`) into the Stripe
 * SDK's `{host, port, protocol}` shape. Empty input → no override,
 * SDK defaults to api.stripe.com.
 *
 * Exported for unit testing — has enough branches (empty, malformed,
 * default port, explicit port, http vs https) that a direct test
 * pins them clearly.
 */
export function buildHostOverride(apiBase: string): Partial<Stripe.StripeConfig> {
  if (!apiBase) return {}
  try {
    const u = new URL(apiBase)
    return {
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      protocol: u.protocol.replace(':', '') as 'http' | 'https'
    }
  } catch (e) {
    console.warn(`[stripe] invalid NUXT_STRIPE_API_BASE="${apiBase}":`, e)
    return {}
  }
}

/**
 * Reset the cached client — for tests that change the apiBase
 * between cases. Not used in production.
 */
export function resetStripeClient(): void {
  client = null
}
