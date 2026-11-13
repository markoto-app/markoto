// @vitest-environment nuxt
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { Cta } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// "Use this template" on /templates/<slug>: `::cta{template theme}` opens
// the normal new-document dialog (same gate as every other create path)
// with that template card and theme preset selected, and "Create
// document" POSTs `templateId` + `themePreset`, the server renders the
// template body, the page never sends the content itself.

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
    return { docId: 'tpl-doc' }
  }
})

function setConfig(patch: Partial<InstanceConfig>): void {
  useState<InstanceConfig>('instance-config').value = { ...MINIMAL_INSTANCE_CONFIG, ...patch }
}

function el(selector: string): HTMLElement {
  const found = document.body.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`missing ${selector}`)
  return found
}

// Unmounted after each test, also a failed one: a dialog left in
// document.body would otherwise answer the next test's selectors.
const wrappers: Array<{ unmount: () => void }> = []

async function openDialog(props: Record<string, string>) {
  const wrapper = await mountSuspended(Cta, { props: { label: 'Use this template', ...props } })
  wrappers.push(wrapper)
  await wrapper.find('button').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="newdoc-submit-create"]')).not.toBeNull())
  return wrapper
}

/** Expand one of the dialog's collapsed option rows (template / details). */
async function expand(section: 'template' | 'details') {
  const trigger = el(`[data-testid="newdoc-section-${section}"]`)
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  await flushPromises()
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
}

let push: ReturnType<typeof vi.spyOn>

// The button mounts the dialog as a lazy component: the first click
// imports NewDocumentDialog.vue and its whole module graph, which Vite
// transforms on demand: ~0.8 s on an idle machine, over the 1 s
// `vi.waitFor` budget when the suite runs on every core. Load it once up
// front, so the waits below measure the dialog, not the transform.
beforeAll(async () => {
  await import('~/components/document/NewDocumentDialog.vue')
}, 120_000)

beforeEach(() => {
  created.bodies = []
  // A fresh browser: the dialog's first-document default (Demo) applies.
  localStorage.clear()
  push = vi.spyOn(useRouter(), 'push').mockResolvedValue(undefined)
  // The gate is off here: this test is about what the dialog posts, not
  // the terms/bot-check rounds (tests/nuxt/anonGate*).
  setConfig({ anonGate: false })
})

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  vi.restoreAllMocks()
})

describe('::cta with a template ("Use this template")', () => {
  it('opens the new-document dialog with the template selected and creates the doc in its design', async () => {
    const wrapper = await openDialog({ template: 'resume' })
    expect(wrapper.find('[data-testid="cta-use-template"]').exists()).toBe(true)
    expect(el('[data-testid="newdoc-section-template-summary"]').textContent?.trim()).toBe('Resume')
    await expand('template')
    expect(el('[data-testid="newdoc-template-card-resume"]').getAttribute('aria-pressed')).toBe('true')
    expect(el('[data-testid="newdoc-template-card-demo"]').getAttribute('aria-pressed')).toBe('false')

    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'resume', themePreset: 'resume' })
    expect(created.bodies[0]).not.toHaveProperty('content')
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/d/tpl-doc'))
  })

  it('a theme on the button puts that design on the template (old links keep working)', async () => {
    await openDialog({ template: 'academic-paper', theme: 'modern' })
    expect(el('[data-testid="newdoc-section-template-summary"]').textContent?.trim()).toBe('arXiv preprint · Modern')
    await expand('template')
    expect(el('[data-testid="newdoc-template-card-arxiv"]').getAttribute('aria-pressed')).toBe('true')

    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'arxiv', themePreset: 'modern' })
  })

  it('falls back to the demo template in its own design for unknown ids', async () => {
    await openDialog({ template: 'no-such-template', theme: 'no-such-theme' })
    expect(el('[data-testid="newdoc-section-template-summary"]').textContent?.trim()).toBe('Demo')
    await expand('template')
    expect(el('[data-testid="newdoc-template-card-demo"]').getAttribute('aria-pressed')).toBe('true')
    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'demo', themePreset: 'markoto' })
  })

  it('a plain ::cta keeps the dialog default (demo)', async () => {
    const mounted = await mountSuspended(Cta, { props: { title: 'Try it' } })
    wrappers.push(mounted)
    expect(mounted.find('[data-testid="cta-start-writing"]').exists()).toBe(true)
    await mounted.find('button').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="newdoc-section-template"]')).not.toBeNull())
    await expand('template')
    expect(el('[data-testid="newdoc-template-card-demo"]').getAttribute('aria-pressed')).toBe('true')
  })
})
