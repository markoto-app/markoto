// Error codes `billing/*`. Texts: `apiErrors.billing.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors, recoveryParam } from './define'

export const billingErrors = defineErrors('billing', {
  'admin-required': { status: 403 },
  'already-on-plan': { status: 409 },
  'cancel-failed': { status: 502 },
  'checkout-failed': { status: 502 },
  'currency-locked': { status: 409, params: z.object({ currency: z.string().optional() }) },
  'disabled': { status: 404 },
  'invalid-member-limit': { status: 400, params: z.object({ max: z.number() }) },
  'invalid-seats': { status: 400, params: z.object({ min: z.number(), max: z.number() }) },
  'member-not-found': { status: 404 },
  'no-billing-history': { status: 409 },
  'no-subscription': { status: 409 },
  'not-configured': { status: 503 },
  // `detail`: the payment provider's reason (e.g. the card was declined).
  'payment-failed': { status: 402, params: z.object({ detail: z.string().optional() }) },
  // The change waits for its payment (the bank asks the buyer to confirm,
  // or the card was declined): nothing applies until the invoice is paid.
  // `recovery`: a link to pay that invoice, when Stripe gave one.
  'payment-pending': { status: 402, params: z.object({ recovery: recoveryParam.optional() }) },
  'plan-cancelled': { status: 409 },
  'plan-change-failed': { status: 502 },
  'portal-failed': { status: 502 },
  'price-unavailable': { status: 503 },
  'rate-limited': { status: 429 },
  'seats-below-members': { status: 409, params: z.object({ used: z.number().optional() }) },
  'seats-busy': { status: 409 },
  'seats-full': { status: 409, params: z.object({ seats: z.number().optional(), used: z.number().optional() }) },
  'subscription-active': { status: 409 },
  'subscription-check-failed': { status: 502 },
  'terms-required': { status: 400 },
  'topup-needs-plan': { status: 409 },
  // Billing is on, but this deployment sells no AI credit top-ups (`NUXT_BILLING_TOPUPS_ENABLED=false`).
  'topups-disabled': { status: 404 },
  'webhook-body-empty': { status: 400 },
  'webhook-failed': { status: 500 },
  'webhook-signature-invalid': { status: 400 },
  'webhook-signature-missing': { status: 400 },
  'workspace-plan': { status: 400 }
})
