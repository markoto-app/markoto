// @vitest-environment nuxt
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentNewDocumentDialog } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { TEMPLATES } from '~~/shared/templates'

// The new-document dialog keeps only the title in view: the template
// (a starting text + its design, one choice) and the details (AI context)
// are collapsed rows that show the current choice. The first document in a
// browser (signed in: of an account) starts from the Demo, later ones from Blank.

const account = vi.hoisted(() => ({ loggedIn: false, docs: [] as Array<{ docId: string }> }))
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(account.loggedIn),
  user: ref(null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

const created = vi.hoisted(() => ({ bodies: [] as Array<Record<string, unknown>> }))
const workspace = vi.hoisted(() => ({ defaultTheme: null as unknown }))
registerEndpoint('/api/user/documents', () => account.docs)
registerEndpoint('/api/workspaces/ws1', () => ({ workspace: { defaultTheme: workspace.defaultTheme } }))

registerEndpoint('/api/docs', {
  method: 'POST',
  handler: async (event) => {
    const { readBody } = await import('h3')
    created.bodies.push(await readBody(event))
    return { docId: 'new-doc' }
  }
})

function el(selector: string): HTMLElement {
  const found = document.body.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${selector}`)
  return found
}
const exists = (selector: string) => document.body.querySelector(selector) !== null

async function openDialog(workspaceId: string | null = null) {
  const wrapper = await mountSuspended(DocumentNewDocumentDialog, { props: { open: false, workspaceId } })
  await wrapper.setProps({ open: true })
  await flushPromises()
  await vi.waitFor(() => expect(exists('[data-testid="newdoc-section-template"]')).toBe(true))
  return wrapper
}

const summary = () => el('[data-testid="newdoc-section-template-summary"]').textContent?.trim()

async function expand(section: 'template' | 'details') {
  el(`[data-testid="newdoc-section-${section}"]`).click()
  await flushPromises()
  await vi.waitFor(() => expect(el(`[data-testid="newdoc-section-${section}"]`).getAttribute('aria-expanded')).toBe('true'))
}

beforeEach(() => {
  account.loggedIn = false
  account.docs = []
  created.bodies = []
  workspace.defaultTheme = null
  localStorage.clear()
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, anonGate: false }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('new-document dialog', () => {
  it('opens with only the title and two collapsed option rows showing the current choice', async () => {
    const wrapper = await openDialog()
    expect(exists('[data-testid="newdoc-title-input"]')).toBe(true)
    for (const section of ['template', 'details']) {
      expect(el(`[data-testid="newdoc-section-${section}"]`).getAttribute('aria-expanded')).toBe('false')
    }
    expect(exists('[data-testid="newdoc-section-content"]')).toBe(false)
    expect(exists('[data-testid="newdoc-section-design"]')).toBe(false)
    expect(exists('[data-testid="newdoc-template-grid"]')).toBe(false)
    expect(exists('[data-testid="newdoc-description-input"]')).toBe(false)
    expect(summary()).toBe('Demo')
    expect(el('[data-testid="newdoc-section-details-summary"]').textContent).toContain('English')
    wrapper.unmount()
  })

  it('shows every template as a picture card and updates the summary when one is picked', async () => {
    const wrapper = await openDialog()
    await expand('template')
    for (const tpl of TEMPLATES) {
      expect(exists(`[data-testid="newdoc-template-card-${tpl.id}"]`), tpl.id).toBe(true)
    }
    expect(el('[data-testid="newdoc-template-card-demo"]').getAttribute('aria-pressed')).toBe('true')
    expect(document.body.querySelector('[data-testid="newdoc-template-card-runbook"] img')?.getAttribute('src'))
      .toMatch(/^\/template-thumbs\/runbook\.webp\?v=/)
    el('[data-testid="newdoc-template-card-meeting-notes"]').click()
    await flushPromises()
    expect(summary()).toBe('Meeting notes')
    await expand('details')
    await vi.waitFor(() => expect(exists('[data-testid="newdoc-template-grid"]')).toBe(false))
    wrapper.unmount()
  })

  it('groups the templates in audience tabs', async () => {
    const wrapper = await openDialog()
    await expand('template')
    const academicTab = Array.from(document.body.querySelectorAll('[data-testid="template-tabs"] button'))
      .find(b => b.textContent?.trim() === 'Academic')
    if (!(academicTab instanceof HTMLElement)) throw new Error('no Academic tab')
    // Reka tabs activate on mousedown, not click.
    academicTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await flushPromises()
    await vi.waitFor(() => expect(exists('[data-testid="newdoc-template-card-demo"]')).toBe(false))
    for (const tpl of TEMPLATES) {
      expect(exists(`[data-testid="newdoc-template-card-${tpl.id}"]`), tpl.id).toBe(tpl.category === 'academic')
    }
    wrapper.unmount()
  })

  it('creates the document from the template and its design', async () => {
    const wrapper = await openDialog()
    await expand('template')
    el('[data-testid="newdoc-template-card-runbook"]').click()
    await flushPromises()
    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'runbook', themePreset: 'runbook' })
    expect(created.bodies[0]).not.toHaveProperty('themeId')
    wrapper.unmount()
  })

  it('starts the first document from the demo and later ones blank in the markoto design', async () => {
    const first = await openDialog()
    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'demo', themePreset: 'markoto' })
    first.unmount()

    const second = await openDialog()
    expect(summary()).toBe('Blank · markoto')
    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(2))
    expect(created.bodies[1]).toMatchObject({ templateId: 'blank', themePreset: 'markoto' })
    second.unmount()
  })

  it('signed in, the first document of the account starts from the demo even after anonymous documents in this browser', async () => {
    account.loggedIn = true
    localStorage.setItem('markoto-created-first-doc', '1')
    const wrapper = await openDialog()
    await vi.waitFor(() => expect(summary()).toBe('Demo'))
    wrapper.unmount()
  })

  it('signed in with documents, a new one starts blank, even in a fresh browser', async () => {
    account.loggedIn = true
    account.docs = [{ docId: 'd1' }]
    const wrapper = await openDialog()
    await vi.waitFor(() => expect(summary()).toBe('Blank · markoto'))
    wrapper.unmount()
  })

  it('a blank page in a workspace gets the workspace default design', async () => {
    localStorage.setItem('markoto-created-first-doc', '1')
    workspace.defaultTheme = THEME_PRESETS.find(p => p.id === 'business-report')?.theme
    const wrapper = await openDialog('ws1')
    await vi.waitFor(() => expect(summary()).toBe('Blank · Corporate report'))
    await expand('template')
    // Blank shows the workspace design (a swatch), not the markoto picture.
    expect(document.body.querySelector('[data-testid="newdoc-template-card-blank"] img')).toBeNull()
    expect(el('[data-testid="newdoc-template-card-blank"]').textContent).toContain('Corporate report')
    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'blank', workspaceId: 'ws1' })
    expect(created.bodies[0]).not.toHaveProperty('themePreset')
    wrapper.unmount()
  })
})
