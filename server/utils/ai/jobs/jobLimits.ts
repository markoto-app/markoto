import { countAiJobsSince } from '../../../repos/aiJobs'
import type { UserScope } from '../../../repos/proofs'
import { capsFor, planLimitError } from '../../billing/entitlements'
import type { PlanName } from '~~/shared/config/tiers'
import { DAY_MS } from '~~/shared/config/units'

// Plan caps of delegated AI jobs (`shared/config/tiers.ts`): units per job
// and jobs per user per day. The committed defaults have no limit
// (self-host); markoto.app's free tier sets them through `TIER_FREE_*`.
// Everything else is enforced by the AI budget of the user's LiteLLM key.

/**
 * Refuse a job the plan does not cover: 409 `plan/limit-reached` with the
 * field (`aiJobUnitsPerJob` / `aiJobsPerDay`). `units` is the number of
 * worker calls of the job; the daily count includes every job started in
 * the last 24 hours.
 */
export async function assertJobAllowed(self: UserScope, plan: PlanName, units: number, now: Date = new Date()): Promise<void> {
  const caps = capsFor(plan)
  if (caps.aiJobUnitsPerJob !== null && units > caps.aiJobUnitsPerJob) {
    throw planLimitError(plan, 'aiJobUnitsPerJob', caps.aiJobUnitsPerJob, `This job has ${units} parts; your plan allows ${caps.aiJobUnitsPerJob} per job. Choose fewer sections.`)
  }
  if (caps.aiJobsPerDay !== null) {
    const started = await countAiJobsSince(self, new Date(now.getTime() - DAY_MS))
    if (started >= caps.aiJobsPerDay) {
      throw planLimitError(plan, 'aiJobsPerDay', caps.aiJobsPerDay, `You have started ${started} AI jobs in the last 24 hours, the limit of your plan.`)
    }
  }
}
