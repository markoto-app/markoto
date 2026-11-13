import type { Rule } from '../define'
import type { AppEnv } from '../namespaces'

export const billingRules: Rule<AppEnv>[] = [
  {
    services: ['app'],
    relaxedInTestMode: true,
    vars: ['NUXT_BILLING_ENABLED', 'NUXT_STRIPE_SECRET_KEY', 'NUXT_STRIPE_WEBHOOK_SECRET'],
    doc: 'Billing on in production needs the Stripe secret key and webhook secret.',
    check: (env, ctx) => {
      if (!env.billing.enabled || !ctx.production) return []
      const errors: string[] = []
      if (!env.billing.stripeSecretKey) errors.push('NUXT_STRIPE_SECRET_KEY is required when NUXT_BILLING_ENABLED=true in production')
      if (!env.billing.stripeWebhookSecret) errors.push('NUXT_STRIPE_WEBHOOK_SECRET is required when NUXT_BILLING_ENABLED=true in production')
      return errors
    }
  }
]
