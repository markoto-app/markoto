// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { useQueryCache } from '@pinia/colada'
import type { UserBilling } from '~/composables/billing/useBilling'
import type { BillingMode } from '~~/shared/config/billingMode'
import { billingKeys } from '~/queries/billing'
import { useAiWayForward } from '~/composables/ai/useAiWayForward'
import { useAiWorkspaceContext } from '~/composables/ai/useAiAvailability'

// The ways forward when the personal AI budget is used up (dictation,
// voice input, the comment trigger, image generation, design import):
// a purchase where one applies (Upgrade for Free, AI Points for Pro where
// top-ups are sold, the coming-soon page), and always the own key.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
const push = vi.fn(async () => undefined)

const BILLING = { plan: 'free' } as unknown as UserBilling

async function wayForward(mode: BillingMode, plan: 'free' | 'pro', workspace: string | null = null) {
  useState<BillingMode>('billing-mode').value = mode
  useQueryCache().setQueryData<UserBilling>(billingKeys.user(), { ...BILLING, plan })
  let api: ReturnType<typeof useAiWayForward> | null = null
  await mountSuspended(defineComponent({
    setup() {
      useAiWorkspaceContext().value = workspace
      vi.spyOn(useRouter(), 'push').mockImplementation(push)
      api = useAiWayForward()
      return () => h('div')
    }
  }))
  return api!
}

const labels = (actions: Array<{ label: string }>) => actions.map(a => a.label)
const ON: BillingMode = { billingEnabled: true, plansComingSoon: false, topupsEnabled: true }

beforeEach(() => {
  push.mockClear()
})

describe('useAiWayForward', () => {
  it('billing on, Free: Upgrade then the own key, with the upgrade sentence', async () => {
    const w = await wayForward(ON, 'free')
    expect(labels(w.budgetActions())).toEqual(['Upgrade', 'Add your own key'])
    expect(w.budgetDescription()).toBe('Your AI Points for this period are used up. Upgrade your plan to keep going.')
    w.ownKeyAction().onClick()
    expect(push).toHaveBeenCalledWith('/settings/ai')
  })

  it('billing on, Pro: Buy AI Points (to the profile section), or nothing to buy without top-ups', async () => {
    const w = await wayForward(ON, 'pro')
    expect(labels(w.budgetActions())).toEqual(['Buy AI Points', 'Add your own key'])
    expect(w.budgetDescription()).toBe('Your AI Points for this period are used up. Buy extra AI Points to keep going.')
    w.purchaseAction()!.onClick()
    expect(push).toHaveBeenCalledWith('/settings/profile#ai-points')

    const off = await wayForward({ ...ON, topupsEnabled: false }, 'pro')
    expect(off.purchaseAction()).toBeNull()
    expect(labels(off.budgetActions())).toEqual(['Add your own key'])
    expect(off.budgetDescription()).toBe('Your AI Points for this period are used up. They refill when the next period starts.')
  })

  it('in a workspace document: no purchase (its admins decide), the workspace sentence', async () => {
    const w = await wayForward(ON, 'free', 'ws_1')
    expect(labels(w.budgetActions())).toEqual(['Add your own key'])
    expect(w.budgetDescription()).toBe('This workspace’s AI Points for this month are used up. Ask a workspace admin for more.')
  })

  it('paid plans coming soon: the coming-soon page; self-hosted: nothing to buy', async () => {
    const soon = await wayForward({ billingEnabled: false, plansComingSoon: true }, 'free')
    expect(soon.purchaseAction()?.color).toBe('neutral')
    expect(soon.budgetActions()).toHaveLength(2)
    expect(soon.budgetDescription()).toBe('Your AI Points for this period are used up. They refill next period.')

    const self = await wayForward({ billingEnabled: false, plansComingSoon: false }, 'free')
    expect(self.purchaseAction()).toBeNull()
    expect(labels(self.budgetActions())).toEqual(['Add your own key'])
    expect(self.budgetDescription()).toBe('Your AI Points for this period are used up. They refill when the next period starts.')
  })
})
