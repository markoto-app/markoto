import { GIB, MIB } from '~~/shared/config/units'

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
