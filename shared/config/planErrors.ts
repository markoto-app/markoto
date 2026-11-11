// Stable error codes for plan limits and feature switches
// (`server/utils/billing/entitlements.ts`). Shared so the client can recognise
// them (`useErrorHandler`) without importing server code.

/** A numeric plan limit is full (members, saved presets, MCP calls, …). */
export const PLAN_LIMIT_REACHED_CODE = 'plan/limit-reached'

/** The plan doesn't include a feature switch (custom CSS, MCP write tools). */
export const PLAN_FEATURE_UNAVAILABLE_CODE = 'plan/feature-unavailable'

export function isPlanErrorCode(code: string | null | undefined): boolean {
  return code === PLAN_LIMIT_REACHED_CODE || code === PLAN_FEATURE_UNAVAILABLE_CODE
}
