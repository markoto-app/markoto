import { runBillingConsistencyCheck } from '../utils/billing/billingConsistencySweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { isBillingEnabled } from '../utils/billing/billingMode'
import { SWEEPS } from '../config/sweeps'

// Daily comparison of Stripe's live subscriptions with markoto's rows
// (`server/utils/billing/billingConsistency.ts`): mismatches go to the log,
// Sentry and `NUXT_BILLING_NOTIFY_EMAIL`. Read-only. Billing on only; the
// flag is read once at boot.

export default defineSweeper({
  name: 'billing-consistency-check',
  schedule: SWEEPS.billingConsistency,
  enabled: isBillingEnabled,
  run: runBillingConsistencyCheck
})
