// Request schemas of the billing routes (server/api/billing/**, server/api/workspaces/[wsId]/billing/**).
import { z } from 'zod'
import { serialId } from './ids'
import { BILLING_INTERVALS, CURRENCIES, TOPUP_PACK_IDS } from '../config/pricing'

/**
 * Who buys, for the sales-region rule (`shared/config/salesRegions.ts`):
 * the country the buyer picked (absent = the IP country) and whether they
 * buy for a company with a VAT / tax ID (Checkout then requires the ID).
 */
const checkoutBuyer = {
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  business: z.boolean().optional()
}

/**
 * Personal checkout. `team` / `business` parse so the handler can answer with the
 * dedicated `billing/workspace-plan` refusal. `acceptPaidTerms` is judged by the
 * handler (it runs after the price lookup, as before). Without `interval` a
 * live subscription keeps its billing period; a new one is monthly.
 */
export const startCheckoutBody = z.object({
  plan: z.enum(['pro', 'team', 'business']),
  interval: z.enum(BILLING_INTERVALS).optional(),
  currency: z.enum(CURRENCIES).optional(),
  ...checkoutBuyer,
  acceptPaidTerms: z.unknown().optional()
})

/**
 * Workspace checkout. `seats` is judged lazily by `parseSeats` (only a new subscription needs it).
 * A change of a live subscription names only what changes: without `plan` it keeps its plan,
 * without `interval` its billing period. A new subscription needs `plan` and is monthly by default.
 */
export const startWorkspaceCheckoutBody = z.object({
  plan: z.enum(['team', 'business']).optional(),
  interval: z.enum(BILLING_INTERVALS).optional(),
  currency: z.enum(CURRENCIES).optional(),
  seats: z.unknown().optional(),
  ...checkoutBuyer,
  acceptPaidTerms: z.unknown().optional()
})

/** Personal AI-credit top-up. */
export const buyTopupBody = z.object({
  pack: z.enum(TOPUP_PACK_IDS),
  currency: z.enum(CURRENCIES).optional(),
  acceptPaidTerms: z.unknown().optional()
})

/** Workspace AI-credit top-up (paid in the workspace's currency). */
export const buyWorkspaceTopupBody = z.object({
  pack: z.enum(TOPUP_PACK_IDS),
  acceptPaidTerms: z.unknown().optional()
})

/** POST /api/workspaces/:wsId/billing/seats. A missing body answers `billing/invalid-seats` like a bad number. */
export const changeSeatsBody = z.object({ seats: z.unknown().optional() }).nullish()

/** PATCH …/billing/members/:userId. */
export const memberUserParams = z.object({ userId: serialId })

/**
 * `{ limitUsd: number }`, `{ limitUsd: null }` (no member limit) or `{ default: true }`;
 * the range is checked by the handler. A wrongly typed field reads as absent, so
 * the handler answers `billing/invalid-member-limit` (with the maximum) for it.
 */
export const setMemberLimitBody = z.object({
  limitUsd: z.number().nullable().optional().catch(undefined),
  default: z.boolean().optional().catch(undefined)
}).nullish()
