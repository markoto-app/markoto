// HTTP-facing helpers for the shared monthly free-tier AI pool
// (`litellm/freeTierTeam.ts`). The proxy is the gate; these only turn its
// state into typed errors and UI data.

import type { PlanName } from '~~/shared/config/tiers'
import type { LimitRecovery } from './billingMode'
import { isPlatformBilled, type ResolvedAiProvider } from './aiProviders/resolve'
import {
  FREE_ALLOWANCE_EXHAUSTED_CODE,
  FREE_ALLOWANCE_EXHAUSTED_MESSAGE,
  FREE_ALLOWANCE_EXHAUSTED_MESSAGE_KEY,
  getFreeTierPoolStatus,
  teamIdForPlan
} from './litellm/freeTierTeam'

/** "Add your own key" — the only way past an exhausted pool until the reset. */
export const FREE_ALLOWANCE_RECOVERY: LimitRecovery = {
  kind: 'link',
  href: '/settings/ai',
  labelKey: 'ai.freeAllowanceCta'
}

/** 402 `ai/free-allowance-exhausted` (distinct from the per-user `ai/budget-exhausted`). */
export function freeAllowanceExhaustedHttpError() {
  return createError({
    statusCode: 402,
    message: FREE_ALLOWANCE_EXHAUSTED_MESSAGE,
    data: {
      code: FREE_ALLOWANCE_EXHAUSTED_CODE,
      messageKey: FREE_ALLOWANCE_EXHAUSTED_MESSAGE_KEY,
      recovery: FREE_ALLOWANCE_RECOVERY
    }
  })
}

/**
 * Refuse an AI request up front when it would run on the platform-paid
 * default AND the user's key is in the exhausted pool. A user on their
 * own key (BYOK) is never refused here. Fails open when the pool can't be
 * read — the proxy still refuses, and the loop maps that to the same text.
 */
export async function assertFreeAllowanceAvailable(chatProvider: ResolvedAiProvider | null, plan: PlanName): Promise<void> {
  if (!isPlatformBilled(chatProvider)) return
  if (teamIdForPlan(plan) === null) return
  const pool = await getFreeTierPoolStatus()
  if (pool?.exhausted) throw freeAllowanceExhaustedHttpError()
}

export interface FreeAllowanceView {
  /** The user's platform-paid AI draws on the shared monthly pool. */
  pooled: boolean
  exhausted: boolean
  resetsAt: string | null
}

/** Pool state for `/api/ai/credits`; null when the user's plan isn't pooled. */
export async function freeAllowanceView(plan: PlanName): Promise<FreeAllowanceView | null> {
  if (teamIdForPlan(plan) === null) return null
  const pool = await getFreeTierPoolStatus()
  return { pooled: true, exhausted: pool?.exhausted ?? false, resetsAt: pool?.resetsAt ?? null }
}
