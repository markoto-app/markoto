// @vitest-environment nuxt
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentNewDocumentDialog } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'

// The new-document dialog keeps only the title in view: content
// (template), design (theme) and details (AI context) are collapsed rows
// that show the current choice. The first document in a browser starts
// from the Demo, later ones from Blank.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(false),
  user: ref(null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

const created = vi.hoisted(() => ({ bodies: [] as Array<Record<string, unknown>> }))
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

async function openDialog() {
  const wrapper = await mountSuspended(DocumentNewDocumentDialog, { props: { open: false, workspaceId: null } })
  await wrapper.setProps({ open: true })
  await flushPromises()
  await vi.waitFor(() => expect(exists('[data-testid="newdoc-section-content"]')).toBe(true))
  return wrapper
}

async function expand(section: 'content' | 'design' | 'details') {
  el(`[data-testid="newdoc-section-${section}"]`).click()
  await flushPromises()
  await vi.waitFor(() => expect(el(`[data-testid="newdoc-section-${section}"]`).getAttribute('aria-expanded')).toBe('true'))
}

beforeEach(() => {
  created.bodies = []
  localStorage.clear()
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, anonGate: false }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('new-document dialog', () => {
  it('opens with only the title and three collapsed option rows showing the current choice', async () => {
    const wrapper = await openDialog()
    expect(exists('[data-testid="newdoc-title-input"]')).toBe(true)
    for (const section of ['content', 'design', 'details']) {
      expect(el(`[data-testid="newdoc-section-${section}"]`).getAttribute('aria-expanded')).toBe('false')
    }
    expect(exists('[data-testid="newdoc-template-grid"]')).toBe(false)
    expect(exists('[data-testid="newdoc-theme-grid"]')).toBe(false)
    expect(exists('[data-testid="newdoc-description-input"]')).toBe(false)
    expect(el('[data-testid="newdoc-section-content-summary"]').textContent?.trim()).toBe('Demo')
    expect(el('[data-testid="newdoc-section-design-summary"]').textContent?.trim()).toBe('markoto')
    expect(el('[data-testid="newdoc-section-details-summary"]').textContent).toContain('English')
    expect(exists('[data-testid="newdoc-submit-blank"]')).toBe(false)
    wrapper.unmount()
  })

  it('opens one row at a time and updates the summary when a card is picked', async () => {
    const wrapper = await openDialog()
    await expand('content')
    el('[data-testid="newdoc-template-card-meeting-notes"]').click()
    await flushPromises()
    expect(el('[data-testid="newdoc-section-content-summary"]').textContent?.trim()).toBe('Meeting notes')
    await expand('design')
    await vi.waitFor(() => expect(exists('[data-testid="newdoc-template-grid"]')).toBe(false))
    el('[data-testid="newdoc-theme-card-arxiv"]').click()
    await flushPromises()
    expect(el('[data-testid="newdoc-section-design-summary"]').textContent?.trim()).toBe('arXiv preprint')
    wrapper.unmount()
  })

  it('groups the design presets in audience tabs', async () => {
    const wrapper = await openDialog()
    await expand('design')
    for (const preset of THEME_PRESETS) {
      expect(exists(`[data-testid="newdoc-theme-card-${preset.id}"]`)).toBe(true)
    }
    const academicTab = Array.from(document.body.querySelectorAll('[data-testid="newdoc-design-tabs"] button'))
      .find(b => b.textContent?.trim() === 'Academic')
    if (!(academicTab instanceof HTMLElement)) throw new Error('no Academic tab')
    // Reka tabs activate on mousedown, not click.
    academicTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await flushPromises()
    await vi.waitFor(() => expect(exists('[data-testid="newdoc-theme-card-markoto"]')).toBe(false))
    for (const preset of THEME_PRESETS) {
      expect(exists(`[data-testid="newdoc-theme-card-${preset.id}"]`)).toBe(preset.category === 'academic')
    }
    wrapper.unmount()
  })

  it('starts the first document from the demo and later ones blank', async () => {
    const first = await openDialog()
    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'demo', themePreset: 'markoto' })
    first.unmount()

    const second = await openDialog()
    expect(el('[data-testid="newdoc-section-content-summary"]').textContent?.trim()).toBe('Blank')
    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(2))
    expect(created.bodies[1]).toMatchObject({ templateId: 'blank' })
    second.unmount()
  })
})
