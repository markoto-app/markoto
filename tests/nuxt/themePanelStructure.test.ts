// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentThemeEditorPanel } from '#components'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import type { DocTheme } from '~~/shared/types/theme'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'

// Theme panel ↔ the document-structure fields: per-side page margins,
// per-level alignment, table / figure caption labels, reference style.
// Opening the panel never rewrites a stored theme; a change writes only
// the field it touches.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(false),
  user: ref(null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
registerEndpoint('/api/themes', () => ({ themes: [] }))

/** Stored before the fields existed. */
function legacy(): DocTheme {
  const t = structuredClone(defaultTheme)
  delete t.tables.captionPosition
  delete t.tables.captionLabel
  delete t.blocks.figureLabel
  delete t.blocks.referenceStyle
  delete t.headings.levels
  return t
}

async function mount(theme: DocTheme) {
  const wrapper = await mountSuspended(DocumentThemeEditorPanel, {
    props: { theme, docId: 'doc1', canEdit: true }
  })
  await flushPromises()
  return wrapper
}

function lastTheme(wrapper: Awaited<ReturnType<typeof mount>>): DocTheme | undefined {
  const value: unknown = wrapper.emitted('update:theme')?.at(-1)?.[0]
  return isValidTheme(value) ? value : undefined
}

async function toggle(wrapper: Awaited<ReturnType<typeof mount>>, testId: string) {
  const sw = wrapper.find(`[data-testid="${testId}"]`)
  await (sw.element.tagName === 'BUTTON' ? sw : sw.find('button')).trigger('click')
  await flushPromises()
}

describe('theme panel — margins, captions, references, heading alignment', () => {
  it('opening the panel on a legacy theme emits nothing; the side margins stay collapsed', async () => {
    const wrapper = await mount(legacy())
    expect(wrapper.emitted('update:theme')).toBeUndefined()
    expect(wrapper.find('[data-testid="theme-page-margins"]').attributes('open')).toBeUndefined()
    wrapper.unmount()
  })

  it('a side margin writes that side only; reset removes it', async () => {
    const wrapper = await mount(legacy())
    const input = wrapper.find('input[data-testid="theme-page-margin-bottom"]')
    await input.setValue('30')
    await input.trigger('blur')
    await flushPromises()
    const next = lastTheme(wrapper)
    expect(next?.page).toEqual({ ...defaultTheme.page, marginBottom: 30 })
    expect(next?.tables.captionLabel).toBeUndefined()

    await wrapper.setProps({ theme: next })
    await wrapper.find('[data-testid="theme-page-margins-reset"]').trigger('click')
    await flushPromises()
    expect(lastTheme(wrapper)?.page).toEqual(defaultTheme.page)
    wrapper.unmount()
  })

  it('a theme with a side margin opens the section', async () => {
    const t = legacy()
    t.page.marginTop = 18
    const wrapper = await mount(t)
    expect(wrapper.find('[data-testid="theme-page-margins"]').attributes('open')).toBeDefined()
    expect(wrapper.emitted('update:theme')).toBeUndefined()
    wrapper.unmount()
  })

  it('the caption and figure switches write their field only', async () => {
    const wrapper = await mount(legacy())
    await toggle(wrapper, 'theme-tables-caption-label')
    const next = lastTheme(wrapper)
    expect(next?.tables.captionLabel).toBe(true)
    expect(next?.tables.captionPosition).toBeUndefined()
    expect(next?.blocks.figureLabel).toBeUndefined()

    await wrapper.setProps({ theme: next })
    await toggle(wrapper, 'theme-blocks-figure-label')
    expect(lastTheme(wrapper)?.blocks.figureLabel).toBe(true)
    expect(lastTheme(wrapper)?.blocks.referenceStyle).toBeUndefined()
    wrapper.unmount()
  })

  it('"Centred" writes headings.levels.hN.align', async () => {
    const wrapper = await mount(legacy())
    await toggle(wrapper, 'theme-heading-level-h1-centered')
    expect(lastTheme(wrapper)?.headings.levels).toEqual({ h1: { align: 'center' } })
    wrapper.unmount()
  })
})
