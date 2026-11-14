// @vitest-environment nuxt
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { WorkspaceBillingPanel, WorkspaceMembersModal } from '#components'
import { DEFAULT_PLAN_PRICES, CURRENCIES, type PlanPricesResponse } from '~~/shared/config/pricing'
import type { H3Event } from 'h3'
import type { WorkspaceBillingOverview } from '~/utils/billing/workspaceBilling'

// Team / Business workspace billing UI: the admin billing tab and
// the invite dialog's "This adds a seat" confirmation.

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []

const PRICES: PlanPricesResponse = { currencies: CURRENCIES, prices: DEFAULT_PLAN_PRICES, source: 'stripe' }
registerEndpoint('/api/billing/prices', () => PRICES)

let overview: WorkspaceBillingOverview
registerEndpoint('/api/workspaces/ws1/billing', () => overview)

const posts: Array<{ path: string, body: unknown }> = []
let memberPostFails = 0
/** What the server does to the overview when a change is posted (the next GET returns it). */
let afterPost: ((path: string, body: unknown) => void) | null = null
async function readJson(event: H3Event) {
  const { readBody } = await import('h3')
  return readBody(event)
}
for (const path of ['checkout', 'seats', 'portal']) {
  registerEndpoint(`/api/workspaces/ws1/billing/${path}`, {
    method: 'POST',
    handler: async (event) => {
      const body = await readJson(event)
      posts.push({ path, body })
      afterPost?.(path, body)
      return path === 'checkout' ? { url: 'https://checkout.stripe.test/s/1' } : path === 'portal' ? { url: 'https://portal.stripe.test' } : { seats: 9 }
    }
  })
}
registerEndpoint('/api/workspaces/ws1/billing/members/2', {
  method: 'PATCH',
  handler: async (event) => {
    posts.push({ path: 'limit', body: await readJson(event) })
    return { ok: true }
  }
})
registerEndpoint('/api/workspaces/ws1/members', {
  method: 'POST',
  handler: async (event) => {
    const body = await readJson(event) as { addSeat?: boolean }
    posts.push({ path: 'invite', body })
    if (!body.addSeat && memberPostFails > 0) {
      memberPostFails--
      const { createError } = await import('h3')
      throw createError({ statusCode: 409, data: { code: 'billing/seats-full', seats: 3, used: 3 } })
    }
    return { ok: true, invited: true }
  }
})
registerEndpoint('/api/workspaces/ws1/invites', () => [])

mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
const { goToExternal } = vi.hoisted(() => ({ goToExternal: vi.fn() }))
mockNuxtImport('goToExternal', () => goToExternal)

beforeEach(() => {
  posts.length = 0
  afterPost = null
  memberPostFails = 0
  goToExternal.mockReset()
  overview = {
    billingEnabled: true,
    minSeats: 3,
    seatsUsed: 4,
    isBillingAdmin: true,
    subscription: null,
    pool: null,
    credits: null,
    members: [
      { userId: 1, name: 'Ada', role: 'admin', limitUsd: null, limitIsDefault: true, unlimited: false, spendUsd: null },
      { userId: 2, name: 'Ben', role: 'editor', limitUsd: null, limitIsDefault: true, unlimited: false, spendUsd: null }
    ]
  }
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
})

async function mountPanel() {
  const wrapper = await mountSuspended(WorkspaceBillingPanel, { props: { workspaceId: 'ws1' } })
  mounted.push(wrapper)
  await flushPromises()
  await vi.waitFor(() => {
    if (wrapper.find('[data-testid="workspace-billing-panel"]').text().includes('Loading')) throw new Error('loading')
  })
  return wrapper
}

describe('workspace billing tab: no subscription yet', () => {
  it('starts at the people already in the workspace and shows the total', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="workspace-billing-buy"]').exists()).toBe(true)
    // 4 people → 4 seats × €12 (Team, monthly).
    expect(wrapper.find('[data-testid="workspace-billing-total"]').text()).toContain('€48')
    expect(wrapper.find('[data-testid="workspace-billing-total"]').text()).toContain('4 seats')
  })

  it('sends plan, interval, currency and seats to checkout and follows the Stripe URL', async () => {
    const wrapper = await mountPanel()
    // Disabled until the Paid Plans Terms box is ticked.
    expect(wrapper.get('[data-testid="workspace-billing-checkout"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="workspace-billing-checkout-paid-terms"] [role="checkbox"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="workspace-billing-checkout"]').trigger('click')
    await flushPromises()
    const post = posts.find(p => p.path === 'checkout')
    expect(post?.body).toEqual({ plan: 'team', interval: 'month', currency: 'eur', seats: 4, acceptPaidTerms: true })
    await vi.waitFor(() => expect(goToExternal).toHaveBeenCalledWith('https://checkout.stripe.test/s/1'))
  })
})

