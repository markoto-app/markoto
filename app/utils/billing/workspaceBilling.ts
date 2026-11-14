// Client shapes + pure helpers for Team / Business workspace billing.

import { dollarsToPoints } from '~~/shared/billing/aiPoints'
import type { ApiResponse } from '~/utils/api/client'

/** `workspace.billing` of `GET /api/workspaces/:wsId` (admins only). */
export type WorkspaceSeatBilling = NonNullable<ApiResponse<'/api/workspaces/:wsId', 'get'>['workspace']['billing']>

/** `GET /api/workspaces/:wsId/billing`. */
export type WorkspaceBillingOverview = ApiResponse<'/api/workspaces/:wsId/billing', 'get'>

/** Statuses where Stripe is still trying to collect: admins see a notice. */
export function isPaymentProblem(status: string | null | undefined): boolean {
  return status === 'past_due' || status === 'unpaid'
}

/** Smallest seat count the admin may buy now. */
export function minimumSeats(minSeats: number, seatsUsed: number): number {
  return Math.max(minSeats, seatsUsed)
}

/**
 * A budget the server keeps in USD, as the AI Points the UI shows
 * ("1,250"). Users never see dollars: 1000 points = $1.
 */
export function formatAiPoints(usd: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(dollarsToPoints(usd))
}
