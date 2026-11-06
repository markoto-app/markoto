// @vitest-environment nuxt
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { CommonLegalFooter, NuxtPage, PricingWaitlistForm } from '#components'
import { DEFAULT_TIERS, type TiersMap } from '~~/shared/config/tiers'
import { PRICE_CURRENCY, type PlanPricesResponse } from '~~/shared/config/pricing'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import type { BillingMode } from '~~/shared/config/billingMode'

// The site footer is a lazy, hydrate-on-visible component on `/` and the
// marketing layout. Its first import compiles Nuxt UI's footer theme
// modules; under a full parallel run that can finish after this file's
// environment is torn down (EnvironmentTeardownError). The static import
// above loads it with the test file instead.
beforeAll(() => {
  expect(CommonLegalFooter).toBeTruthy()
})

// Pins the pricing page in the three instance shapes:
//
//   - billing ON            → four options (self-hosted, no account, free
//                             account, paid with Pro/Max/Ultra tabs), real
//                             prices + purchase CTAs, no waitlist.
//   - billing OFF + coming  → the same four options; paid prices shown
//     soon (hosted SaaS)      as PLANNED, no purchase button, waitlist
//                             under the columns, comparison table, FAQ.
//   - billing OFF           → only the limits every account on this
//     (self-hosted)           instance gets; no options, no prices,
//                             no waitlist.
//
// The mode is the SSR-hydrated `useState('billing-mode')` that
// `useBillingMode()` reads; tests set it directly, exactly like the
// payload hydration does in the browser. Same for the instance config.

// Tier map with a distinctive free-tier cap so "the number on the page
// comes from the endpoint" is visible, plus 1 workspace on free to pin
// the singular form ("1 workspace", never "1 workspaces").
const TIERS: TiersMap = {
  ...DEFAULT_TIERS,
  free: { ...DEFAULT_TIERS.free, workspacesOwned: 1, knowledgeFiles: 7 }
}
registerEndpoint('/api/billing/tiers', () => TIERS)

const PRICES: PlanPricesResponse = { currency: PRICE_CURRENCY, monthly: { free: 0, pro: 10, max: 50, ultra: 100 } }
registerEndpoint('/api/billing/prices', () => PRICES)

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

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

async function settleHead(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 20))
}

function pricingJsonLd(): Record<string, unknown> | null {
  for (const script of document.head.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent
    if (!raw) continue
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) continue
    // The page's one @graph (usePageStructuredData) holds the SoftwareApplication.
    const graph = (parsed as Record<string, unknown>)['@graph']
    for (const node of Array.isArray(graph) ? graph : [parsed]) {
      if (typeof node === 'object' && node !== null && (node as Record<string, unknown>)['@type'] === 'SoftwareApplication') {
        return node as Record<string, unknown>
      }
    }
  }
  return null
}

function offerPrices(data: Record<string, unknown> | null): string[] {
  const offers = data?.offers
  if (!Array.isArray(offers)) return []
  return offers.map((offer: unknown) =>
    typeof offer === 'object' && offer !== null ? String((offer as Record<string, unknown>).price) : '')
}

beforeEach(() => {
  waitlistBodies.length = 0
  setConfig({ anonDocTtlDays: 30, loginProviders: ['github'] })
})

describe('pricing page — billing on', () => {
  it('shows four options, real prices and purchase CTAs, and no waitlist', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    const wrapper = await mountPricing()
    for (const id of ['pricing-option-self-hosted', 'pricing-option-anon', 'pricing-tier-free', 'pricing-option-paid']) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
    }
    const expected = { pro: '$10', max: '$50', ultra: '$100' }
    for (const [plan, price] of Object.entries(expected)) {
      const panel = wrapper.find(`[data-testid="pricing-tier-${plan}"]`)
      expect(panel.exists(), plan).toBe(true)
      expect(panel.attributes('data-coming-soon'), plan).toBe('false')
      expect(panel.find('[data-testid="pricing-price"]').text(), plan).toBe(price)
      expect(panel.text(), plan).not.toContain('Planned price')
      expect(panel.find('[data-testid="pricing-join-waitlist"]').exists(), plan).toBe(false)
    }
    // Logged out: the paid CTA is "Sign up" (Stripe Checkout after login).
    expect(wrapper.find('[data-testid="pricing-tier-pro"]').text()).toContain('Sign up')
    expect(wrapper.find('[data-testid="pricing-coming-soon-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="waitlist-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pricing-compare"]').exists()).toBe(true)
  })

  it('emits Offer JSON-LD for every plan with its USD price on the marketing site', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    setConfig({ marketingSite: true, siteUrl: 'https://markoto.app', anonDocTtlDays: 30 })
    await mountPricing()
    await settleHead()
    const data = pricingJsonLd()
    expect(data).not.toBeNull()
    expect(offerPrices(data)).toEqual(['0', '10', '50', '100'])
    expect(JSON.stringify(data)).toContain('"priceCurrency":"USD"')
  })
})

