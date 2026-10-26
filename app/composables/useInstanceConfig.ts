import {
  MINIMAL_INSTANCE_CONFIG,
  loginPath,
  resolveInstanceConfig,
  type InstanceConfig
} from '~~/shared/config/instance'

/**
 * The instance shape on the client (see `shared/config/instance.ts`):
 * which OAuth login providers are configured and whether the legal
 * surfaces (onboarding gate, consent banner, DPA step, /legal/* pages)
 * are on.
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
  /** Start of the login flow — the first configured provider, or null when login is off. */
  const primaryLoginPath = computed(() => {
    const first = config.value.loginProviders[0]
    return first ? loginPath(first) : null
  })
  return { config, loginProviders, legalSurfaces, operatorName, primaryLoginPath }
}
