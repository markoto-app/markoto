import { migrationsComplete } from '../utils/platform/migrations'
import { runCustomDomainRecheck } from '../utils/customDomains/recheck'
import { customDomainSettings, traefikProviderSettings } from '../utils/customDomains/config'
import { acquireSweepLock, releaseSweepLock } from '../utils/platform/sweepLock'

// Every 15 min: DNS re-check of custom domains (WP13) — logic in
// `server/utils/customDomains/recheck.ts`. Not started on instances
// without custom domains (`NUXT_PUBLISH_DOMAINS_TARGET` unset).

const SWEEP_INTERVAL_MS = 15 * 60 * 1000

async function lockedRun(): Promise<void> {
  if (!await acquireSweepLock('custom-domain-recheck')) return
  try {
    await runCustomDomainRecheck()
  } catch (e) {
    console.warn('[custom-domain-recheck] failed:', e instanceof Error ? e.message : e)
  } finally {
    await releaseSweepLock('custom-domain-recheck')
  }
}

export default defineNitroPlugin((nitroApp) => {
  if (!customDomainSettings()) return
  if (!traefikProviderSettings()) {
    // Users could add and verify domains that Traefik is never told about.
    console.warn('[custom-domains] NUXT_PUBLISH_DOMAINS_TARGET is set but NUXT_PUBLISH_TRAEFIK_TOKEN is missing or shorter than 32 characters: verified domains will not be routed.')
  }
  void (async () => {
    await migrationsComplete
    await lockedRun()
  })()
  const timer = setInterval(() => {
    void lockedRun()
  }, SWEEP_INTERVAL_MS)
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
