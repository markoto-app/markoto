/**
 * `GET /api/billing/buyer-location`: the buyer's country as the server sees
 * it (IP country from the bundled database) and the sales-region lists, so
 * the page can tell a buyer before Checkout that their region can't buy yet
 * (`shared/config/salesRegions.ts`). `active: false` when no list is set or
 * Stripe Tax is off: nothing to show.
 */
export type BuyerLocationResponse
  = | { active: false }
    | {
      active: true
      country: string | null
      b2cAllowed: string[]
      b2bAllowed: string[]
      blocked: string[]
    }
