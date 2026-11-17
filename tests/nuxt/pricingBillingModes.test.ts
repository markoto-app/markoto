// @vitest-environment nuxt
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { CommonLegalFooter, NuxtPage, PricingWaitlistForm } from '#components'
import { DEFAULT_TIERS, type TiersMap } from '~~/shared/config/tiers'
import { CURRENCIES, DEFAULT_PLAN_PRICES, type PlanPricesResponse } from '~~/shared/config/pricing'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import type { BillingMode } from '~~/shared/config/billingMode'

// The site footer is a lazy, hydrate-on-visible component on `/` and the
// marketing layout. Its first import compiles Nuxt UI's footer theme
// modules; under a full parallel run that can finish after this file's
// environment is torn down (EnvironmentTeardownError). The static import
// above loads it with the test file instead.
beforeAll(() => {
  if (!CommonLegalFooter) throw new Error('CommonLegalFooter did not load')
})

// Pins the pricing page in the three instance shapes:
//
//   - billing ON            → three cards (Free, Pro, Teams with a Team /
//                             Business switch), real prices + purchase
//                             CTAs, no waitlist; the same cards for
//                             visitors and signed-in users.
//   - billing OFF + coming  → the same cards; paid prices shown as
//     soon (hosted SaaS)      PLANNED, no purchase button, one waitlist
//                             bar above the cards, the comparison table
//                             folded away, FAQ.
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
  free: {
    ...DEFAULT_TIERS.free,
    workspacesOwned: 1,
    knowledgeFiles: 7,
    // Hosted free-tier plan limits (infra/render-env.sh).
    membersPerWorkspace: 3,
    historyDays: 30,
    customCss: false,
    mcpWrite: false
  },
  // Hosted shape: single sign-on and the audit log are Business-only.
  pro: { ...DEFAULT_TIERS.pro, sso: false, auditLog: false },
  team: { ...DEFAULT_TIERS.team, sso: false, auditLog: false }
}
registerEndpoint('/api/billing/tiers', () => TIERS)

const PRICES: PlanPricesResponse = {
  currencies: CURRENCIES,
  prices: {
    eur: DEFAULT_PLAN_PRICES.eur,
    chf: { pro: { month: 10, year: 100 }, team: { month: 13, year: 130 }, business: { month: 21, year: 210 } }
  },
  source: 'planned'
}
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

// Signed out unless a test signs in (the session is known on the server,
// so the page renders the matching layout straight away).
const session = vi.hoisted(() => ({ loggedIn: false, plan: 'free' }))
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: computed(() => session.loggedIn),
  user: computed(() => (session.loggedIn ? { id: 'u1', name: 'Maya Chen' } : null)),
  session: ref({}),
  ready: computed(() => true),
  clear: vi.fn(),
  fetch: vi.fn()
}))
registerEndpoint('/api/user/billing', () => ({ plan: session.plan, ownedWorkspaces: 0, workspacesOwnedLimit: 1 }))

function signIn(plan = 'free'): void {
  session.loggedIn = true
  session.plan = plan
}

/** Test ids of the plan / option cards, in page order. */
function cardIds(wrapper: { findAll: (selector: string) => { attributes: (name: string) => string | undefined }[] }): string[] {
  return wrapper.findAll('[data-testid="pricing-options"] article').map(card => card.attributes('data-testid') ?? '')
}

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
  session.loggedIn = false
  session.plan = 'free'
  setConfig({ anonDocTtlDays: 30, loginProviders: ['github'] })
})

/** Pick Team or Business on the Teams card. */
async function pickTeamPlan(wrapper: Awaited<ReturnType<typeof mountPricing>>, label: 'Team' | 'Business'): Promise<void> {
  const tab = wrapper.findAll('[data-testid="pricing-teams-switch"] [role="tab"]').find(el => el.text() === label)
  expect(tab, label).toBeDefined()
  await tab?.trigger('mousedown', { button: 0 })
  await flushPromises()
}

