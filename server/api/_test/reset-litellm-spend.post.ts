// Test-only endpoint: runs the production `resetUserKeySpend` against the
// live `litellm-test` proxy and reports what the proxy saw, so the
// integration suite can pin the `/key/{key}/reset_spend` wire contract
// (a bodyless POST is a 422 on LiteLLM v1.106).
//
// 404 unless TEST_MODE === '1'. Body: `{ userId: number }`.

import { resetUserKeySpend, getUserKeyInfo } from '../../utils/litellm/userKeys'
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
  // Make sure the key exists first (reset is a no-op without one).
  const billing = await resolveBillingContext(userId, null)
  const reset = await resetUserKeySpend(userId)
  const info = await getUserKeyInfo(userId, billing.plan)
  return { reset, spend: info.spend, maxBudget: info.maxBudget }
})