describe('workspace billing tab: subscription', () => {
  beforeEach(() => {
    overview.subscription = {
      plan: 'team', seats: 5, status: 'active', paymentOverdue: false, entitled: true, interval: 'month', currency: 'eur',
      currentPeriodStart: '2027-01-01T00:00:00Z', validUntil: '2027-02-01T00:00:00Z', cancelAt: null, billingAdminId: 1
    }
    overview.pool = { aiBudgetUsd: 25, aiSpendUsd: 3.2, defaultMemberLimitUsd: 10, knowledgeBytes: 5 * 2 ** 30 * 5, imageBytes: 10 * 2 ** 30 * 5, resetsAt: null }
    overview.members[0]!.limitUsd = 10
    overview.members[0]!.spendUsd = 1.5
    overview.members[1]!.limitUsd = 10
    overview.members[1]!.spendUsd = 1.7
  })

  it('shows the plan, the seats in use and every member\'s AI spend', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('[data-testid="workspace-billing-plan-name"]').text()).toContain('Team')
    expect(wrapper.find('[data-testid="workspace-billing-subscription"]').text()).toContain('4 of 5 seats used')
    expect(wrapper.find('[data-testid="workspace-billing-team-spend"]').text()).toContain('3,200 of 25,000 AI Points used')
    expect(wrapper.find('[data-testid="workspace-billing-member-2"]').text()).toContain('1,700 used · limit 10,000')
    expect(wrapper.find('[data-testid="workspace-billing-buy"]').exists()).toBe(false)
  })

  it('a payment problem shows the notice', async () => {
    overview.subscription!.status = 'past_due'
    overview.subscription!.paymentOverdue = true
    const wrapper = await mountPanel()
    const notice = wrapper.find('[data-testid="workspace-billing-payment-problem"]')
    expect(notice.exists()).toBe(true)
    // No "Renews on" under an overdue notice.
    expect(wrapper.find('[data-testid="workspace-billing-renews"]').exists()).toBe(false)
    // One click from the notice to the Stripe portal, where the card is changed.
    const manage = notice.findAll('button').find(b => b.text().includes('Manage billing'))
    await manage?.trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(goToExternal).toHaveBeenCalledWith('https://portal.stripe.test'))
  })

  async function acceptTermsAndClick(wrapper: Wrapper, testid: string) {
    await wrapper.get('[data-testid="workspace-billing-switch-paid-terms"] [role="checkbox"]').trigger('click')
    await flushPromises()
    await wrapper.get(`[data-testid="${testid}"]`).trigger('click')
    await flushPromises()
  }

  it('switching to annual sends only the billing period, so the server keeps the plan', async () => {
    const wrapper = await mountPanel()
    await acceptTermsAndClick(wrapper, 'workspace-billing-switch-interval')
    expect(posts.find(p => p.path === 'checkout')?.body).toEqual({ interval: 'year', acceptPaidTerms: true })
  })

  it('switching the plan sends only the plan, so the server keeps the billing period', async () => {
    const wrapper = await mountPanel()
    await acceptTermsAndClick(wrapper, 'workspace-billing-switch-plan')
    expect(posts.find(p => p.path === 'checkout')?.body).toEqual({ plan: 'business', acceptPaidTerms: true })
  })

  it('shows the new plan and billing period right after a switch, without a reload', async () => {
    afterPost = (path, body) => {
      if (path !== 'checkout') return
      const change = body as { plan?: 'team' | 'business', interval?: 'month' | 'year' }
      overview.subscription = { ...overview.subscription!, ...(change.plan ? { plan: change.plan } : {}), ...(change.interval ? { interval: change.interval } : {}) }
    }
    const wrapper = await mountPanel()
    const planName = () => wrapper.find('[data-testid="workspace-billing-plan-name"]').text()
    expect(planName()).toContain('Team')
    expect(planName()).toContain('monthly')

    await acceptTermsAndClick(wrapper, 'workspace-billing-switch-plan')
    await vi.waitFor(() => expect(planName()).toContain('Business'))
    expect(wrapper.get('[data-testid="workspace-billing-switch-plan"]').text()).toContain('Team')
    expect(wrapper.emitted('changed')).toHaveLength(1)

    await wrapper.get('[data-testid="workspace-billing-switch-interval"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(planName()).toContain('annual'))
    expect(planName()).toContain('Business')
    expect(wrapper.get('[data-testid="workspace-billing-switch-interval"]').text()).toContain('monthly')
    // The second switch named only the period: Business stays Business.
    expect(posts.filter(p => p.path === 'checkout').map(p => p.body)).toEqual([
      { plan: 'business', acceptPaidTerms: true },
      { interval: 'year', acceptPaidTerms: true }
    ])
  })

  it('shows the new seat count right after a seat change', async () => {
    afterPost = (path, body) => {
      if (path === 'seats') overview.subscription = { ...overview.subscription!, seats: (body as { seats: number }).seats }
    }
    const wrapper = await mountPanel()
    const vm = wrapper.vm as unknown as { seatsDraft: number }
    vm.seatsDraft = 9
    await flushPromises()
    await wrapper.get('[data-testid="workspace-billing-save-seats"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('[data-testid="workspace-billing-subscription"]').text()).toContain('4 of 9 seats used'))
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('a renewing subscription says when it renews, a cancelled one when it ends', async () => {
    const renewing = await mountPanel()
    expect(renewing.find('[data-testid="workspace-billing-renews"]').text()).toContain('Renews on')
    expect(renewing.find('[data-testid="workspace-billing-ends"]').exists()).toBe(false)

    overview.subscription!.cancelAt = '2027-02-01T00:00:00Z'
    const ending = await mountPanel()
    expect(ending.find('[data-testid="workspace-billing-ends"]').text()).toContain('Ends on')
    expect(ending.find('[data-testid="workspace-billing-renews"]').exists()).toBe(false)
  })

  it('saves "no limit" for a member as limitUsd: null', async () => {
    const wrapper = await mountPanel()
    const vm = wrapper.vm as unknown as { limitDrafts: Record<number, { mode: string, points: number }> }
    vm.limitDrafts[2] = { mode: 'none', points: 10000 }
    await flushPromises()
    await wrapper.get('[data-testid="workspace-billing-limit-save-2"]').trigger('click')
    await flushPromises()
    expect(posts.find(p => p.path === 'limit')?.body).toEqual({ limitUsd: null })
  })

  it('a custom limit is entered in AI Points and saved in USD', async () => {
    const wrapper = await mountPanel()
    const vm = wrapper.vm as unknown as { limitDrafts: Record<number, { mode: string, points: number }> }
    // The member's current limit ($10) is offered as points.
    expect(vm.limitDrafts[2]?.points).toBe(10000)
    vm.limitDrafts[2] = { mode: 'custom', points: 7500 }
    await flushPromises()
    await wrapper.get('[data-testid="workspace-billing-limit-save-2"]').trigger('click')
    await flushPromises()
    expect(posts.find(p => p.path === 'limit')?.body).toEqual({ limitUsd: 7.5 })
  })
})

describe('invite dialog: paid seats', () => {
  async function mountModal() {
    const Host = defineComponent({
      setup() {
        const open = ref(true)
        return () => h(WorkspaceMembersModal, {
          'workspaceId': 'ws1',
          'workspaceName': 'Acme',
          'members': [{ userId: 1, name: 'Ada', email: null, login: null, role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' }],
          'myRole': 'admin',
          'myUserId': 1,
          'billing': { seats: 3, seatsUsed: 3, status: 'active', plan: 'team', interval: 'month', currency: 'eur' },
          'open': open.value,
          'onUpdate:open': (v: boolean) => { open.value = v }
        })
      }
    })
    const wrapper = await mountSuspended(Host, { attachTo: document.body })
    mounted.push(wrapper)
    await flushPromises()
    return wrapper
  }

  it('shows the seat counter, and a full workspace asks before adding a seat', async () => {
    memberPostFails = 1
    await mountModal()
    const counter = document.body.querySelector('[data-testid="workspace-seat-counter"]')
    expect(counter?.textContent).toContain('3 of 3 seats used')

    const input = document.body.querySelector('[data-testid="workspace-invite-email"] input, input[data-testid="workspace-invite-email"]') as HTMLInputElement
    input.value = 'fourth@example.com'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    ;(document.body.querySelector('[data-testid="workspace-invite-submit"]') as HTMLElement).click()
    await vi.waitFor(() => {
      if (!document.body.querySelector('[data-testid="workspace-add-seat-confirm"]')) throw new Error('no confirm')
    })
    const confirm = document.body.querySelector('[data-testid="workspace-add-seat-confirm"]')!
    expect(confirm.textContent).toContain('All 3 seats are taken')
    await vi.waitFor(() => {
      if (!confirm.textContent?.includes('€12 per month')) throw new Error('no price yet')
    })

    ;(document.body.querySelector('[data-testid="workspace-add-seat-submit"]') as HTMLElement).click()
    await vi.waitFor(() => {
      if (!posts.some(p => p.path === 'invite' && (p.body as { addSeat?: boolean }).addSeat === true)) throw new Error('no second post')
    })
    expect(posts.filter(p => p.path === 'invite').map(p => p.body)).toEqual([
      { email: 'fourth@example.com', role: 'editor' },
      { email: 'fourth@example.com', role: 'editor', addSeat: true }
    ])
  })
})
