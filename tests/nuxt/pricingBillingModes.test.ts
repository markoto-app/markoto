// @vitest-environment nuxt
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { NuxtPage, PricingWaitlistForm } from '#components'
import { DEFAULT_TIERS } from '~~/shared/config/tiers'
import type { BillingMode } from '~~/shared/config/billingMode'

// Pins the three pricing-page modes (WP3) at the component level:
//
//   - billing ON           → paid tiers show prices + purchase CTAs, no
//                            waitlist (unchanged behaviour).
//   - billing OFF + coming → every tier visible, paid tiers carry a
//     soon (hosted SaaS)     "coming soon" state with NO price and NO
//                            enabled purchase button, plus the waitlist.
//   - billing OFF          → only the free tier ("limits on this
//     (self-hosted)          instance"), no prices, no waitlist.
//
// The mode is the SSR-hydrated `useState('billing-mode')` that
// `useBillingMode()` reads; tests set it directly, exactly like the
// payload hydration does in the browser.

registerEndpoint('/api/billing/tiers', () => DEFAULT_TIERS)

const waitlistBodies: unknown[] = []
registerEndpoint('/api/waitlist', {
  method: 'POST',
  handler: async (event) => {
    const { readBody } = await import('h3')
    waitlistBodies.push(await readBody(event))
    return { ok: true }
  }
})

mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

// Pages aren't in `#components`; render the real /pricing route through
// <NuxtPage> instead of importing the SFC (keeps the test typed).
const PricingRoute = defineComponent({ render: () => h(NuxtPage) })

function mountPricing() {
  return mountSuspended(PricingRoute, { route: '/pricing' })
}

function setMode(mode: BillingMode): void {
  useState<BillingMode>('billing-mode').value = mode
}

beforeEach(() => {
  waitlistBodies.length = 0
})

describe('pricing page — billing on', () => {
  it('shows prices and purchase CTAs, and no waitlist', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    const wrapper = await mountPricing()
    const pro = wrapper.find('[data-testid="pricing-tier-pro"]')
    expect(pro.exists()).toBe(true)
    expect(pro.text()).toContain('$10')
    expect(pro.attributes('data-coming-soon')).toBe('false')
    expect(wrapper.find('[data-testid="pricing-coming-soon-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="waitlist-section"]').exists()).toBe(false)
  })
})

describe('pricing page — billing off, plans coming soon (hosted SaaS)', () => {
  it('shows every tier, paid ones as "coming soon" without price or enabled CTA, plus the waitlist', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    for (const plan of ['pro', 'max', 'ultra']) {
      const card = wrapper.find(`[data-testid="pricing-tier-${plan}"]`)
      expect(card.exists(), plan).toBe(true)
      expect(card.attributes('data-coming-soon'), plan).toBe('true')
      expect(card.text(), plan).not.toMatch(/\$\d/)
      const cta = card.find('[data-testid="pricing-coming-soon-button"]')
      expect(cta.exists(), plan).toBe(true)
      expect(cta.attributes('disabled'), plan).toBeDefined()
    }
    expect(wrapper.find('[data-testid="pricing-tier-free"]').attributes('data-coming-soon')).toBe('false')
    expect(wrapper.find('[data-testid="pricing-coming-soon-footnote"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="waitlist-section"]').exists()).toBe(true)
  })
})

describe('pricing page — billing off, self-hosted', () => {
  it('shows only the free tier, no prices, no waitlist', async () => {
    setMode({ billingEnabled: false, plansComingSoon: false })
    const wrapper = await mountPricing()
    expect(wrapper.find('[data-testid="pricing-tier-free"]').exists()).toBe(true)
    for (const plan of ['pro', 'max', 'ultra']) {
      expect(wrapper.find(`[data-testid="pricing-tier-${plan}"]`).exists(), plan).toBe(false)
    }
    expect(wrapper.text()).not.toMatch(/\$\d/)
    expect(wrapper.find('[data-testid="waitlist-section"]').exists()).toBe(false)
  })
})

describe('waitlist form', () => {
  it('keeps submit disabled until the (unticked) consent box is ticked, then posts consent: true', async () => {
    const wrapper = await mountSuspended(PricingWaitlistForm)
    const submit = wrapper.find('[data-testid="waitlist-submit"]')
    const consentBox = wrapper.find('[role="checkbox"]')
    expect(consentBox.attributes('aria-checked')).toBe('false')

    await wrapper.find('input[type="email"]').setValue('maya@example.com')
    expect(submit.attributes('disabled')).toBeDefined()

    await consentBox.trigger('click')
    expect(wrapper.find('[data-testid="waitlist-submit"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('[data-testid="waitlist-form"]').trigger('submit')
    await flushPromises()
    // The $fetch round-trip through the registered endpoint settles
    // over several microtask hops; wait for the success state to render.
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="waitlist-success"]').exists()).toBe(true)
    })
    expect(waitlistBodies).toHaveLength(1)
    expect(waitlistBodies[0]).toMatchObject({ email: 'maya@example.com', consent: true })
  })
})
