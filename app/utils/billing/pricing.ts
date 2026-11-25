import { GIB, MIB } from '~~/shared/config/units'
import { BILLING_INTERVALS, CURRENCIES, type BillingInterval, type Currency } from '~~/shared/config/pricing'
import { MAX_WORKSPACE_SEATS, MIN_WORKSPACE_SEATS } from '~~/shared/config/workspaceSeats'

// Formatting for the pricing page (cards + comparison table).

/** Plan-cap byte size: whole MB, or GB with at most one decimal. */
export function formatPlanBytes(bytes: number): string {
  if (bytes >= GIB) {
    const gb = bytes / GIB
    return `${Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1)} GB`
  }
  return `${Math.round(bytes / MIB)} MB`
}

/** A monthly price in the page's currency, no decimals for whole amounts. */
export function formatPrice(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2
  }).format(amount)
}

/** A count in the reader's number format (1,000 / 1.000 / 1 000). */
export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** What a visitor picked on the pricing page: billing period, currency, the Teams card's plan and seats. */
export interface PricingSelection {
  interval: BillingInterval
  currency: Currency
  teamPlan: 'team' | 'business'
  seats: number
}

const TEAM_PLANS = ['team', 'business'] as const

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined
}

/**
 * The selection a pricing link carries (`/pricing?interval=year&currency=chf&plan=business&seats=5`,
 * e.g. the page to return to after signing in). Missing or invalid values
 * are left out, so the page keeps its own default for them.
 */
export function pricingSelectionFromQuery(query: Record<string, unknown>): Partial<PricingSelection> {
  const selection: Partial<PricingSelection> = {}
  const interval = oneOf(query.interval, BILLING_INTERVALS)
  if (interval) selection.interval = interval
  const currency = oneOf(query.currency, CURRENCIES)
  if (currency) selection.currency = currency
  const teamPlan = oneOf(query.plan, TEAM_PLANS)
  if (teamPlan) selection.teamPlan = teamPlan
  const seats = typeof query.seats === 'string' && /^\d{1,4}$/.test(query.seats) ? Number(query.seats) : Number.NaN
  if (seats >= MIN_WORKSPACE_SEATS && seats <= MAX_WORKSPACE_SEATS) selection.seats = seats
  return selection
}

/** The query that restores `selection`; values equal to `defaults` are left out, so the plain page keeps a clean URL. */
function pricingSelectionQuery(selection: PricingSelection, defaults: PricingSelection): Record<string, string> {
  const query: Record<string, string> = {}
  if (selection.interval !== defaults.interval) query.interval = selection.interval
  if (selection.currency !== defaults.currency) query.currency = selection.currency
  if (selection.teamPlan !== defaults.teamPlan) query.plan = selection.teamPlan
  if (selection.seats !== defaults.seats) query.seats = String(selection.seats)
  return query
}

/** The pricing page at `path` (`/pricing`, `/de/pricing`) with `selection` in its query. */
export function pricingPathFor(path: string, selection: PricingSelection, defaults: PricingSelection): string {
  const query = new URLSearchParams(pricingSelectionQuery(selection, defaults)).toString()
  return query ? `${path}?${query}` : path
}

/** The query keys a pricing link may carry (`pricingSelectionFromQuery`). */
export const PRICING_SELECTION_KEYS = ['interval', 'currency', 'plan', 'seats'] as const