describe('pricing page: billing on', () => {
  it('shows three cards (Free, Pro, Teams), real prices and purchase CTAs, and no waitlist', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    const wrapper = await mountPricing()
    expect(cardIds(wrapper)).toEqual(['pricing-tier-free', 'pricing-tier-pro', 'pricing-tier-team'])
    const expected = { pro: '€9', team: '€12', business: '€20' }
    for (const [plan, price] of Object.entries(expected)) {
      if (plan === 'business') await pickTeamPlan(wrapper, 'Business')
      const panel = wrapper.find(`[data-testid="pricing-tier-${plan}"]`)
      expect(panel.exists(), plan).toBe(true)
      expect(panel.attributes('data-coming-soon'), plan).toBe('false')
      expect(panel.find('[data-testid="pricing-price"]').text(), plan).toBe(price)
      expect(panel.text(), plan).not.toContain('Planned price')
      expect(panel.find('[data-testid="pricing-join-waitlist"]').exists(), plan).toBe(false)
    }
    // Logged out: the paid CTA is "Sign up" (Stripe Checkout after login).
    expect(wrapper.find('[data-testid="pricing-tier-pro"]').text()).toContain('Sign up')
    expect(wrapper.find('[data-testid="pricing-workspace-plan-business"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pricing-coming-soon-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="waitlist-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pricing-compare"]').exists()).toBe(true)
  })

  it('shows a signed-in user the same three cards, with the purchase box on Pro', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    signIn()
    const wrapper = await mountPricing()
    await flushPromises()
    expect(cardIds(wrapper)).toEqual(['pricing-tier-free', 'pricing-tier-pro', 'pricing-tier-team'])
    // Pro is bought here, behind the Paid Plans Terms box; Team / Business
    // are set up from a workspace.
    const pro = wrapper.find('[data-testid="pricing-tier-pro"]')
    expect(pro.find('[data-testid="pricing-paid-terms-pro"]').exists()).toBe(true)
    expect(pro.find('[data-testid="pricing-buy-pro"]').text()).toBe('Upgrade')
    expect(pro.find('[data-testid="pricing-buy-pro"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="pricing-workspace-plan-team"]').exists()).toBe(true)
    await pickTeamPlan(wrapper, 'Business')
    expect(wrapper.find('[data-testid="pricing-workspace-plan-business"]').exists()).toBe(true)
    // A free account cannot buy extra AI Points.
    expect(wrapper.find('[data-testid="pricing-credits-buy-link"]').exists()).toBe(false)
  })

  it('says who sells when paid plans go through Stripe Managed Payments, and only then', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false, managedPayments: true })
    signIn()
    const wrapper = await mountPricing()
    await flushPromises()
    const footnote = wrapper.find('[data-testid="pricing-sold-through-link"]')
    expect(footnote.text()).toContain('Sold through Link (Stripe)')
    expect(footnote.find('a').attributes('href')).toBe('https://link.com/terms')
    // Next to the purchase box too (it is the one every purchase needs).
    expect(wrapper.find('[data-testid="pricing-paid-terms-pro"] [data-testid="sold-through-link"]').exists()).toBe(true)

    setMode({ billingEnabled: true, plansComingSoon: false, managedPayments: false })
    const plain = await mountPricing()
    await flushPromises()
    expect(plain.find('[data-testid="pricing-sold-through-link"]').exists()).toBe(false)
    expect(plain.find('[data-testid="sold-through-link"]').exists()).toBe(false)
  })

  it('marks the plan of a signed-in user and offers the portal on it', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    signIn('pro')
    const wrapper = await mountPricing()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="pricing-tier-pro"]').attributes('data-current')).toBe('true')
    })
    expect(wrapper.findAll('[data-testid="pricing-current-plan-badge"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-current-plan-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pricing-tier-pro"]').text()).toContain('Manage subscription')
    expect(wrapper.find('[data-testid="pricing-tier-free"]').text()).toContain('Downgrade')
    // Pro can buy extra AI Points.
    expect(wrapper.find('[data-testid="pricing-credits-buy-link"]').exists()).toBe(true)
  })

  it('emits Offer JSON-LD for every plan, billing period and currency on the marketing site', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    setConfig({ marketingSite: true, siteUrl: 'https://markoto.app', anonDocTtlDays: 30 })
    await mountPricing()
    await settleHead()
    const data = pricingJsonLd()
    expect(data).not.toBeNull()
    // Free, then per plan: EUR month / year, CHF month / year.
    expect(offerPrices(data)).toEqual(['0', '9', '90', '10', '100', '12', '120', '13', '130', '20', '200', '21', '210'])
    const json = JSON.stringify(data)
    expect(json).toContain('"priceCurrency":"EUR"')
    expect(json).toContain('"priceCurrency":"CHF"')
    expect(json).toContain('"billingDuration":"P1Y"')
    expect(json).toContain('"unitText":"seat"')
  })
})

