// @vitest-environment nuxt
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { Cta } from '#components'
import { MINIMAL_INSTANCE_CONFIG, type InstanceConfig } from '~~/shared/config/instance'

// "Use this template" on /templates/<slug>: `::cta{template theme}` opens
// the normal new-document dialog (same gate as every other create path)
// with that template card and theme preset selected, and "Create
// document" POSTs `templateId` + `themePreset` — the server renders the
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

async function openDialog(props: Record<string, string>) {
  const wrapper = await mountSuspended(Cta, { props: { label: 'Use this template', ...props } })
  await wrapper.find('button').trigger('click')
  await flushPromises()
  await vi.waitFor(() => expect(document.body.querySelector('[data-testid="newdoc-submit-create"]')).not.toBeNull())
  return wrapper
}

/** Expand one of the dialog's collapsed option rows (content / design / details). */
async function expand(section: 'content' | 'design' | 'details') {
  const trigger = el(`[data-testid="newdoc-section-${section}"]`)
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  await flushPromises()
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
}

let push: ReturnType<typeof vi.spyOn>

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
  vi.restoreAllMocks()
})

describe('::cta with a template ("Use this template")', () => {
  it('opens the new-document dialog with the template and theme selected and creates the doc from them', async () => {
    const wrapper = await openDialog({ template: 'resume', theme: 'modern' })
    expect(wrapper.find('[data-testid="cta-use-template"]').exists()).toBe(true)
    await expand('content')
    expect(el('[data-testid="newdoc-template-card-resume"]').getAttribute('aria-pressed')).toBe('true')
    expect(el('[data-testid="newdoc-template-card-demo"]').getAttribute('aria-pressed')).toBe('false')
    await expand('design')
    expect(el('[data-testid="newdoc-theme-card-modern"]').getAttribute('aria-pressed')).toBe('true')

    el('[data-testid="newdoc-submit-create"]').click()
    await vi.waitFor(() => expect(created.bodies).toHaveLength(1))
    expect(created.bodies[0]).toMatchObject({ templateId: 'resume', themePreset: 'modern' })
    expect(created.bodies[0]).not.toHaveProperty('content')
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/d/tpl-doc'))
    wrapper.unmount()
  })

  it('falls back to the demo template and the markoto theme for unknown ids', async () => {
    const wrapper = await openDialog({ template: 'no-such-template', theme: 'no-such-theme' })
    await expand('content')
    expect(el('[data-testid="newdoc-template-card-demo"]').getAttribute('aria-pressed')).toBe('true')
    await expand('design')
    expect(el('[data-testid="newdoc-theme-card-markoto"]').getAttribute('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('a plain ::cta keeps the dialog defaults (demo, markoto)', async () => {
    const mounted = await mountSuspended(Cta, { props: { title: 'Try it' } })
    expect(mounted.find('[data-testid="cta-start-writing"]').exists()).toBe(true)
    await mounted.find('button').trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="newdoc-section-content"]')).not.toBeNull())
    await expand('content')
    expect(el('[data-testid="newdoc-template-card-demo"]').getAttribute('aria-pressed')).toBe('true')
    await expand('design')
    expect(el('[data-testid="newdoc-theme-card-markoto"]').getAttribute('aria-pressed')).toBe('true')
    mounted.unmount()
  })
})
