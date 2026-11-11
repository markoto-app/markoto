// GET /api/billing/tiers — the resolved tier-cap map (committed
// defaults + any TIER_* env overrides).
//
// PUBLIC: the pricing page renders these caps for logged-out visitors,
// so the values are public by definition. Read-only, no per-user data.
// Whitelisted in server/middleware/auth.ts.

import { getTiers } from '~~/server/utils/billing/tierConfig'

export default defineEventHandler(() => {
  return getTiers()
})
