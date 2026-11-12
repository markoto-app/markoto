import { runWebhookEventSweep } from '../utils/billing/webhookEventSweep'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { isBillingEnabled } from '../utils/billing/billingMode'
import { SWEEPS } from '../config/sweeps'

// Webhook event-table sweep. The query logic lives in
// `server/utils/billing/webhookEventSweep.ts` so tests can drive it directly.
//
// Daily. The handler's correctness doesn't depend on this sweep (the
// ON CONFLICT DO NOTHING in `processed_webhook_events` already makes replay
// short-circuit O(1) regardless of table size); it is purely a storage-cost
// guard.
//
// Stripe-dependent: with billing off there are no paid plans to lapse and no
// Stripe webhook rows to prune, so nothing is scheduled. The flag is read
// once at boot: flipping it needs a restart anyway.

export default defineSweeper({
  name: 'webhook-event-sweep',
  schedule: SWEEPS.webhookEvents,
  enabled: isBillingEnabled,
  run: runWebhookEventSweep
})
