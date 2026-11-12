// @vitest-environment nuxt
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { hydrateQueryCache, serializeQueryCache, useQueryCache } from '@pinia/colada'
import { aiKeys, useAiAvailabilityQuery, useAiCreditsQuery, useSaveAiProvider } from '~/queries/ai'
import { billingKeys, useInvalidatePlan, usePlanPricesQuery, useUserBillingQuery } from '~/queries/billing'
import { themeKeys, useCreateSavedTheme, useDeleteSavedTheme, useSavedThemes } from '~/queries/themes'
import { useCreateWorkspace, useDeleteWorkspace, useMyWorkspaces, workspaceKeys } from '~/queries/workspaces'
import { accountKeys } from '~/queries/account'

// The query layer (app/queries): each domain's keys nest under its root, so
// invalidating the root covers every child, and each mutation refreshes the
// reads it changes. Endpoints count their hits; components mounted here only
// hold the query, as a page would.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))

const hitCounts = new Map<string, number>()
function count(name: string): number {
  const next = (hitCounts.get(name) ?? 0) + 1
  hitCounts.set(name, next)
  return next
}
const hits = (name: string): number => hitCounts.get(name) ?? 0

let themes = [{ themeId: 't1', name: 'Report' }]
registerEndpoint('/api/themes', {
  method: 'GET',
  handler: () => {
    count('themes')
    return { themes }
  }
})
registerEndpoint('/api/themes', {
  method: 'POST',
  handler: () => {
    themes = [...themes, { themeId: 't2', name: 'Letter' }]
    return { themeId: 't2' }
  }
})
registerEndpoint('/api/themes/t1', {
  method: 'DELETE',
  handler: () => {
    themes = themes.filter(t => t.themeId !== 't1')
    return { ok: true }
  }
})
registerEndpoint('/api/user/billing', () => ({ plan: 'free', ownedWorkspaces: count('billing') - 1, workspacesOwnedLimit: 3 }))
registerEndpoint('/api/user/workspaces', () => {
  count('workspaces')
  return []
})
registerEndpoint('/api/workspaces', { method: 'POST', handler: () => ({ workspaceId: 'w-new' }) })
registerEndpoint('/api/workspaces/w-old', { method: 'DELETE', handler: () => ({ ok: true }) })
registerEndpoint('/api/ai/credits', (event) => {
  const ws = new URL(event.path, 'http://x').searchParams.get('workspaceId') ?? 'personal'
  count(`credits:${ws}`)
  return { pointsRemaining: 10, pointsTotal: 100 }
})
registerEndpoint('/api/ai/availability', (event) => {
  const ws = new URL(event.path, 'http://x').searchParams.get('workspaceId') ?? 'personal'
  count(`availability:${ws}`)
  return { chat: { available: true } }
})
registerEndpoint('/api/user/ai-providers/chat', { method: 'PUT', handler: () => ({ verify: { code: 'ok' } }) })
registerEndpoint('/api/billing/prices', () => {
  count('prices')
  return { prices: { eur: {} } }
})

/** Mounts a component whose setup runs `setup` and keeps its result for the test. */
async function withSetup<T>(setup: () => T): Promise<{ result: T, unmount: () => void }> {
  let result!: T
  const wrapper = await mountSuspended(defineComponent({
    setup() {
      result = setup()
      return () => h('div')
    }
  }))
  await flushPromises()
  return { result, unmount: () => wrapper.unmount() }
}

const mounted: Array<() => void> = []
async function use<T>(setup: () => T): Promise<T> {
  const { result, unmount } = await withSetup(setup)
  mounted.push(unmount)
  return result
}

afterEach(() => {
  mounted.splice(0).forEach(unmount => unmount())
  const cache = useQueryCache()
  for (const entry of cache.getEntries()) cache.remove(entry)
  hitCounts.clear()
  themes = [{ themeId: 't1', name: 'Report' }]
})

describe('key factories', () => {
  it('nest every key under its domain root, so a root invalidation reaches the children', () => {
    const under = (key: readonly unknown[], root: readonly unknown[]) => root.every((part, i) => key[i] === part)
    expect(under(billingKeys.user(), billingKeys.root)).toBe(true)
    expect(under(billingKeys.prices(), billingKeys.root)).toBe(true)
    expect(under(aiKeys.creditsFor('ws1'), aiKeys.credits())).toBe(true)
    expect(under(aiKeys.creditsFor(null), aiKeys.credits())).toBe(true)
    expect(under(aiKeys.availabilityFor('ws1'), aiKeys.availability())).toBe(true)
    expect(under(aiKeys.providers(), aiKeys.root)).toBe(true)
    expect(under(themeKeys.saved(), themeKeys.root)).toBe(true)
    expect(under(workspaceKeys.mine(), workspaceKeys.root)).toBe(true)
    expect(under(accountKeys.status(), accountKeys.root)).toBe(true)
  })

  it('keeps one budget per workspace apart from the personal one', () => {
    expect(aiKeys.creditsFor('ws1')).not.toEqual(aiKeys.creditsFor(null))
  })
})

