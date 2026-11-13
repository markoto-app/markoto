import { describe, it, expect, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import { useApi } from '~/utils/api/client'

// `useApi` is the typed caller for calls made while the page renders: it must
// go through `useRequestFetch()` (which forwards the visitor's cookies on the
// server), not the global `$fetch` (which would call the route anonymously).

const { requestFetch } = vi.hoisted(() => ({ requestFetch: vi.fn(async (_url: string, _opts: object) => ({ ok: true })) }))
mockNuxtImport('useRequestFetch', () => () => requestFetch)

describe('useApi', () => {
  it('sends the call through the request-aware fetch, with the path filled in and the method upper-cased', async () => {
    const api = useApi()
    await api('/api/docs/:docId/token', { path: { docId: 'a b' }, query: { refresh: '1' } })
    expect(requestFetch).toHaveBeenCalledWith('/api/docs/a%20b/token', expect.objectContaining({ query: { refresh: '1' } }))

    requestFetch.mockClear()
    await api('/api/user/sessions/revoke', { method: 'post' })
    expect(requestFetch).toHaveBeenCalledWith('/api/user/sessions/revoke', expect.objectContaining({ method: 'POST' }))
  })

  it('refuses a missing path parameter instead of calling a wrong URL', () => {
    const api = useApi()
    // @ts-expect-error the path parameter is required on this route
    expect(() => api('/api/docs/:docId/token')).toThrow(/missing path parameter docId/)
  })
})
