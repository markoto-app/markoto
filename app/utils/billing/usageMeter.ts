// Shared helpers for "used / limit" meters: the storage & limits section
// of the topbar usage popover and the storage bar on the profile page.

/** Human-readable byte size (B / KB / MB / GB, one decimal). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export type UsageLevel = 'ok' | 'warning' | 'critical'

export interface UsageFill {
  /** No cap (limit missing or not a finite number). The bar stays empty. */
  unlimited: boolean
  /** Used share of the limit, 0–100, rounded. */
  pct: number
  level: UsageLevel
}

/**
 * Fill state of a quota. The thresholds mirror the AI-points badge
 * (red below 10 % remaining, orange below 25 %), inverted because this
 * measures what is USED: ≥ 90 % critical, ≥ 75 % warning.
 *
 * - `limit` null / undefined / non-finite → unlimited (JSON turns
 *   `Infinity` into `null`).
 * - `limit` ≤ 0 → nothing is allowed, so the quota is full (never a
 *   division by zero).
 */
export function usageFill(used: number, limit: number | null | undefined): UsageFill {
  if (limit === null || limit === undefined || !Number.isFinite(limit)) {
    return { unlimited: true, pct: 0, level: 'ok' }
  }
  if (limit <= 0) return { unlimited: false, pct: 100, level: 'critical' }
  const pct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
  if (used >= limit || pct >= 90) return { unlimited: false, pct, level: 'critical' }
  if (pct >= 75) return { unlimited: false, pct, level: 'warning' }
  return { unlimited: false, pct, level: 'ok' }
}

/** Full-palette Tailwind classes so the JIT picks them up at build time. */
export const USAGE_LEVEL_BAR_CLASS: Record<UsageLevel, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-orange-500',
  critical: 'bg-red-500'
}
