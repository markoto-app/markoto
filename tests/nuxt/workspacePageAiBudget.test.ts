// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { NuxtPage } from '#components'
import { useAiWorkspaceContext } from '~/composables/ai/useAiAvailability'

const Route = defineComponent({ render: () => h(NuxtPage) })

// The header's AI Points meter on a workspace page: a Team / Business
// workspace pays its members' AI from its pool, so the page shows that
// budget (as its documents do), not the member's personal plan. A
// workspace without a subscription keeps the personal budget.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  ready: ref(true),
  fetch: vi.fn(),
  clear: vi.fn()
}))

function workspace(workspaceId: string, pooled: boolean) {
  return {
    workspace: {
      workspaceId,
      name: 'Team test',
      description: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      myRole: 'editor',
      ownerId: 2,
      plan: pooled ? 'business' : 'free',
      defaultTheme: null,
      pooled,
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

registerEndpoint('/api/workspaces/ws-pooled', () => workspace('ws-pooled', true))
registerEndpoint('/api/workspaces/ws-plain', () => workspace('ws-plain', false))

describe('workspace page: whose AI Points the header shows', () => {
  it('a pooled workspace sets the AI context to itself, and clears it on leaving', async () => {
    const page = await mountSuspended(Route, { route: '/w/ws-pooled' })
    await vi.waitFor(() => expect(useAiWorkspaceContext().value).toBe('ws-pooled'))
    page.unmount()
    expect(useAiWorkspaceContext().value).toBeNull()
  })

  it('a workspace without a subscription keeps the personal budget', async () => {
    const page = await mountSuspended(Route, { route: '/w/ws-plain' })
    await flushPromises()
    await vi.waitFor(() => expect(page.text()).toContain('Team test'))
    expect(useAiWorkspaceContext().value).toBeNull()
    page.unmount()
  })
})