describe('pricing page — billing off, plans coming soon (hosted SaaS)', () => {
  it('shows the four options, paid tiers with planned prices and no purchase button, plus the waitlist', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const paid = wrapper.find('[data-testid="pricing-option-paid"]')
    expect(paid.find('[data-testid="pricing-coming-soon-badge"]').exists()).toBe(true)
    expect(paid.find('[data-testid="pricing-planned-note"]').exists()).toBe(true)
    const expected = { pro: '$10', max: '$50', ultra: '$100' }
    for (const [plan, price] of Object.entries(expected)) {
      const panel = wrapper.find(`[data-testid="pricing-tier-${plan}"]`)
      expect(panel.exists(), plan).toBe(true)
      expect(panel.attributes('data-coming-soon'), plan).toBe('true')
      expect(panel.find('[data-testid="pricing-price"]').text(), plan).toBe(price)
      expect(panel.text(), plan).toContain('Planned price')
      expect(panel.find('[data-testid="pricing-join-waitlist"]').attributes('href'), plan).toBe('#waitlist')
      expect(panel.text(), plan).not.toMatch(/Upgrade|Sign up/)
    }
    expect(wrapper.find('[data-testid="pricing-tier-free"]').attributes('data-coming-soon')).toBe('false')
    expect(wrapper.find('[data-testid="pricing-coming-soon-footnote"]').exists()).toBe(true)
    expect(wrapper.find('#waitlist [data-testid="waitlist-section"]').exists()).toBe(true)
  })

  it('opens on Pro, and the tabs switch the visible paid plan', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const visible = () => ['pro', 'max', 'ultra'].filter(plan =>
      wrapper.find(`[data-testid="pricing-tier-${plan}"]`).element.closest('[hidden]') === null)
    expect(visible()).toEqual(['pro'])
    const maxTab = wrapper.findAll('[role="tab"]').find(tab => tab.text() === 'Max')
    expect(maxTab).toBeDefined()
    await maxTab?.trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(visible()).toEqual(['max'])
  })

  it('takes every number from live config and counts with the right plural', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const free = wrapper.find('[data-testid="pricing-tier-free"]')
    expect(free.find('[data-testid="pricing-cap-workspaces"]').text()).toBe('1 workspace you own')
    expect(free.text()).toContain('7 knowledge files')
    expect(free.text()).not.toContain('1 workspaces')
    expect(wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-cap-workspaces"]').text())
      .toBe(`${DEFAULT_TIERS.pro.workspacesOwned} workspaces you own`)
    // No-account column: retention from the instance config.
    expect(wrapper.find('[data-testid="pricing-anon-retention"]').text()).toBe('Deleted after 30 days without edits.')
    expect(wrapper.find('[data-testid="pricing-anon-limits"]').text()).toContain('No AI')
    // Comparison table, same numbers.
    const row = wrapper.find('[data-testid="pricing-compare-row-knowledgeFiles"]')
    expect(row.text()).toContain('7')
    expect(row.text()).toContain(String(DEFAULT_TIERS.ultra.knowledgeFiles.toLocaleString('en')))
    expect(wrapper.find('[data-testid="pricing-compare-row-price"]').text()).toContain('$10 per month (planned)')
    expect(wrapper.find('[data-testid="pricing-compare-row-documents"]').text()).toContain('Kept 30 days after the last edit')
  })

  it('hides the retention line when anonymous documents are never deleted', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    setConfig({ anonDocTtlDays: 0 })
    const wrapper = await mountPricing()
    expect(wrapper.find('[data-testid="pricing-anon-retention"]').exists()).toBe(false)
  })

  it('describes self-hosting as source-available and links the guide', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const card = wrapper.find('[data-testid="pricing-option-self-hosted"]')
    expect(card.find('[data-testid="pricing-licence"]').text()).toContain('Source-available')
    expect(card.text().toLowerCase()).not.toContain('open source')
    expect(card.find('[data-testid="pricing-self-hosted-cta"]').attributes('href')).toBe('/docs/getting-started/self-hosting')
  })

  it('shows the FAQ, including what "coming soon" means', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const faq = wrapper.find('[data-testid="marketing-faq"]')
    expect(faq.exists()).toBe(true)
    expect(faq.text()).toContain('What does “coming soon” mean?')
    expect(faq.text()).toContain('Can I use AI without a paid plan?')
  })

  it('emits Offer JSON-LD for the free account only (planned prices are not offers)', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    setConfig({ marketingSite: true, siteUrl: 'https://markoto.app', anonDocTtlDays: 30 })
    await mountPricing()
    await settleHead()
    expect(offerPrices(pricingJsonLd())).toEqual(['0'])
  })
})

describe('pricing page — billing off, self-hosted', () => {
  it('shows only the limits of this instance, no options, prices, table or waitlist', async () => {
    setMode({ billingEnabled: false, plansComingSoon: false })
    const wrapper = await mountPricing()
    const free = wrapper.find('[data-testid="pricing-tier-free"]')
    expect(free.exists()).toBe(true)
    expect(free.find('[data-testid="pricing-cap-workspaces"]').text()).toBe('1 workspace you own')
    for (const plan of ['pro', 'max', 'ultra']) {
      expect(wrapper.find(`[data-testid="pricing-tier-${plan}"]`).exists(), plan).toBe(false)
    }
    expect(wrapper.find('[data-testid="pricing-options"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pricing-compare"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/\$\d/)
    expect(wrapper.find('[data-testid="waitlist-section"]').exists()).toBe(false)
  })

  it('emits no pricing JSON-LD', async () => {
    setMode({ billingEnabled: false, plansComingSoon: false })
    setConfig({ marketingSite: false, siteUrl: 'https://docs.example.org' })
    await mountPricing()
    await settleHead()
    expect(pricingJsonLd()).toBeNull()
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
