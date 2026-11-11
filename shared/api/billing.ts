// Request schemas of the billing routes (server/api/billing/**, server/api/workspaces/[wsId]/billing/**).
import { z } from 'zod'
import { BILLING_INTERVALS, CURRENCIES, TOPUP_PACK_IDS } from '../config/pricing'

/**
 * Personal checkout. `team` / `business` parse so the handler can answer with the
 * dedicated `billing/workspace-plan` refusal. `acceptPaidTerms` is judged by the
 * handler (it runs after the price lookup, as before).
 */
export const startCheckoutBody = z.object({
  plan: z.enum(['pro', 'team', 'business']),
  interval: z.enum(BILLING_INTERVALS).default('month'),
  currency: z.enum(CURRENCIES).optional(),
  acceptPaidTerms: z.unknown().optional()
})

/** Workspace checkout. `seats` is judged lazily by `parseSeats` (only a new subscription needs it). */
export const startWorkspaceCheckoutBody = z.object({
  plan: z.enum(['team', 'business']),
  interval: z.enum(BILLING_INTERVALS).default('month'),
  currency: z.enum(CURRENCIES).optional(),
  seats: z.unknown().optional(),
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
export const memberUserParams = z.object({ userId: z.coerce.number().int().positive() })

/** `{ limitUsd: number }`, `{ limitUsd: null }` (no member limit) or `{ default: true }`; the range is checked by the handler. */
export const setMemberLimitBody = z.object({
  limitUsd: z.number().nullable().optional(),
  default: z.boolean().optional()
}).nullish()
