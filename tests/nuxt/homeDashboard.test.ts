// @vitest-environment nuxt
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { HomeDashboard } from '#components'

// The home page (`/`) for everyone who doesn't get the product tour:
//   - logged out: the plain hero with "New document" — unchanged;
//   - logged in: an app dashboard — compact page header, no hero, the
//     create buttons in their sections' headers, and a working "…" menu
//     on every document row (it used to stay closed).

const loggedIn = ref(true)
mockNuxtImport('useUserSession', () => () => ({
  loggedIn,
  user: ref(loggedIn.value ? { id: 1, name: 'Maya' } : null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

registerEndpoint('/api/user/documents', () => [{
  docId: 'doc1',
  title: 'Quarterly notes',
  description: '',
  language: 'en',
  accessMode: 'private',
  wordCount: 12,
  lastActive: new Date().toISOString(),
  sizeBytes: 100,
  workspaceId: null,
  isOwner: true
}])
registerEndpoint('/api/user/workspaces', () => [])
registerEndpoint('/api/user/invites', () => [])
registerEndpoint('/api/user/billing', () => ({
  plan: 'free',
  periodStart: new Date().toISOString(),
  periodEnd: new Date().toISOString(),
  ownedWorkspaces: 0,
  workspacesOwnedLimit: 1,
  knowledgeFilesUsed: 0,
  knowledgeFilesLimit: 5,
  knowledgeBytesUsed: 0,
  knowledgeBytesPerUserLimit: 1,
  imageBytesUsed: 0,
  imageBytesPerUserLimit: 1
}))

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []

async function mountDashboard() {
  const wrapper = await mountSuspended(HomeDashboard, { attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  await vi.waitFor(() => {
    if (loggedIn.value && !wrapper.text().includes('Quarterly notes')) throw new Error('documents not loaded')
  })
  return wrapper
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount()
})

describe('HomeDashboard', () => {
  it('logged out: the hero with one "New document" button, no workspace button', async () => {
    loggedIn.value = false
    const wrapper = await mountDashboard()
    expect(wrapper.find('h1').text()).toContain('Markdown')
    expect(wrapper.findAll('[data-testid="landing-new-document"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="landing-new-workspace"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="home-page-header"]').exists()).toBe(false)
    loggedIn.value = true
  })

  it('logged in: compact header instead of the hero, create buttons in their section headers', async () => {
    loggedIn.value = true
    const wrapper = await mountDashboard()
    const header = wrapper.get('[data-testid="home-page-header"]')
    expect(header.text()).toContain('Maya')
    expect(wrapper.text()).not.toContain('Beautifully rendered')

    const newDoc = wrapper.findAll('[data-testid="landing-new-document"]')
    expect(newDoc).toHaveLength(1)
    expect(newDoc[0]?.element.closest('[data-testid="landing-recent-documents"]')).not.toBeNull()

    const newWs = wrapper.get('[data-testid="landing-new-workspace"]')
    const wsSection = newWs.element.closest('section')
    expect(wsSection?.querySelector('h2')?.textContent).toMatch(/workspaces/i)
  })

  it('logged in: "New document" asks the page for the dialog', async () => {
    loggedIn.value = true
    const wrapper = await mountDashboard()
    await wrapper.get('[data-testid="landing-new-document"]').trigger('click')
    expect(wrapper.emitted('new-document')).toHaveLength(1)
  })

  it('logged in: the row\'s "…" button opens the menu with every action for an owned doc', async () => {
    loggedIn.value = true
    const wrapper = await mountDashboard()
    await wrapper.get('[data-testid="doc-row-menu"]').trigger('click', { button: 0, ctrlKey: false })
    await vi.waitFor(() => {
      if (!document.body.querySelector('[role="menu"]')) throw new Error('menu not open')
    })
    const actions = Array.from(document.body.querySelectorAll('[data-testid^="doc-row-action-"]'))
      .map(el => el.getAttribute('data-testid'))
    expect(actions).toEqual([
      'doc-row-action-open',
      'doc-row-action-openNewTab',
      'doc-row-action-duplicate',
      'doc-row-action-move',
      'doc-row-action-delete'
    ])
  })
})
