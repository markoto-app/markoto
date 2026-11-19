// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { DocListParams, ExplorerScope } from '~/composables/explorer/useExplorerData'
import { doc, folder } from './fixtures'

// The explorer's live list: the scope's change counter is read on mount,
// every 15 s while the tab is visible and on focus; a different counter
// (someone else changed the scope) refetches the folders and the document
// pages, the same counter refetches nothing. An own change refetches at
// once and takes the new counter, so the next poll does not refetch again.

const m = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  version: 1,
  hits: new Map<string, number>()
}))

mockNuxtImport('apiFetch', () => m.apiFetch)

// eslint-disable-next-line import/first -- mockNuxtImport must be hoisted above the import it mocks
import { useExplorerData } from '~/composables/explorer/useExplorerData'

function hit(name: string): void {
  m.hits.set(name, (m.hits.get(name) ?? 0) + 1)
}
const hits = (name: string): number => m.hits.get(name) ?? 0

function respond(url: string, opts: { query?: Record<string, unknown> } = {}) {
  switch (url) {
    case '/api/workspaces/:wsId/version':
    case '/api/user/explorer-version':
      hit('version')
      return Promise.resolve({ version: m.version })
    case '/api/workspaces/:wsId/folders':
    case '/api/user/folders':
      hit('folders')
      return Promise.resolve({ folders: [folder('f1')] })
    case '/api/workspaces/:wsId/documents':
    case '/api/user/personal-documents':
      hit('docs')
      return Promise.resolve(opts.query?.cursor
        ? { items: [doc('d3')], total: 3, nextCursor: null }
        : { items: [doc('d1'), doc('d2')], total: 3, nextCursor: 'c1' })
    default:
      return Promise.reject(new Error(`unexpected ${url}`))
  }
}

let visibility: DocumentVisibilityState = 'visible'
const mounted: Array<{ unmount: () => void }> = []
let wsSeq = 0

/** A fresh workspace per test, so no test sees another's cached queries. */
async function mountData(scope: ExplorerScope = { kind: 'workspace', workspaceId: `ws-${++wsSeq}` }) {
  let api!: ReturnType<typeof useExplorerData>
  const params = ref<DocListParams>({ folder: 'root', sort: 'updated', dir: 'desc', q: '' })
  const scopeRef = ref(scope)
  const wrapper = await mountSuspended(defineComponent({
    setup() {
      api = useExplorerData(scopeRef, params)
      return () => h('div')
    }
  }))
  mounted.push(wrapper)
  await flushPromises()
  return { api, params, scopeRef }
}

beforeEach(() => {
  m.apiFetch.mockReset()
  m.apiFetch.mockImplementation(respond)
  m.hits.clear()
  m.version = 1
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useExplorerData', () => {
  it('loads the folders and the first page, then the next page by cursor', async () => {
    const { api } = await mountData()
    await vi.waitFor(() => expect(api.docRows.value.map(d => d.docId)).toEqual(['d1', 'd2']))
    expect(api.total.value).toBe(3)
    expect(api.folders.data.value?.map(f => f.folderId)).toEqual(['f1'])
    await api.docs.loadNextPage()
    await vi.waitFor(() => expect(api.docRows.value.map(d => d.docId)).toEqual(['d1', 'd2', 'd3']))
    expect(m.apiFetch).toHaveBeenCalledWith('/api/workspaces/:wsId/documents', expect.objectContaining({
      path: { wsId: expect.stringMatching(/^ws-/) },
      query: expect.objectContaining({ folder: 'root', sort: 'updated', dir: 'desc', cursor: 'c1' })
    }))
  })

  it('refetches on focus only when the counter moved', async () => {
    await mountData()
    await vi.waitFor(() => expect(hits('docs')).toBe(1))
    const folders = hits('folders')

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    await vi.waitFor(() => expect(hits('version')).toBeGreaterThanOrEqual(2))
    expect(hits('folders')).toBe(folders)

    m.version = 2
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(hits('folders')).toBe(folders + 1))
    await vi.waitFor(() => expect(hits('docs')).toBe(2))
  })

  it('polls every 15 s while visible and not while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await mountData()
    await vi.waitFor(() => expect(hits('version')).toBe(1))

    vi.advanceTimersByTime(15_000)
    await flushPromises()
    expect(hits('version')).toBe(2)

    visibility = 'hidden'
    vi.advanceTimersByTime(30_000)
    await flushPromises()
    expect(hits('version')).toBe(2)

    // Back to the tab: checked at once.
    visibility = 'visible'
    m.version = 5
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(hits('version')).toBe(3))
    await vi.waitFor(() => expect(hits('folders')).toBe(2))
  })

  it('after an own change: refetches now and does not refetch again on the next poll', async () => {
    // Personal scope: the only test that uses it, so its cache is fresh too.
    const { api } = await mountData({ kind: 'personal' })
    await vi.waitFor(() => expect(hits('docs')).toBe(1))
    m.version = 7
    await api.afterChange()
    await vi.waitFor(() => expect(hits('folders')).toBe(2))
    const after = hits('folders')

    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    await vi.waitFor(() => expect(hits('version')).toBeGreaterThanOrEqual(3))
    expect(hits('folders')).toBe(after)
    expect(m.apiFetch).toHaveBeenCalledWith('/api/user/explorer-version')
  })

  it('keeps polling after a failed check', async () => {
    await mountData()
    await vi.waitFor(() => expect(hits('version')).toBe(1))
    m.apiFetch.mockImplementationOnce(() => Promise.reject(new Error('offline')))
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    m.version = 3
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(hits('folders')).toBe(2))
  })

  it('a new scope starts a new counter instead of refetching on the old one', async () => {
    const { scopeRef } = await mountData()
    await vi.waitFor(() => expect(hits('version')).toBe(1))
    m.version = 9
    scopeRef.value = { kind: 'workspace', workspaceId: 'ws2' }
    await vi.waitFor(() => expect(hits('version')).toBe(2))
    await vi.waitFor(() => expect(m.apiFetch).toHaveBeenCalledWith('/api/workspaces/:wsId/folders', expect.objectContaining({ path: { wsId: 'ws2' } })))
  })
})
