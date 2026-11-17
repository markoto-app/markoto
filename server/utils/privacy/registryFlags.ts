import type { RegistryFlags } from '../../legal/registryView'
import { isBillingEnabled } from '../billing/billingMode'
import { useEnv } from '~~/shared/env/load'

/** This deployment's registry flags (server/legal/registryView.ts). */
export function currentRegistryFlags(): RegistryFlags {
  const { analytics } = useEnv()
  return {
    billing: isBillingEnabled(),
    analytics: Boolean(analytics.websiteId),
    adsConversions: analytics.adsConversions
  }
}
