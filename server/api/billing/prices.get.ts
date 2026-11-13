// GET /api/billing/prices: plan prices for the pricing page, in every
// currency (EUR, CHF) and interval (month, year).
//
//   - billing ON: the live Stripe prices (server/utils/billing/stripePrices.ts),
//     so the page shows exactly what Stripe charges. `source: 'stripe'`.
//   - billing OFF: the planned prices (shared/config/pricing.ts + any
//     `TIER_<PLAN>_PRICE_<CUR>[_YEAR]` override). `source: 'planned'`.
//
// PUBLIC, like /api/billing/tiers: the pricing page shows these to
// logged-out visitors. Whitelisted in server/utils/auth/publicRoutes.ts.

import { getPlanPrices } from '~~/server/utils/billing/tierConfig'
import { isBillingEnabled } from '~~/server/utils/billing/billingMode'
import { useStripeClient } from '~~/server/utils/billing/stripeClient'
import { livePlanPriceTable } from '~~/server/utils/billing/stripePrices'
import { CURRENCIES, type PlanPricesResponse } from '~~/shared/config/pricing'

export default defineApiHandler({
  access: allow.public('pricing page for logged-out visitors; plan prices are public by definition'),
  handler: async (): Promise<PlanPricesResponse> => {
    const stripe = isBillingEnabled() ? useStripeClient() : null
    if (stripe) {
      return { currencies: CURRENCIES, prices: await livePlanPriceTable(stripe), source: 'stripe' }
    }
    return { currencies: CURRENCIES, prices: getPlanPrices(), source: 'planned' }
  }
})
