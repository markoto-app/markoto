import { createError } from 'h3'
import { checkRateLimit } from './rateLimit'
import { limitRecovery } from './billingMode'

// Platform-provided web tools: `web_search` (Staan) and `fetch_url` (Jina
// Reader). The operator pays the upstream search / reader call — it never
// touches the user's LiteLLM budget, because both are plain HTTP calls made
// by the app, not LiteLLM deployments. The synthesis step that follows runs
// on the caller's chat provider (BYOK → the user's own key). Because the
// upstream half is free to the user, every call is rate-limited per user
// (shared by the in-editor loop and MCP) and the tools are only offered when
// the operator configured the upstream key.

export type WebToolName = 'web_search' | 'fetch_url'

export const WEB_TOOLS_RATE_LIMITED_CODE = 'ai/web-tools-rate-limited'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const DEFAULT_HOURLY_LIMIT = 30
const DEFAULT_DAILY_LIMIT = 100

export interface WebToolLimits {
  /** 0 = unlimited. */
  hourly: number
  /** 0 = unlimited. */
  daily: number
}

function readLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

/** Per-user limits (calls shared across `web_search` + `fetch_url`). Read per call. */
export function getWebToolLimits(): WebToolLimits {
  return {
    hourly: readLimit('NUXT_WEB_TOOLS_HOURLY_LIMIT', DEFAULT_HOURLY_LIMIT),
    daily: readLimit('NUXT_WEB_TOOLS_DAILY_LIMIT', DEFAULT_DAILY_LIMIT)
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
  return {
    search: Boolean(process.env.STAAN_API_KEY?.trim()),
    fetch: Boolean(process.env.JINA_AI_API_KEY?.trim())
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
  const { hourly, daily } = getWebToolLimits()
  const key = String(userId)
  if (hourly > 0 && !await checkRateLimit('web-tools-hour', key, hourly, HOUR_MS)) throw limitError('hourly', hourly)
  if (daily > 0 && !await checkRateLimit('web-tools-day', key, daily, DAY_MS)) throw limitError('daily', daily)
}
