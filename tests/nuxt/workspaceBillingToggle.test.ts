// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { WorkspaceBillingToggle } from '#components'
import type { BillingMode } from '~~/shared/config/billingMode'
import type { PlanName } from '~~/shared/config/tiers'

// The workspace AI-sponsorship toggle shows options the account doesn't
// have as DISABLED with a note + /pricing link instead of hiding them:
//   - billing on, plan below Max → "needs an upgrade" + link;
//   - billing off + plans coming soon → "coming with paid plans" + link;
//   - billing on, Max/Ultra → a working switch.
// A disabled switch must never reach the billing endpoint.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

let plan: PlanName = 'free'
let billingHits = 0
registerEndpoint('/api/user/billing', () => {
  billingHits++
  return { plan, periodStart: new Date().toISOString() }
})
let patchHits = 0
registerEndpoint('/api/workspaces/ws1/billing', {
  method: 'PATCH',
  handler: () => {
    patchHits++
    return { ok: true }
  }
})

function setMode(mode: BillingMode): void {
  useState<BillingMode>('billing-mode').value = mode
}

async function mountToggle(aiEnabled = false) {
  const wrapper = await mountSuspended(WorkspaceBillingToggle, {
    props: { workspaceId: 'ws1', aiEnabled, billingOwnerId: null }
  })
  await flushPromises()
  return wrapper
}

function switchEl(wrapper: Awaited<ReturnType<typeof mountToggle>>) {
  return wrapper.get('[data-testid="workspace-ai-sponsoring-toggle"]')
}

beforeEach(() => {
  billingHits = 0
  patchHits = 0
})

describe('WorkspaceBillingToggle', () => {
  it('billing on + Free plan: disabled, with an upgrade note linking /pricing', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    plan = 'free'
    const wrapper = await mountToggle()
    expect(wrapper.get('[data-testid="workspace-ai-sponsoring"]').attributes('data-sponsorship-state')).toBe('needsUpgrade')
    expect(switchEl(wrapper).attributes('disabled')).toBeDefined()
    const locked = wrapper.get('[data-testid="workspace-ai-sponsoring-locked"]')
    expect(locked.text()).toContain('Free')
    expect(locked.text()).toContain('Max or Ultra')
    expect(wrapper.get('[data-testid="workspace-ai-sponsoring-pricing"]').attributes('href')).toBe('/pricing')

    await switchEl(wrapper).trigger('click')
    await flushPromises()
    expect(patchHits).toBe(0)
  })

  it('billing on + Max plan: the switch works', async () => {
    setMode({ billingEnabled: true, plansComingSoon: false })
    plan = 'max'
    const wrapper = await mountToggle()
    expect(wrapper.get('[data-testid="workspace-ai-sponsoring"]').attributes('data-sponsorship-state')).toBe('available')
    expect(switchEl(wrapper).attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="workspace-ai-sponsoring-locked"]').exists()).toBe(false)

    await switchEl(wrapper).trigger('click')
    await flushPromises()
    expect(patchHits).toBe(1)
  })

  it('plans coming soon: disabled with a "coming with paid plans" note, no billing calls at all', async () => {
    setMode({ billingEnabled: false, plansComingSoon: true })
    plan = 'ultra'
    const wrapper = await mountToggle()
    expect(wrapper.get('[data-testid="workspace-ai-sponsoring"]').attributes('data-sponsorship-state')).toBe('comingSoon')
    expect(switchEl(wrapper).attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="workspace-ai-sponsoring-locked"]').text()).toContain('Coming with paid plans')
    expect(wrapper.get('[data-testid="workspace-ai-sponsoring-pricing"]').attributes('href')).toBe('/pricing')

    await switchEl(wrapper).trigger('click')
    await flushPromises()
    expect(patchHits).toBe(0)
    expect(billingHits).toBe(0)
  })
})
