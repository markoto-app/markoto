// Test-only endpoint that drains a user's LiteLLM virtual-key budget
// so the next AI call surfaces a budget_exceeded error from the proxy.
// Drives `tests/e2e/flows/ai-budget-exhausted.spec.ts` and the
// integration tests pinned at the post-Phase-6 wire-path.
//
// 404 in any environment where TEST_MODE !== '1' so an accidentally-set
// env var on a prod box still doesn't expose the surface.
//
// Body: `{ userId: number }`. The endpoint:
//   1. Lazy-creates the user's virtual key (or reuses the existing one).
//   2. Calls LiteLLM /key/update with `max_budget = 0.0` — every
//      subsequent call against this key will return a 400 with
//      `budget_exceeded` in the body, which our `isBudgetExceededError`
//      predicate translates to `LitellmBudgetExhausted`.
//
// We don't try to read current spend + match it: the proxy-side gate
// trips on `spend >= max_budget`, so 0.0 always works whether the key
// has already been used or not.

import { setUserKeyMaxBudget } from '../../utils/litellm/userKeys'
import { resolveBillingContext } from '../../utils/billing/billing'
import { isTestModeEnabled } from '../../../shared/utils/testMode'

export default defineEventHandler(async (event) => {
  if (!isTestModeEnabled()) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  const body = await readBody<{ userId?: unknown }>(event)
  const userId = typeof body?.userId === 'number' ? body.userId : null
  if (!userId || !Number.isInteger(userId) || userId <= 0) {
    throw createError({ statusCode: 400, message: 'userId required (positive integer)' })
  }

  // Resolve billing context so the key exists with the right plan budget
  // before we slam it. Workspace context is null — exhausting the user's
  // own key is the test contract; (+) sponsorship would need a separate
  // endpoint that targets `users.id` of the sponsor.
  const billing = await resolveBillingContext(userId, null)

  await setUserKeyMaxBudget(userId, billing.plan, 0)

  return { ok: true, userId, plan: billing.plan, maxBudget: 0 }
})