describe('pricing page: interval and currency', () => {
  it('one billing-period switch in the header changes the price of every paid plan', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    const wrapper = await mountPricing()
    const prices = () => ['pro', 'team'].map(plan =>
      wrapper.find(`[data-testid="pricing-tier-${plan}"] [data-testid="pricing-price"]`).text())
    expect(prices()).toEqual(['€9', '€12'])
    expect(wrapper.findAll('[data-testid="pricing-interval"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="pricing-currency"]')).toHaveLength(1)
    const yearTab = wrapper.findAll('[data-testid="pricing-interval"] [role="tab"]').find(tab => tab.text().startsWith('Annual'))
    expect(yearTab).toBeDefined()
    await yearTab?.trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(prices()).toEqual(['€90', '€120'])
    expect(wrapper.find('[data-testid="pricing-tier-pro"]').text()).toContain('per year')
    expect(wrapper.find('[data-testid="pricing-tier-team"]').text()).toContain('per seat / year')
    await pickTeamPlan(wrapper, 'Business')
    expect(wrapper.find('[data-testid="pricing-seat-total-business"]').text()).toBe('€600 per year for 3 seats')
  })
})

describe('pricing page: seats and credits', () => {
  it('totals Team for the chosen seats, starting at the minimum; Business keeps the count', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    const wrapper = await mountPricing()
    const total = () => wrapper.find('[data-testid="pricing-seat-total-team"]').text()
    expect(total()).toBe('€36 per month for 3 seats')
    const input = wrapper.find('input[data-testid="pricing-seats-team"], [data-testid="pricing-seats-team"] input')
    expect(input.exists()).toBe(true)
    await input.setValue('5')
    await input.trigger('blur')
    await flushPromises()
    expect(total()).toBe('€60 per month for 5 seats')
    expect(wrapper.find('[data-testid="pricing-tier-team"]').text()).toContain('Billing tab')
    await pickTeamPlan(wrapper, 'Business')
    expect(wrapper.find('[data-testid="pricing-seat-total-business"]').text()).toBe('€100 per month for 5 seats')
  })

  it('lists the extra AI Points packs in one line, with the points in the FAQ', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    const wrapper = await mountPricing()
    const credits = wrapper.find('[data-testid="pricing-credits"]')
    expect(credits.text()).toContain('€10 / €25 / €50')
    expect(credits.text()).toContain('valid 12 months')
    const faq = wrapper.find('[data-testid="marketing-faq"]').text()
    expect(faq).toContain('expire 12 months')
    expect(faq).toContain('10,000 AI Points')
    expect(faq).not.toContain('$')
  })
})

