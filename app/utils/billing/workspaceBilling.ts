// Client shapes + pure helpers for Team / Business workspace billing.

import type { BillingInterval, Currency, PaidPlanName } from '~~/shared/config/pricing'

/** `workspace.billing` of `GET /api/workspaces/:wsId` (admins only). */
export interface WorkspaceSeatBilling {
  seats: number
  seatsUsed: number
  status: string
  plan: Extract<PaidPlanName, 'team' | 'business'>
  interval: BillingInterval
  currency: Currency
}

/** `GET /api/workspaces/:wsId/billing`. */
export interface WorkspaceBillingOverview {
  billingEnabled: boolean
  minSeats: number
  seatsUsed: number
  isBillingAdmin: boolean
  subscription: {
    plan: 'team' | 'business'
    seats: number
    status: string
    entitled: boolean
    interval: BillingInterval
    currency: Currency
    currentPeriodStart: string | null
    validUntil: string | null
    billingAdminId: number | null
  } | null
  pool: {
    aiBudgetUsd: number
    aiSpendUsd: number | null
    defaultMemberLimitUsd: number
    knowledgeBytes: number
    imageBytes: number
    resetsAt: string | null
  } | null
  members: Array<{
    userId: number
    name: string | null
    role: 'admin' | 'editor' | 'viewer'
    limitUsd: number | null
    limitIsDefault: boolean
    unlimited: boolean
    spendUsd: number | null
  }>
  /** AI credit top-ups; null with billing off. */
  credits?: import('~/utils/billing/aiCredits').CreditBalanceView | null
}

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
