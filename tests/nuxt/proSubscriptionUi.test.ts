// @vitest-environment nuxt
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { NuxtPage } from '#components'
import { useQueryCache } from '@pinia/colada'
import type { H3Event } from 'h3'
import { DEFAULT_TIERS } from '~~/shared/config/tiers'
import { CURRENCIES, DEFAULT_PLAN_PRICES, type PlanPricesResponse } from '~~/shared/config/pricing'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import type { BillingMode } from '~~/shared/config/billingMode'
import type { UserBilling } from '~/composables/billing/useBilling'
import { billingKeys } from '~/queries/billing'

// A personal Pro subscriber: the pricing page marks only the price they
// pay (plan AND billing period), the profile lets them switch between
// monthly and annual billing and says when a cancelled plan ends.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
const toastAdd = vi.fn()
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
const { goToExternal } = vi.hoisted(() => ({ goToExternal: vi.fn() }))
mockNuxtImport('goToExternal', () => goToExternal)

const PRICES: PlanPricesResponse = { currencies: CURRENCIES, prices: DEFAULT_PLAN_PRICES, source: 'stripe' }
registerEndpoint('/api/billing/prices', () => PRICES)
registerEndpoint('/api/billing/tiers', () => DEFAULT_TIERS)
registerEndpoint('/api/user/account-status', () => null)
registerEndpoint('/api/user/exports', () => [])

const MB = 1024 * 1024
function proBilling(patch: Partial<UserBilling> = {}): UserBilling {
  return {
    plan: 'pro',
    interval: 'month',
    cancelAt: null,
    periodStart: '2027-01-01T00:00:00.000Z',
    periodEnd: '2027-02-01T00:00:00.000Z',
    ownedWorkspaces: 0,
    workspacesOwnedLimit: 10,
    knowledgeFilesUsed: 0,
    knowledgeFilesLimit: 100,
    knowledgeBytesUsed: 0,
    knowledgeBytesPerUserLimit: 2048 * MB,
    imageBytesUsed: 0,
    imageBytesPerUserLimit: 2048 * MB,
    credits: { usableUsd: 0, usedThisMonthUsd: 0, grants: [] },
    coveringWorkspaces: [],
    ...patch
  }
}

let billing: UserBilling
registerEndpoint('/api/user/billing', () => billing)

const checkoutBodies: unknown[] = []
registerEndpoint('/api/billing/checkout', {
  method: 'POST',
  handler: async (event: H3Event) => {
    const { readBody } = await import('h3')
    const body = await readBody<{ interval: 'month' | 'year' }>(event)
    checkoutBodies.push(body)
    // The server has switched the subscription: the next read shows it.
    billing = { ...billing, interval: body.interval }
    return { updated: true, plan: 'pro', interval: body.interval }
  }
})

const Route = defineComponent({ render: () => h(NuxtPage) })

beforeEach(() => {
  checkoutBodies.length = 0
  toastAdd.mockReset()
  goToExternal.mockReset()
  billing = proBilling()
  useState<BillingMode>('billing-mode').value = { billingEnabled: true, plansComingSoon: false }
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, loginProviders: ['github'] }
  useQueryCache().setQueryData<UserBilling>(billingKeys.user(), billing)
})