describe('pricing page: billing off, plans coming soon (hosted SaaS)', () => {
  it('shows three cards, paid plans with planned prices and no purchase button, and one waitlist bar above them', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    expect(wrapper.findAll('[data-testid="pricing-coming-soon-badge"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="pricing-planned-note"]').exists()).toBe(true)
    const expected = { pro: '€9', team: '€12', business: '€20' }
    for (const [plan, price] of Object.entries(expected)) {
      if (plan === 'business') await pickTeamPlan(wrapper, 'Business')
      const panel = wrapper.find(`[data-testid="pricing-tier-${plan}"]`)
      expect(panel.exists(), plan).toBe(true)
      expect(panel.attributes('data-coming-soon'), plan).toBe('true')
      expect(panel.find('[data-testid="pricing-price"]').text(), plan).toBe(price)
      expect(panel.text(), plan).toContain('Planned price')
      expect(panel.find('[data-testid="pricing-join-waitlist"]').exists(), plan).toBe(true)
      expect(panel.text(), plan).not.toMatch(/Upgrade|Sign up|Set up in a workspace/)
    }
    expect(wrapper.find('[data-testid="pricing-tier-free"]').attributes('data-coming-soon')).toBe('false')
    // One waitlist, above the cards.
    expect(wrapper.findAll('[data-testid="waitlist-section"]')).toHaveLength(1)
    const bar = wrapper.find('#waitlist [data-testid="waitlist-section"]')
    expect(bar.exists()).toBe(true)
    const cards = wrapper.find('[data-testid="pricing-options"]').element
    expect(bar.element.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('signed in: Free is the current plan, nothing to buy', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    signIn()
    const wrapper = await mountPricing()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="pricing-tier-free"]').attributes('data-current')).toBe('true')
    })
    expect(wrapper.find('[data-testid="pricing-tier-free"] [data-testid="pricing-current-plan-badge"]').exists()).toBe(true)
    expect(cardIds(wrapper)).toEqual(['pricing-tier-free', 'pricing-tier-pro', 'pricing-tier-team'])
    expect(wrapper.text()).not.toMatch(/Upgrade|Set up in a workspace/)
  })

  it('puts the cursor into the waitlist email field from a paid card', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    // Attached: the button finds the bar by id in the document.
    const wrapper = await mountSuspended(PricingRoute, { route: '/pricing', attachTo: document.body })
    await wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-join-waitlist"]').trigger('click')
    expect(document.activeElement?.closest('[data-testid="waitlist-section"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('opens the Teams card on Team; the switch shows Business and its extras', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const teams = () => wrapper.find('[data-testid="pricing-option-teams"]')
    expect(teams().find('[data-testid="pricing-tier-team"]').exists()).toBe(true)
    expect(teams().text()).not.toContain('Single sign-on')
    await pickTeamPlan(wrapper, 'Business')
    expect(teams().find('[data-testid="pricing-tier-business"]').exists()).toBe(true)
    expect(teams().find('[data-testid="pricing-tier-team"]').exists()).toBe(false)
    expect(teams().text()).toContain('Single sign-on (SSO)')
    expect(teams().text()).toContain('Audit log')
  })

  it('takes every number from live config and counts with the right plural', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const free = wrapper.find('[data-testid="pricing-tier-free"]')
    expect(free.find('[data-testid="pricing-cap-workspaces"]').text()).toBe('1 workspace you own')
    expect(free.text()).not.toContain('1 workspaces')
    expect(wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-cap-workspaces"]').text())
      .toBe(`${DEFAULT_TIERS.pro.workspacesOwned} workspaces you own`)
    // At most four short lines per card.
    for (const plan of ['free', 'pro', 'team']) {
      expect(wrapper.findAll(`[data-testid="pricing-tier-${plan}"] [data-testid="pricing-highlights"] li`).length, plan).toBeLessThanOrEqual(4)
    }
    // Pro names what it adds over this free tier (custom CSS is off on it).
    expect(wrapper.find('[data-testid="pricing-tier-pro"]').text()).toContain('Custom CSS for documents')
    // Team: people per workspace from the tier map.
    expect(wrapper.find('[data-testid="pricing-tier-team"] [data-testid="pricing-cap-members"]').exists()).toBe(true)
    // Comparison table (folded away, still rendered), same numbers.
    const row = wrapper.find('[data-testid="pricing-compare-row-knowledgeFiles"]')
    expect(row.text()).toContain('7')
    expect(row.text()).toContain(String(DEFAULT_TIERS.business.knowledgeFiles.toLocaleString('en')))
    expect(wrapper.find('[data-testid="pricing-compare-row-price"]').text()).toContain('€9 per month (planned)')
    // Plan limits and features come from the same tier map.
    const members = wrapper.find('[data-testid="pricing-compare-row-members"]').text()
    expect(members).toContain('3')
    expect(members).toContain('Unlimited')
    expect(wrapper.find('[data-testid="pricing-compare-row-history"]').text()).toContain('30 days')
    expect(wrapper.find('[data-testid="pricing-compare-row-mcp"]').text()).toContain('Read-only')
    // Team / Business: AI Points and storage are per seat, shared by the
    // workspace (the pool = seats × these values).
    expect(wrapper.find('[data-testid="pricing-tier-team"] [data-testid="pricing-cap-ai"]').text()).toContain('per seat a month, shared')
    expect(wrapper.find('[data-testid="pricing-tier-pro"] [data-testid="pricing-cap-ai"]').text()).not.toContain('per seat')
    expect(wrapper.find('[data-testid="pricing-compare-row-knowledgeStorage"]').text()).toContain('20 GB per seat')
  })

  it('folds the comparison table away behind a disclosure, with four plan columns', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const toggle = wrapper.find('[data-testid="pricing-compare-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.attributes('aria-controls')).toBe('pricing-compare-panel')
    const panel = wrapper.find('#pricing-compare-panel').element as HTMLElement
    expect(panel.style.display).toBe('none')
    await toggle.trigger('click')
    expect(wrapper.find('[data-testid="pricing-compare-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(panel.style.display).toBe('')
    const columns = wrapper.findAll('[data-testid^="pricing-compare-col-"]').map(col => col.attributes('data-testid'))
    expect(columns).toEqual(['pricing-compare-col-free', 'pricing-compare-col-pro', 'pricing-compare-col-team', 'pricing-compare-col-business'])
  })

  it('links writing without an account and self-hosting in one line', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const line = wrapper.find('[data-testid="pricing-alt-links"]')
    expect(line.find('[data-testid="pricing-anon-cta"]').text()).toBe('Write without an account')
    expect(line.find('[data-testid="pricing-self-hosted-cta"]').attributes('href')).toBe('/docs/self-hosting')
  })

  it('shows the FAQ, including what "coming soon" means', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    const wrapper = await mountPricing()
    const faq = wrapper.find('[data-testid="marketing-faq"]')
    expect(faq.exists()).toBe(true)
    expect(faq.text()).toContain('What does “coming soon” mean?')
    expect(faq.text()).toContain('Can I use AI without a paid plan?')
    // The free-allowance note moved into the answer.
    expect(faq.text()).toContain('Mistral AI in the EU')
  })

  it('emits Offer JSON-LD for the free account only (planned prices are not offers)', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    setConfig({ marketingSite: true, siteUrl: 'https://markoto.app', anonDocTtlDays: 30 })
    await mountPricing()
    await settleHead()
    expect(offerPrices(pricingJsonLd())).toEqual(['0'])
  })
})

describe('pricing page: billing off, self-hosted', () => {
  it('shows only the limits of this instance, no options, prices, table or waitlist', async () => {
    setMode({ billingEnabled: false, plansComingSoon: false })
    const wrapper = await mountPricing()
    const free = wrapper.find('[data-testid="pricing-tier-free"]')
    expect(free.exists()).toBe(true)
    expect(free.find('[data-testid="pricing-cap-workspaces"]').text()).toBe('1 workspace you own')
    for (const plan of ['pro', 'team', 'business']) {
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
