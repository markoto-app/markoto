// Client shapes + pure helpers for Team / Business workspace billing.

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

/** USD amount for the usage table, e.g. "$3.20". */
export function formatUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
}
