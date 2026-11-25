// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, ref, type WritableComputedRef } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { useRouteQueryChoice, useRouteTab } from '~/composables/platform/useRouteTab'

// A page's tab (and other fixed choices) kept in the query string, so a
// view can be linked: read with a fallback, written with `router.replace`.

const allowed = ref<readonly string[]>(['overview', 'brand-kit', 'billing'])
let tab: WritableComputedRef<string>
let range: WritableComputedRef<string>

const Probe = defineComponent({
  setup() {
    tab = useRouteTab(() => allowed.value, 'overview')
    range = useRouteQueryChoice('range', ['7', '30'], '30')
    return () => h('p', `${tab.value}/${range.value}`)
  }
})

async function open(path: string) {
  allowed.value = ['overview', 'brand-kit', 'billing']
  const w = await mountSuspended(Probe, { route: path })
  return { w, router: useRouter() }
}

describe('useRouteTab', () => {
  it('reads the tab from the URL', async () => {
    const { w } = await open('/admin/stats?tab=brand-kit&range=7')
    expect(w.text()).toBe('brand-kit/7')
  })

  it('falls back to the default for a missing, unknown or repeated value', async () => {
    expect((await open('/admin/stats')).w.text()).toBe('overview/30')
    expect((await open('/admin/stats?tab=secret&range=13')).w.text()).toBe('overview/30')
    expect((await open('/admin/stats?tab=billing&tab=billing')).w.text()).toBe('overview/30')
  })

  it('falls back for a tab the viewer may not see, and shows it once allowed', async () => {
    const { w } = await open('/admin/stats?tab=billing')
    allowed.value = ['overview']
    await flushPromises()
    expect(w.text()).toBe('overview/30')
    allowed.value = ['overview', 'billing']
    await flushPromises()
    expect(w.text()).toBe('billing/30')
  })

  it('writes the tab with replace, keeps the other parameters and the hash', async () => {
    const { w, router } = await open('/admin/stats?range=7#members')
    const before = window.history.length
    tab.value = 'billing'
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ range: '7', tab: 'billing' }))
    expect(router.currentRoute.value.hash).toBe('#members')
    expect(window.history.length).toBe(before)
    expect(w.text()).toBe('billing/7')
  })

  it('drops the parameter for the default, so the default view has a clean URL', async () => {
    const { router } = await open('/admin/stats?tab=billing&range=7')
    tab.value = 'overview'
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ range: '7' }))
    range.value = '30'
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}))
  })
})
