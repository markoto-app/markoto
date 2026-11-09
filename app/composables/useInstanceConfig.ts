import {
  MINIMAL_INSTANCE_CONFIG,
  loginPath,
  resolveInstanceConfig,
  type InstanceConfig
} from '~~/shared/config/instance'

/**
 * The instance shape on the client (see `shared/config/instance.ts`):
 * which OAuth login providers are configured, whether the legal
 * surfaces (onboarding gate, consent banner, DPA step, /legal/* pages)
 * are on, whether this is the hosted marketing site, and the SEO
 * origins (site URL, docs canonical base).
 *
 * Resolved ONCE on the server from the same env vars the server-side
 * guards read, and shipped through the SSR payload (`useState`) — the
 * same pattern as `useBillingMode()`. `app/plugins/instance-config.ts`
 * touches it on every SSR pass so client-side navigations see the real
 * value. Client default: nothing optional offered.
 */
export function useInstanceConfig() {
  const config = useState<InstanceConfig>('instance-config', () =>
    import.meta.server ? resolveInstanceConfig(process.env) : { ...MINIMAL_INSTANCE_CONFIG }
  )
  const loginProviders = computed(() => config.value.loginProviders)
  const legalSurfaces = computed(() => config.value.legalSurfaces)
  const operatorName = computed(() => config.value.operatorName)
  const marketingSite = computed(() => config.value.marketingSite)
  const siteUrl = computed(() => config.value.siteUrl)
  const docsCanonicalBase = computed(() => config.value.docsCanonicalBase)
  const anonGate = computed(() => config.value.anonGate)
  const anonDocTtlDays = computed(() => config.value.anonDocTtlDays)
  /** Per-workspace single sign-on can exist on this instance (WP14). */
  const workspaceSso = computed(() => config.value.workspaceSso === true)
  /** Start of the login flow — the first configured provider, or null when login is off. */
  const primaryLoginPath = computed(() => {
    const first = config.value.loginProviders[0]
    return first ? loginPath(first) : null
  })
  return { config, loginProviders, legalSurfaces, operatorName, marketingSite, siteUrl, docsCanonicalBase, anonGate, anonDocTtlDays, workspaceSso, primaryLoginPath }
}
