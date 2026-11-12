import { startWorkspaceCheckoutBody } from '~~/shared/api/billing'
import { MINUTE_MS } from '~~/shared/config/units'
import { startWorkspaceCheckout } from '../../../../utils/billing/workspaceCheckout'

// POST /api/workspaces/:wsId/billing/checkout — buy Team / Business for a
// workspace, or change the plan / billing period of its live subscription
// Workspace admins only; the caller becomes the billing admin.
//
// Body: {plan: 'team'|'business', interval?: 'month'|'year',
//        currency?: 'eur'|'chf', seats: ≥ 3 (and ≥ members + open invites)}
//
//   - no live subscription → Stripe Checkout (`mode: subscription`,
//     quantity = seats, adjustable on the Stripe page) on the workspace's
//     own customer; `client_reference_id = workspace:<id>` →
//     `{url, sessionId}`. The webhook writes plan / seats / status.
//   - live subscription → in-place price swap (Team ↔ Business, monthly ↔
//     annual), quantity kept (seat changes: `/billing/seats`) →
//     `{updated: true, plan}`; same price → 409.
// A workspace keeps one currency (its Stripe customer's): 409
// `billing/currency-locked` for the other. The purchase itself:
// `utils/billing/workspaceCheckout.ts`.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'billing/admin-required' }),
  instance: 'billing',
  body: startWorkspaceCheckoutBody,
  rateLimit: { namespace: 'billing-checkout', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: ({ event, workspaceAccess, self, body }) => startWorkspaceCheckout(event, {
    ws: workspaceAccess,
    self,
    plan: body.plan,
    interval: body.interval,
    currency: body.currency,
    seats: body.seats,
    terms: body
  })
})
