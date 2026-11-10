import { customDomainSettings } from './config'
import { runCustomDomainCheck } from './manage'
import { listCustomDomainsToRecheck } from '../../repos/customDomains'

// Periodic DNS re-check of custom domains (WP13), run by the
// `custom-domain-recheck` plugin: pending / failed domains added in the
// last 7 days (so a user doesn't have to come back and click "Check"),
// and verified domains every 6 hours (a domain whose DNS moved away is
// dropped after the grace period — `runCustomDomainCheck`).

const PENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const VERIFIED_EVERY_MS = 6 * 60 * 60 * 1000
const BATCH = 200

export async function runCustomDomainRecheck(now = Date.now()): Promise<{ checked: number }> {
  const settings = customDomainSettings()
  if (!settings) return { checked: 0 }
  const due = await listCustomDomainsToRecheck({
    pendingNewerThan: new Date(now - PENDING_WINDOW_MS),
    verifiedCheckedBefore: new Date(now - VERIFIED_EVERY_MS),
    limit: BATCH
  })
  for (const domain of due) {
    try {
      await runCustomDomainCheck(domain, settings)
    } catch (e) {
      console.warn(`[custom-domain-recheck] ${domain.hostname}:`, e instanceof Error ? e.message : e)
    }
  }
  return { checked: due.length }
}
