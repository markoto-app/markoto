// GET /api/billing/prices — monthly plan prices for the pricing page
// (committed defaults + any TIER_<PLAN>_PRICE_USD override).
//
// PUBLIC, like /api/billing/tiers: the pricing page shows these to
// logged-out visitors. Served whatever the billing mode — with plans
// "coming soon" the page shows them as planned prices. Whitelisted in
// server/middleware/auth.ts.

import { getPlanPrices } from '~~/server/utils/tierConfig'
import { PRICE_CURRENCY, type PlanPricesResponse } from '~~/shared/config/pricing'

export default defineEventHandler((): PlanPricesResponse => {
  return { currency: PRICE_CURRENCY, monthly: getPlanPrices() }
})
