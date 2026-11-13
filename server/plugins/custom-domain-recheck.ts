import { runCustomDomainRecheck } from '../utils/customDomains/recheck'
import { customDomainSettings, traefikProviderSettings } from '../utils/customDomains/config'
import { defineSweeper } from '../utils/platform/defineSweeper'
import { SWEEPS } from '../config/sweeps'
import { useLogger } from '../utils/platform/logger'

const log = useLogger('custom-domain-recheck')

// Every 15 min: DNS re-check of custom domains. Logic in
// `server/utils/customDomains/recheck.ts`. Not started on instances
// without custom domains (`NUXT_PUBLISH_DOMAINS_TARGET` unset).

export default defineSweeper({
  name: 'custom-domain-recheck',
  schedule: SWEEPS.customDomainRecheck,
  enabled: () => Boolean(customDomainSettings()),
  setup: () => {
    if (!traefikProviderSettings()) {
      // Users could add and verify domains that Traefik is never told about.
      log.warn('NUXT_PUBLISH_DOMAINS_TARGET is set but NUXT_PUBLISH_TRAEFIK_TOKEN is missing or shorter than 32 characters: verified domains will not be routed')
    }
  },
  // DNS lookups fail for reasons that are not ours; logged, not paged.
  reportErrors: false,
  run: runCustomDomainRecheck
})
