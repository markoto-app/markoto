// Server-side accessor for the EFFECTIVE tier map: committed defaults
// from `shared/config/tiers.ts` with any `TIER_*` env overrides applied
// (see `resolveTiersFromEnv` there for the key shape + validation).
//
// Deliberately reads `process.env` instead of `useRuntimeConfig()`:
// enforcement utils (knowledgeQuota, workspace caps, LiteLLM key
// budgets) are exercised by the repos/unit test tiers OUTSIDE a Nitro
// context, where runtime config doesn't exist. Env is re-read on every
// call — 20 lookups is negligible and it keeps tests free to vary env
// per case.

import { resolveTiersFromEnv, type TiersMap } from '~~/shared/config/tiers'

export function getTiers(): TiersMap {
  return resolveTiersFromEnv(process.env)
}
