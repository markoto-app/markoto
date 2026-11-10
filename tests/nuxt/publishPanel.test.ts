// @vitest-environment nuxt
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { SharingPublishPanel } from '#components'
import { readBody } from 'h3'

// Publish as a web page (WP13): the share dialog's publish section —
// publish, rename the address, unpublish.

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
const calls: Array<{ method: string, body: unknown }> = []
let published = false
let slug = 'field-notes-k3x9za'

const view = () => published
  ? { published: true, page: { slug, url: `https://markoto.test/p/${slug}`, indexable: false, publishedAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z' } }
  : { published: false, page: null }

registerEndpoint('/api/docs/doc1/publish', async (event) => {
  const body = event.method === 'GET' || event.method === 'DELETE' ? undefined : await readBody(event)
  calls.push({ method: event.method, body })
  if (event.method === 'POST') published = true
  if (event.method === 'DELETE') published = false
  if (event.method === 'PATCH') slug = (body as { slug?: string }).slug ?? slug
  return view()
})

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  calls.length = 0
  published = false
  slug = 'field-notes-k3x9za'
})

describe('SharingPublishPanel', () => {
  it('publishes without search indexing by default, then shows the address', async () => {
    const w = await mountSuspended(SharingPublishPanel, { props: { docId: 'doc1' } })
    mounted.push(w)
    await vi.waitFor(() => expect(w.find('[data-testid="publish-submit"]').exists()).toBe(true))
    await w.get('[data-testid="publish-submit"]').trigger('click')
    await vi.waitFor(() => expect(w.find('[data-testid="publish-url"]').exists()).toBe(true))
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ indexable: false })
    expect((w.get('[data-testid="publish-url"]').element as HTMLInputElement).value).toBe('https://markoto.test/p/field-notes-k3x9za')
  })

  it('renames the address and unpublishes', async () => {
    published = true
    const w = await mountSuspended(SharingPublishPanel, { props: { docId: 'doc1' } })
    mounted.push(w)
    await vi.waitFor(() => expect(w.find('[data-testid="publish-slug"]').exists()).toBe(true))
    await w.get('[data-testid="publish-slug"]').setValue('q3-letter')
    await w.get('[data-testid="publish-slug-save"]').trigger('click')
    await vi.waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(true))
    expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ slug: 'q3-letter' })
    await vi.waitFor(() => expect((w.get('[data-testid="publish-url"]').element as HTMLInputElement).value).toContain('/p/q3-letter'))
    await w.get('[data-testid="publish-unpublish"]').trigger('click')
    await vi.waitFor(() => expect(w.find('[data-testid="publish-submit"]').exists()).toBe(true))
    expect(calls.some(c => c.method === 'DELETE')).toBe(true)
  })
})
