// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { NuxtPage } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// The product tour replaces the home page's hero only for
// LOGGED-OUT visitors on an instance with NUXT_MARKETING_SITE_ENABLED
// (hosted markoto.app). Self-hosted instances and signed-in users keep
// the plain hero + dashboard.

const session = vi.hoisted(() => ({ loggedIn: false }))

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: computed(() => session.loggedIn),
  user: ref(session.loggedIn ? { id: 1, name: 'Maya' } : null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))

registerEndpoint('/api/user/documents', () => [])
registerEndpoint('/api/user/workspaces', () => [])
registerEndpoint('/api/user/invites', () => [])
registerEndpoint('/api/user/billing', () => null)

const HomeRoute = defineComponent({ render: () => h(NuxtPage) })

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

beforeEach(() => {
  session.loggedIn = false
})

describe('home page: product tour gate', () => {
  it('shows the tour to logged-out visitors when the flag is on', async () => {
    setConfig({ marketingSite: true })
    const wrapper = await mountSuspended(HomeRoute, { route: '/' })
    const tour = wrapper.find('[data-testid="product-tour"]')
    expect(tour.exists()).toBe(true)
    expect(tour.find('h1').text()).toBe('Beautifully rendered Markdown.')
    expect(tour.find('[data-testid="tour-start-writing"]').text()).toContain('Start writing, no sign-up')
    // Every scene's copy is in the markup (SEO) as a real heading.
    const headings = tour.findAll('h2').map(h2 => h2.text())
    expect(headings).toContain('Write Markdown, get paged documents.')
    expect(headings).toContain('Try it with your own Markdown.')
    expect(tour.find('[data-testid="tour-self-host"]').attributes('href')).toBe('/docs/getting-started/self-hosting')
    expect(wrapper.find('[data-testid="landing-new-document"]').exists()).toBe(false)
  })

  it('keeps the plain hero when the flag is off (self-hosted)', async () => {
    setConfig({ marketingSite: false })
    const wrapper = await mountSuspended(HomeRoute, { route: '/' })
    expect(wrapper.find('[data-testid="product-tour"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-new-document"]').exists()).toBe(true)
  })

  it('keeps the dashboard for signed-in users even with the flag on', async () => {
    session.loggedIn = true
    setConfig({ marketingSite: true })
    const wrapper = await mountSuspended(HomeRoute, { route: '/' })
    expect(wrapper.find('[data-testid="product-tour"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="landing-new-document"]').exists()).toBe(true)
  })
})
