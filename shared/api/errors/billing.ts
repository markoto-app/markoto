// Error codes `billing/*`. Texts: `apiErrors.billing.<slug>` in i18n/locales/errors/<locale>.json.
import { z } from 'zod'
import { defineErrors } from './define'

export const billingErrors = defineErrors('billing', {
  'admin-required': { status: 403 },
  'cancel-failed': { status: 502 },
  'currency-locked': { status: 409, params: z.object({ currency: z.string().optional() }) },
  'disabled': { status: 404 },
  'invalid-member-limit': { status: 400, params: z.object({ max: z.number() }) },
  'invalid-seats': { status: 400, params: z.object({ min: z.number(), max: z.number() }) },
  'no-subscription': { status: 409 },
  'payment-failed': { status: 402 },
  'rate-limited': { status: 429 },
  'seats-below-members': { status: 409, params: z.object({ used: z.number().optional() }) },
  'seats-busy': { status: 409 },
  'seats-full': { status: 409, params: z.object({ seats: z.number().optional(), used: z.number().optional() }) },
  'subscription-active': { status: 409 },
  'terms-required': { status: 400 },
  'topup-needs-plan': { status: 409 },
  'workspace-plan': { status: 400 }
})
