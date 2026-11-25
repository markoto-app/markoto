// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NuxtPage } from '#components'

// The workspace page keeps its tab in `?tab=`, so a tab can be linked
// (`/w/:id?tab=settings`); a tab the member's role doesn't offer falls
// back to Documents, and clicking a tab updates the URL.

const Route = defineComponent({ render: () => h(NuxtPage) })

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  ready: ref(true),
  fetch: vi.fn(),
  clear: vi.fn()
}))

function workspace(workspaceId: string, myRole: 'admin' | 'editor') {
  return {
    workspace: {
      workspaceId,
      name: 'Tabs test',
      description: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      myRole,
      ownerId: 1,
      plan: 'free',
      defaultTheme: null,
      pooled: false,
      billing: null,
      sso: null,
      auditLog: null,
      guests: null,
      brandKit: null,
      brandLocked: false
    },
    documents: [],
    members: []
  }
}

registerEndpoint('/api/workspaces/ws-admin', () => workspace('ws-admin', 'admin'))
registerEndpoint('/api/workspaces/ws-editor', () => workspace('ws-editor', 'editor'))

function activeTab(page: Awaited<ReturnType<typeof mountSuspended>>) {
  return page.find('[role="tab"][data-state="active"]')
}

describe('workspace page: the tab is part of the URL', () => {
  it('opens the tab named in the URL', async () => {
    const page = await mountSuspended(Route, { route: '/w/ws-admin?tab=settings' })
    await vi.waitFor(() => expect(activeTab(page).text()).toContain('Settings'))
    page.unmount()
  })

  it('falls back to Documents for a tab the role does not offer', async () => {
    const page = await mountSuspended(Route, { route: '/w/ws-editor?tab=settings' })
    await vi.waitFor(() => expect(page.text()).toContain('Tabs test'))
    expect(page.findAll('[role="tab"]').map(t => t.text()).join(' ')).not.toContain('Settings')
    expect(activeTab(page).text()).toContain('Documents')
    page.unmount()
  })

  it('writes the chosen tab to the URL, and drops it for Documents', async () => {
    const page = await mountSuspended(Route, { route: '/w/ws-admin' })
    const router = useRouter()
    await vi.waitFor(() => expect(activeTab(page).text()).toContain('Documents'))
    const usage = page.findAll('[role="tab"]').find(t => t.text().includes('Usage'))!
    await usage.trigger('mousedown', { button: 0 })
    await usage.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'usage' }))
    await vi.waitFor(() => expect(activeTab(page).text()).toContain('Usage'))
    const documents = page.findAll('[role="tab"]').find(t => t.text().includes('Documents'))!
    await documents.trigger('mousedown', { button: 0 })
    await documents.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({}))
    page.unmount()
  })

  it('turns the Stripe return marker into the Billing tab and keeps the tab of an SSO test', async () => {
    const router = useRouter()
    const back = await mountSuspended(Route, { route: '/w/ws-admin?billing=cancelled' })
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'billing' }))
    back.unmount()
    const sso = await mountSuspended(Route, { route: '/w/ws-admin?tab=sso&test=ok' })
    await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ tab: 'sso' }))
    sso.unmount()
  })
})
