import { backfillSubscriptionCancelDates } from '../utils/billing/subscriptionCancelBackfill'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { isBillingEnabled } from '../utils/billing/billingMode'
import { SWEEPS } from '../config/sweeps'

// Fills in the end date of cancelled subscriptions whose rows no Stripe
// event has written (`server/utils/billing/subscriptionCancelBackfill.ts`).
// Billing on only; the flag is read once at boot.

export default defineSweeper({
  name: 'subscription-cancel-backfill',
  schedule: SWEEPS.subscriptionCancelBackfill,
  enabled: isBillingEnabled,
  run: backfillSubscriptionCancelDates
})
