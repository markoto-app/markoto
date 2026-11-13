// Server-side accessor for the EFFECTIVE tier map: committed defaults
// from `shared/config/tiers.ts` with any `TIER_*` env overrides applied
// (see `resolveTiersFromEnv` there for the key shape + validation).
//
// Reads the process environment on every call (no runtime config):
// enforcement utils (knowledgeQuota, workspace caps, LiteLLM key
// budgets) run in the repos/unit test tiers OUTSIDE a Nitro context, and
// tests vary the overrides per case. Every TIER_* variable is in the env
// registry, so boot validation has already refused an invalid value.

import { resolveTiersFromEnv, type TiersMap } from '~~/shared/config/tiers'
import { resolvePlanPricesFromEnv, type PlanPriceTable } from '~~/shared/config/pricing'

export function getTiers(): TiersMap {
  return resolveTiersFromEnv()
}

/** Effective planned prices (committed defaults + `TIER_<PLAN>_PRICE_<CUR>[_YEAR]`). */
export function getPlanPrices(): PlanPriceTable {
  return resolvePlanPricesFromEnv()
}
