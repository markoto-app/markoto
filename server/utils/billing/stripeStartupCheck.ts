// Boot-time Stripe configuration check, called from
// `server/plugins/01-validate-secrets.ts`. Pure (inputs in, error
// strings out) so `tests/unit/billing/stripeStartupCheck.test.ts` can pin the
// billing-mode gating without a Nitro context.
//
// Billing OFF (NUXT_BILLING_ENABLED unset/false — self-hosted and the
// free-only SaaS): no code path touches Stripe, so nothing is required
// and nothing is checked. A deployment can boot with zero STRIPE_* vars.
//
// Billing ON:
//   - an `apiBase` override, when present, must parse as a URL (silently
//     falling back to api.stripe.com on a typo would point a stripe-mock
//     setup at real Stripe);
//   - in production the secret key + webhook secret are required.

export interface StripeStartupConfig {
  secretKey?: string
  webhookSecret?: string
  apiBase?: string
}

export function stripeStartupErrors(
  stripe: StripeStartupConfig | undefined,
  opts: { billingEnabled: boolean, isProduction: boolean }
): string[] {
  if (!opts.billingEnabled) return []
  const errors: string[] = []
  const apiBase = stripe?.apiBase
  if (typeof apiBase === 'string' && apiBase.length > 0) {
    try {
      new URL(apiBase)
    } catch {
      errors.push(`NUXT_STRIPE_API_BASE is not a valid URL: "${apiBase}"`)
    }
  }
  if (opts.isProduction) {
    if (!stripe?.secretKey) errors.push('NUXT_STRIPE_SECRET_KEY is not set')
    if (!stripe?.webhookSecret) errors.push('NUXT_STRIPE_WEBHOOK_SECRET is not set')
  }
  return errors
}