describe('pricing page: a Pro subscriber', () => {
  async function mountPricing() {
    const wrapper = await mountSuspended(Route, { route: '/pricing' })
    await flushPromises()
    return wrapper
  }
  const badge = (wrapper: Awaited<ReturnType<typeof mountPricing>>) =>
    wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-current-plan-badge"]')
  async function selectInterval(wrapper: Awaited<ReturnType<typeof mountPricing>>, label: string) {
    const tab = wrapper.findAll('[data-testid="pricing-interval"] [role="tab"]').find(t => t.text().startsWith(label))
    await tab?.trigger('mousedown', { button: 0 })
    await flushPromises()
  }

  it('monthly subscriber: "current plan" on the monthly price only', async () => {
    const wrapper = await mountPricing()
    expect(badge(wrapper).exists()).toBe(true)
    await selectInterval(wrapper, 'Annual')
    expect(wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-price"]').text()).toBe('€90')
    expect(badge(wrapper).exists()).toBe(false)
    // Still their plan: the button manages the subscription, it does not offer a downgrade.
    expect(wrapper.find('[data-testid="pricing-tier-pro"]').text()).toContain('Manage subscription')
    await selectInterval(wrapper, 'Monthly')
    expect(badge(wrapper).exists()).toBe(true)
  })

  it('annual subscriber: "current plan" on the annual price only', async () => {
    billing = proBilling({ interval: 'year' })
    useQueryCache().setQueryData<UserBilling>(billingKeys.user(), billing)
    const wrapper = await mountPricing()
    expect(badge(wrapper).exists()).toBe(false)
    await selectInterval(wrapper, 'Annual')
    expect(badge(wrapper).exists()).toBe(true)
  })

  it('links the credit packs to where a Pro user buys them', async () => {
    const wrapper = await mountPricing()
    const link = wrapper.find('[data-testid="pricing-credits-buy-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/settings/profile#ai-credits')
  })

  it('shows no credits link to a Free user', async () => {
    billing = proBilling({ plan: 'free', interval: null })
    useQueryCache().setQueryData<UserBilling>(billingKeys.user(), billing)
    const wrapper = await mountPricing()
    expect(wrapper.find('[data-testid="pricing-credits-buy-link"]').exists()).toBe(false)
  })
})

describe('profile: spending and usage of a Pro subscriber', () => {
  async function mountProfile() {
    const wrapper = await mountSuspended(Route, { route: '/settings/profile' })
    await flushPromises()
    return wrapper
  }

  it('switches monthly to annual billing after the paid-terms box, then shows the new period', async () => {
    const wrapper = await mountProfile()
    expect(wrapper.get('[data-testid="profile-plan"]').text()).toContain('Pro · monthly')
    const button = () => wrapper.get('[data-testid="profile-switch-interval"]')
    expect(button().text()).toContain('Switch to annual billing')
    expect(button().attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="profile-switch-paid-terms"] [role="checkbox"]').trigger('click')
    await flushPromises()
    await button().trigger('click')
    await flushPromises()

    expect(checkoutBodies).toEqual([{ plan: 'pro', interval: 'year', acceptPaidTerms: true }])
    await vi.waitFor(() => expect(wrapper.get('[data-testid="profile-plan"]').text()).toContain('Pro · annual'))
    expect(button().text()).toContain('Switch to monthly billing')
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: 'Plan changed' }))
    expect(goToExternal).not.toHaveBeenCalled()
  })

  it('a renewing plan says when it renews, a cancelled one when it ends', async () => {
    const renewing = await mountProfile()
    expect(renewing.find('[data-testid="profile-plan-renews"]').text()).toContain('Renews on')
    expect(renewing.find('[data-testid="profile-plan-ends"]').exists()).toBe(false)
    renewing.unmount()

    billing = proBilling({ cancelAt: '2027-02-01T00:00:00.000Z' })
    useQueryCache().setQueryData<UserBilling>(billingKeys.user(), billing)
    const ending = await mountProfile()
    expect(ending.find('[data-testid="profile-plan-ends"]').text()).toContain('Ends on')
    expect(ending.find('[data-testid="profile-plan-renews"]').exists()).toBe(false)
  })

  it('a Free account has no interval switch', async () => {
    billing = proBilling({ plan: 'free', interval: null })
    useQueryCache().setQueryData<UserBilling>(billingKeys.user(), billing)
    const wrapper = await mountProfile()
    expect(wrapper.find('[data-testid="profile-interval-switch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="profile-plan-renews"]').exists()).toBe(false)
  })
})
