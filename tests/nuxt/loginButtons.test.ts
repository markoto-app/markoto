// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { AuthLoginButtons } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// The sign-in buttons follow the SSR-hydrated instance config
// (`useState('instance-config')`, see useInstanceConfig): only configured
// providers, the operator's own IdP first and labelled with
// NUXT_OAUTH_OIDC_NAME (WP7b).

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

describe('LoginButtons', () => {
  it('says sign-in is unavailable without any provider', async () => {
    setConfig({ loginProviders: [] })
    const wrapper = await mountSuspended(AuthLoginButtons)
    expect(wrapper.find('[data-testid="login-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('offers the OIDC provider under its configured name, linking to /auth/oidc', async () => {
    setConfig({ loginProviders: ['oidc', 'github'], oidcProviderName: 'Authentik' })
    const wrapper = await mountSuspended(AuthLoginButtons)
    const oidc = wrapper.find('[data-testid="login-oidc"]')
    expect(oidc.text()).toBe('Continue with Authentik')
    expect(oidc.attributes('href')).toBe('/auth/oidc')
    expect(wrapper.find('[data-testid="login-github"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="login-google"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="login-unavailable"]').exists()).toBe(false)
  })

  it('falls back to a generic label without a name', async () => {
    setConfig({ loginProviders: ['oidc'], oidcProviderName: '' })
    const wrapper = await mountSuspended(AuthLoginButtons)
    expect(wrapper.find('[data-testid="login-oidc"]').text()).toBe('Continue with single sign-on')
  })
})
