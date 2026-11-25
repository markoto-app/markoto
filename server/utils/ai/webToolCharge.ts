import type { H3Error } from 'h3'
import { useLitellmForUser } from './litellmClient'
import type { WebToolName } from './webTools'
import { litellmCompletion } from '../litellm/createCompletion'
import { isBudgetExceededError } from '../litellm/userKeys'
import { FEATURE_TAGS, featureMetadata } from '../litellm/featureTags'
import { MEMBER_LIMIT_REACHED_MESSAGE, TEAM_BUDGET_EXHAUSTED_MESSAGE, isWorkspaceTeamBudgetError } from '../litellm/workspaceTeams'
import { FREE_ALLOWANCE_EXHAUSTED_CODE, isFreeAllowanceExhaustedError } from '../litellm/freeTierTeam'
import { freeAllowanceExhaustedHttpError } from '../billing/freeAllowance'
import { budgetExhaustedMessage, budgetExhaustedMessageKey, limitRecovery } from '../billing/billingMode'
import { useLogger } from '../platform/logger'
import { apiError } from '../api/apiError'
import { isPlatformBilled, type ResolvedAiProvider } from '../aiProviders/resolve'
import { useEnv } from '~~/shared/env/load'

const log = useLogger('web-tools')

// Charging the web tools to the AI budget.
//
// `web_search` (Staan search) and `fetch_url` (Staan Fetch) are plain HTTP calls the
// app makes with the operator's keys, so LiteLLM never sees them. Right
// before each upstream call we send ONE completion on a billing-only tick
// model (`web-search-tick` / `web-fetch-tick`, custom_handlers.py
// `WebToolTickProvider`) with the caller's virtual key. LiteLLM then:
//   - prices the call into the key's spend (per-user `max_budget`, the
//     free-tier pool team, a Team / Business workspace team), the same
//     budget that backs "AI Points";
//   - refuses it when that budget is used up, before anything is spent
//     upstream.
// Same pattern as the live-dictation voice tick (`dictation/voiceTicks.ts`).
//
// The tick always bills the virtual key, also under BYOK: the user's own
// key pays the synthesis step, but Staan is paid by the operator.
//
// Failure policy: a budget refusal stops the call (typed 402, below).
// Anything else (proxy down, a self-hosted config without the tick
// models) is logged and the call goes ahead: still bounded by the
// per-user web-tool rate limit (`consumeWebToolQuota`). An empty
// NUXT_LITELLM_WEB_{SEARCH,FETCH}_TICK_MODEL switches charging off.

/** Who the call is charged to and how it is tagged. */
export interface WebToolChargeContext {
  workspaceId?: string | null
  userId?: number | null
  docId?: string | null
  /** The caller's LiteLLM virtual key (per-user or workspace-member key). */
  virtualKey?: string
  /** `user:<id>` or `workspace:<id>`: picks the refusal text for workspace members. */
  attributedTo?: string
  /**
   * The session's chat provider. Only read to word a refusal: with a
   * chat key of its own the session keeps working, so "add your own key"
   * would be the wrong advice.
   */
  chatProvider?: ResolvedAiProvider | null
}

/** Free pool used up while the chat itself runs on a key of its own. */
const FREE_ALLOWANCE_WEB_TOOLS_MESSAGE
  = 'This month\'s free AI allowance is used up. Web search and page fetch draw on it, so they are unavailable until it refills next month.'

/** The tick model for a web tool, or null when charging is switched off. */
export function webToolTickModel(tool: WebToolName): string | null {
  const { litellm } = useEnv()
  const model = tool === 'web_search' ? litellm.webSearchTickModel : litellm.webFetchTickModel
  const trimmed = model.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The typed error for a budget refusal of a web-tool charge, with the same
 * code and text as the other AI surfaces; null for any other error.
 *   - free-tier pool used up      → 402 `ai/free-allowance-exhausted`
 *                                   (other text when chat runs on its own key)
 *   - workspace team budget       → 402 `ai/budget-exhausted`, team text
 *   - workspace member's limit    → 402 `ai/budget-exhausted`, member text
 *   - the user's own AI Points    → 402 `ai/budget-exhausted`
 */
export function webToolBudgetRefusal(err: unknown, ctx: Pick<WebToolChargeContext, 'attributedTo' | 'chatProvider'> = {}): BudgetRefusal | null {
  if (isFreeAllowanceExhaustedError(err)) {
    const ownChatKey = ctx.chatProvider !== undefined && ctx.chatProvider !== null && !isPlatformBilled(ctx.chatProvider)
    return ownChatKey
      ? withMessage(apiError('ai/free-allowance-exhausted'), FREE_ALLOWANCE_WEB_TOOLS_MESSAGE)
      : freeAllowanceExhaustedHttpError()
  }
  const workspace = ctx.attributedTo?.startsWith('workspace:') ?? false
  if (workspace && isWorkspaceTeamBudgetError(err)) {
    return withMessage(apiError('ai/budget-exhausted'), TEAM_BUDGET_EXHAUSTED_MESSAGE)
  }
  if (!isBudgetExceededError(err)) return null
  if (workspace) return withMessage(apiError('ai/budget-exhausted'), MEMBER_LIMIT_REACHED_MESSAGE)
  return withMessage(
    apiError('ai/budget-exhausted', { messageKey: budgetExhaustedMessageKey(), recovery: limitRecovery() }),
    budgetExhaustedMessage()
  )
}

/** A 402 refusal (`apiError` or the shared free-allowance helper). */
type BudgetRefusal = H3Error | ReturnType<typeof freeAllowanceExhaustedHttpError>

/** The same code with the surface's own sentence (the model and MCP clients read `message`). */
function withMessage(error: H3Error, message: string): H3Error {
  error.message = message
  return error
}

/** Is this the 402 a refused web-tool charge throws? */
export function isWebToolBudgetRefusal(err: unknown): boolean {
  const data = (err as { data?: { code?: unknown } } | null)?.data
  const code = data?.code
  return (err as { statusCode?: unknown } | null)?.statusCode === 402
    && (code === 'ai/budget-exhausted' || code === FREE_ALLOWANCE_EXHAUSTED_CODE)
}

/**
 * Charge one web-tool call to the caller's AI budget. Throws a 402 (see
 * `webToolBudgetRefusal`) when the budget is used up; returns normally
 * otherwise, also when the charge could not be made (logged).
 */
export async function chargeWebToolCall(tool: WebToolName, ctx: WebToolChargeContext, signal?: AbortSignal): Promise<void> {
  // A key-less harness path has no budget to charge.
  if (!ctx.virtualKey) return
  const model = webToolTickModel(tool)
  if (!model) return
  try {
    await litellmCompletion(useLitellmForUser(ctx.virtualKey), {
      model,
      messages: [{ role: 'user', content: 'tick' }],
      max_tokens: 1,
      ...featureMetadata(tool === 'web_search' ? FEATURE_TAGS.webSearch : FEATURE_TAGS.webFetch, ctx)
    }, { signal })
  } catch (e) {
    if (signal?.aborted) throw e
    const refusal = webToolBudgetRefusal(e, ctx)
    if (refusal) throw refusal
    log.warn('web-tool charge failed, the call goes ahead', { tool, model, err: e })
  }
}
