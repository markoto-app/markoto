import { loginPath, type LoginProvider } from '~~/shared/config/instance'

export interface LoginOption {
  provider: LoginProvider
  label: string
  icon: string
  to: string
}

const PROVIDER_ICONS: Record<LoginProvider, string> = {
  oidc: 'i-lucide-key-round',
  github: 'i-simple-icons-github',
  google: 'i-simple-icons-google'
}

/**
 * The sign-in buttons this instance offers, in display order — only
 * providers with complete credentials (see `shared/config/instance.ts`).
 * Shared by `LoginButtons.vue` and the mobile account menu so both
 * label the generic OIDC provider the same way ("Continue with
 * <NUXT_OAUTH_OIDC_NAME>", or "single sign-on" without a name).
 */
export function useLoginOptions() {
  const { t } = useI18n()
  const { loginProviders, config } = useInstanceConfig()

  function providerName(provider: LoginProvider): string {
    switch (provider) {
      case 'github': return 'GitHub'
      case 'google': return 'Google'
      case 'oidc': return config.value.oidcProviderName || t('auth.oidcDefaultName')
    }
  }

  function label(provider: LoginProvider): string {
    switch (provider) {
      case 'github': return t('auth.loginGithub')
      case 'google': return t('auth.loginGoogle')
      case 'oidc': return t('auth.loginOidc', { provider: providerName('oidc') })
    }
  }

  const loginOptions = computed<LoginOption[]>(() => loginProviders.value.map(provider => ({
    provider,
    label: label(provider),
    icon: PROVIDER_ICONS[provider],
    to: loginPath(provider)
  })))

  return { loginOptions, providerName }
}
