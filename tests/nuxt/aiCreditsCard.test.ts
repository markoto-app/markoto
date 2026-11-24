// @vitest-environment nuxt
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { H3Event } from 'h3'
import { CommonAiCreditsCard } from '#components'
import type { BillingMode } from '~~/shared/config/billingMode'

// Extra AI Points (top-ups): the card shows the balance and history in
// AI Points (never dollars), sends
// the chosen pack to checkout and follows Stripe's URL; without a paid
// plan it explains instead of selling.

const { goToExternal } = vi.hoisted(() => ({ goToExternal: vi.fn() }))
mockNuxtImport('goToExternal', () => goToExternal)
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

const bodies: unknown[] = []
registerEndpoint('/api/billing/topup', {
  method: 'POST',
  handler: async (event: H3Event) => {
    const { readBody } = await import('h3')
    bodies.push(await readBody(event))
    return { url: 'https://checkout.stripe.test/topup' }
  }
})

const credits = {
  usableUsd: 32.5,
  usedThisMonthUsd: 2.5,
  grants: [{ pack: '25', amountUsd: 25, remainingUsd: 22.5, refundedUsd: 0, expiresAt: '2027-11-01T00:00:00Z', createdAt: '2026-11-01T00:00:00Z' }]
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  bodies.length = 0
  goToExternal.mockReset()
})

describe('extra AI Points card', () => {
  it('shows the balance, the packs with their prices, and buys one', async () => {
    const wrapper = await mountSuspended(CommonAiCreditsCard, {
      props: { credits, currency: 'chf', canBuy: true, testidPrefix: 'profile' }
    })
    mounted.push(wrapper)
    expect(wrapper.get('[data-testid="profile-credits-balance"]').text()).toBe('32,500 extra AI Points left')
    expect(wrapper.text()).toContain('2,500 used this month')
    expect(wrapper.text()).toContain('25,000 AI Points')
    expect(wrapper.text()).toContain('22,500 left')
    expect(wrapper.get('[data-testid="profile-buy-25"]').text()).toMatch(/^CHF\s25: 25,000 AI Points$/)
    expect(wrapper.text()).not.toContain('$')
    // Disabled until the Paid Plans Terms box is ticked.
    expect(wrapper.get('[data-testid="profile-buy-25"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="profile-paid-terms"] [role="checkbox"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="profile-paid-terms"]').text()).toContain('right of withdrawal ends')
    await wrapper.get('[data-testid="profile-buy-25"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(goToExternal).toHaveBeenCalledWith('https://checkout.stripe.test/topup'))
    expect(bodies).toEqual([{ pack: '25', currency: 'chf', acceptPaidTerms: true }])
  })

  it('without a paid plan shows why instead of the buttons', async () => {
    const wrapper = await mountSuspended(CommonAiCreditsCard, {
      props: { credits: null, currency: 'eur', canBuy: false, blockedReason: 'Upgrade first.', testidPrefix: 'profile' }
    })
    mounted.push(wrapper)
    expect(wrapper.find('[data-testid="profile-buy-10"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Upgrade first.')
    expect(wrapper.text()).toContain('0 extra AI Points left')
  })

  it('top-ups switched off on this deployment: balance and history only, nothing to buy', async () => {
    useState<BillingMode>('billing-mode').value = { billingEnabled: true, plansComingSoon: false, topupsEnabled: false }
    try {
      const wrapper = await mountSuspended(CommonAiCreditsCard, {
        props: { credits, currency: 'eur', canBuy: true, blockedReason: 'Upgrade first.', testidPrefix: 'profile' }
      })
      mounted.push(wrapper)
      expect(wrapper.find('[data-testid="profile-buy-10"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="profile-paid-terms"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Upgrade first.')
      expect(wrapper.get('[data-testid="profile-credits-balance"]').text()).toBe('32,500 extra AI Points left')
    } finally {
      useState<BillingMode>('billing-mode').value = { billingEnabled: false, plansComingSoon: false, topupsEnabled: true }
    }
  })
})
