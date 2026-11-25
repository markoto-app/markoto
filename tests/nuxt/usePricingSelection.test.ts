// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import { usePricingSelection } from '~/composables/billing/usePricingSelection'

// The pricing page's choice survives a sign-in from the page: the sign-in
// link names the page with the choice to come back to, and the page reads
// it from its query on load (then drops it from the address bar).

let selection: ReturnType<typeof usePricingSelection>

const Probe = defineComponent({
  setup() {
    selection = usePricingSelection()
    return () => h('p', `${selection.interval.value}/${selection.currency.value}/${selection.teamPlan.value}/${selection.seats.value}`)
  }
})

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

describe('usePricingSelection', () => {
  it('starts from the defaults, and signing in returns to the plain page', async () => {
    setConfig({ loginProviders: ['github'] })
    const w = await mountSuspended(Probe, { route: '/pricing' })
    expect(w.text()).toBe('month/eur/team/3')
    expect(selection.signInPath.value).toBe('/auth/github?return=%2Fpricing')
  })

  it('the sign-in link carries the current choice', async () => {
    setConfig({ loginProviders: ['github'] })
    await mountSuspended(Probe, { route: '/pricing' })
    selection.interval.value = 'year'
    selection.teamPlan.value = 'business'
    selection.seats.value = 8
    expect(decodeURIComponent(selection.signInPath.value ?? '')).toBe('/auth/github?return=/pricing?interval=year&plan=business&seats=8')
  })

  it('reads a linked choice, then drops it from the address bar', async () => {
    setConfig({ loginProviders: ['github'] })
    const w = await mountSuspended(Probe, { route: '/pricing?interval=year&currency=chf&plan=business&seats=5&checkout=cancelled' })
    expect(w.text()).toBe('year/chf/business/5')
    const router = useRouter()
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ checkout: 'cancelled' }))
    expect(w.text()).toBe('year/chf/business/5')
  })

  it('without a sign-in provider there is no sign-in link', async () => {
    setConfig({ loginProviders: [] })
    await mountSuspended(Probe, { route: '/pricing' })
    expect(selection.signInPath.value).toBeNull()
  })
})
