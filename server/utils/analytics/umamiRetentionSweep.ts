import { deleteUmamiDataBefore } from '../../repos/umamiRetention'
import { system } from '../../repos/proofs'
import { useEnv } from '~~/shared/env/load'
import { DAY_MS } from '~~/shared/config/units'

// Daily: deletes Umami events and sessions older than
// NUXT_ANALYTICS_RETENTION_DAYS (13 months), the retention the privacy
// policy states. Runs only where analytics is configured.

export function analyticsEnabled(): boolean {
  return Boolean(useEnv().analytics.websiteId)
}

export async function runUmamiRetentionSweep(now: Date = new Date()): Promise<Record<string, number> | undefined> {
  const cutoff = new Date(now.getTime() - useEnv().analytics.retentionDays * DAY_MS)
  const deleted = await deleteUmamiDataBefore(system('analytics-retention-sweep'), cutoff)
  return Object.keys(deleted).length > 0 ? deleted : undefined
}
