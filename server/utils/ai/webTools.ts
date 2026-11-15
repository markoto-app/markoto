import { createError } from 'h3'
import { checkRateLimit } from '../platform/rateLimit'
import { limitRecovery } from '../billing/billingMode'
import { capsFor, resolveUserPlan } from '../billing/entitlements'
import { DAY_MS, HOUR_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'

// Platform-provided web tools: `web_search` (Staan) and `fetch_url` (Jina
// Reader). The operator's key pays the upstream search / reader call, a
// plain HTTP call made by the app; each call is charged to the caller's AI
// budget through a tick model first (`webToolCharge.ts`). The synthesis
// step that follows runs on the caller's chat provider (BYOK → the user's
// own key). Every call is also rate-limited per user (shared by the
// in-editor loop and MCP), checked before the charge, and the tools are
// only offered when the operator configured the upstream key.

export type WebToolName = 'web_search' | 'fetch_url'

export const WEB_TOOLS_RATE_LIMITED_CODE = 'ai/web-tools-rate-limited'

export interface WebToolLimits {
  /** 0 = unlimited. */
  hourly: number
  /** 0 = unlimited. */
  daily: number
}

/**
 * Per-user limits (calls shared across `web_search` + `fetch_url`). Read
 * per call. The operator ceiling comes from env; `planDailyLimit` (the
 * plan's `webToolsPerDay`, `null` = no plan limit) narrows the daily
 * window further: the stricter of the two wins.
 */
export function getWebToolLimits(planDailyLimit: number | null = null): WebToolLimits {
  const { providers } = useEnv()
  const operatorDaily = providers.webToolsDailyLimit
  const daily = planDailyLimit === null
    ? operatorDaily
    : operatorDaily === 0 ? planDailyLimit : Math.min(operatorDaily, planDailyLimit)
  return {
    hourly: providers.webToolsHourlyLimit,
    daily
  }
}

export interface WebToolAvailability {
  /** `STAAN_API_KEY` is set on the app. */
  search: boolean
  /** `JINA_AI_API_KEY` is set on the app. */
  fetch: boolean
}

/** Which web tools the operator has upstream keys for. Read per call. */
export function getWebToolAvailability(): WebToolAvailability {
  const { providers } = useEnv()
  return {
    search: Boolean(providers.staanApiKey),
    fetch: Boolean(providers.jinaApiKey)
  }
}

export function isWebToolAvailable(tool: WebToolName): boolean {
  const a = getWebToolAvailability()
  return tool === 'web_search' ? a.search : a.fetch
}

function limitError(window: 'hourly' | 'daily', max: number) {
  const messageKey = window === 'hourly' ? 'ai.webToolsHourlyLimit' : 'ai.webToolsDailyLimit'
  const when = window === 'hourly' ? 'within the next hour' : 'within the next 24 hours'
  return createError({
    statusCode: 429,
    message: `Web search / page fetch limit reached (${max} per ${window === 'hourly' ? 'hour' : 'day'}). Try again ${when}, or continue without web tools.`,
    data: { code: WEB_TOOLS_RATE_LIMITED_CODE, messageKey, window, limit: max, recovery: limitRecovery() }
  })
}

/**
 * Count one web-tool call against the user's hourly + daily allowance.
 * Throws a 429 `ai/web-tools-rate-limited` when either window is full.
 * Fails OPEN on Valkey errors and is bypassed under `TEST_MODE=1` (both via
 * `checkRateLimit`). A null `userId` (key-less harness path) is not limited.
 */
export async function consumeWebToolQuota(userId: number | null | undefined): Promise<void> {
  if (userId === null || userId === undefined) return
  const { hourly, daily } = getWebToolLimits(capsFor(await resolveUserPlan(userId)).webToolsPerDay)
  const key = String(userId)
  if (hourly > 0 && !await checkRateLimit('web-tools-hour', key, hourly, HOUR_MS)) throw limitError('hourly', hourly)
  if (daily > 0 && !await checkRateLimit('web-tools-day', key, daily, DAY_MS)) throw limitError('daily', daily)
}