describe('defaults (colada.options.ts)', () => {
  it('reach every query: no refetch on focus or reconnect, a short stale time', async () => {
    await use(() => useSavedThemes())
    const entry = useQueryCache().getEntries({ key: themeKeys.saved(), exact: true })[0]
    expect(entry?.options).toMatchObject({ refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 5_000 })
  })
})

describe('shared reads', () => {
  it('several consumers of one query share a single request', async () => {
    await use(() => useSavedThemes())
    await use(() => useSavedThemes())
    await use(() => useSavedThemes())
    expect(hits('themes')).toBe(1)
  })

  it('a session snapshot is fetched once and not again when another consumer mounts later', async () => {
    await use(() => useUserBillingQuery())
    await use(() => useUserBillingQuery())
    expect(hits('billing')).toBe(1)
  })

  it('an inactive consumer (closed dialog) does not fetch', async () => {
    const open = ref(false)
    await use(() => useSavedThemes(open))
    expect(hits('themes')).toBe(0)
    open.value = true
    await flushPromises()
    expect(hits('themes')).toBe(1)
  })
})

describe('saved themes — mutations refresh the list', () => {
  it('creating a theme refreshes every list on screen before resolving', async () => {
    const { themes: list } = await use(() => useSavedThemes())
    const create = await use(() => useCreateSavedTheme())
    expect(list.value.map(t => t.name)).toEqual(['Report'])

    await create.mutateAsync({ name: 'Letter', description: null, theme: {} as never })
    expect(hits('themes')).toBe(2)
    expect(list.value.map(t => t.name)).toEqual(['Report', 'Letter'])
  })

  it('deleting a theme refreshes the list', async () => {
    const { themes: list } = await use(() => useSavedThemes())
    const remove = await use(() => useDeleteSavedTheme())
    await remove.mutateAsync('t1')
    expect(list.value).toEqual([])
  })
})

describe('workspaces — create / delete refresh the list and the owned-workspace counter', () => {
  it('creating a workspace re-reads the list and the billing counters', async () => {
    await use(() => useMyWorkspaces())
    const billing = await use(() => useUserBillingQuery())
    const create = await use(() => useCreateWorkspace())
    expect(billing.data.value?.ownedWorkspaces).toBe(0)

    await create.mutateAsync({ name: 'Team' })
    await vi.waitFor(() => expect(billing.data.value?.ownedWorkspaces).toBe(1))
    expect(hits('workspaces')).toBe(2)
  })

  it('deleting a workspace marks the counters stale even when no view shows them', async () => {
    const del = await use(() => useDeleteWorkspace())
    // Loaded earlier by the dashboard, which is gone now.
    const { unmount } = await withSetup(() => useUserBillingQuery())
    unmount()
    expect(hits('billing')).toBe(1)

    await del.mutateAsync('w-old')
    await flushPromises()
    expect(hits('billing')).toBe(1)
    // Back on the dashboard: the stale counter is re-read on mount.
    await use(() => useUserBillingQuery())
    expect(hits('billing')).toBe(2)
  })
})

describe('AI — budgets and availability', () => {
  it('a plan change re-reads the billing snapshot and every AI budget on screen', async () => {
    await use(() => useUserBillingQuery())
    await use(() => useAiCreditsQuery(null))
    await use(() => useAiCreditsQuery('ws1'))
    const invalidatePlan = await use(() => useInvalidatePlan())

    await invalidatePlan()
    expect(hits('billing')).toBe(2)
    expect(hits('credits:personal')).toBe(2)
    expect(hits('credits:ws1')).toBe(2)
  })

  it('saving a provider refreshes availability for every workspace context', async () => {
    await use(() => useAiAvailabilityQuery(null))
    await use(() => useAiAvailabilityQuery('ws1'))
    const save = await use(() => useSaveAiProvider())

    await save.mutateAsync({ capability: 'chat', body: { baseUrl: 'https://api.example.com/v1', model: 'm' } })
    await vi.waitFor(() => {
      expect(hits('availability:personal')).toBe(2)
      expect(hits('availability:ws1')).toBe(2)
    })
  })
})

describe('SSR hydration', () => {
  it('a query rendered on the server is hydrated from the payload without a second client request', async () => {
    const cache = useQueryCache()
    // What the server render leaves in the payload (`pinia_colada`).
    const serverData = { prices: { eur: { pro: { month: 9, year: 90 } } } }
    cache.setQueryData(billingKeys.prices(), serverData)
    const payload = JSON.parse(JSON.stringify(serializeQueryCache(cache)))
    cache.remove(cache.getEntries({ key: billingKeys.prices(), exact: true })[0]!)

    hydrateQueryCache(cache, payload)
    const prices = await use(() => usePlanPricesQuery())
    await prices.refresh()
    expect(prices.data.value).toEqual(serverData)
    expect(hits('prices')).toBe(0)
  })
})
