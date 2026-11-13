// Test-only: drains a user's LiteLLM virtual-key budget so the next AI call
// surfaces a budget_exceeded error from the proxy (used by the
// ai-budget-exhausted flow and integration tests).
//
// 404 unless TEST_MODE === '1' so a stray env var on a prod box exposes nothing.
//
// Body: `{ userId: number }`. Lazily creates the user's virtual key, then sets
// `max_budget = 0.0` via LiteLLM /key/update. The proxy trips on
// `spend >= max_budget`, so 0.0 works whether or not the key was already used;
// `isBudgetExceededError` maps the resulting 400 to `LitellmBudgetExhausted`.

import { setUserKeyMaxBudget } from '../../utils/litellm/userKeys'
import { resolveBillingContext } from '../../utils/billing/billing'
import { testUserBody } from '~~/shared/api/platform'

export default defineApiHandler({
  access: allow.testOnly(),
  body: testUserBody,
  handler: async ({ body }) => {
    const { userId } = body

    // Resolve billing context so the key exists with the right plan budget
    // first. Workspace context is null: the test exhausts the user's own key.
    const billing = await resolveBillingContext(userId, null)

    await setUserKeyMaxBudget(userId, billing.plan, 0)

    return { ok: true, userId, plan: billing.plan, maxBudget: 0 }
  }
})
