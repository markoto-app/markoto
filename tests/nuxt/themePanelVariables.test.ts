// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentThemeEditorPanel } from '#components'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import type { DocTheme } from '~~/shared/types/theme'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'

// Theme panel ↔ the optional fields header.rule / footer.rule,
// headings.levels and cover.titleWeight. Opening the panel must never
// rewrite a stored theme (a theme from before these fields existed stays
// as it is until the author changes something); a change writes only the
// field it touches.

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
  delete t.headings.levels
  delete t.header.rule
  delete t.footer.rule
  delete t.cover.titleWeight
  t.header.center = '{title}'
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

describe('theme panel: header rule, per-level headings, title weight', () => {
  it('opening the panel on a legacy theme emits nothing', async () => {
    const wrapper = await mount(legacy())
    expect(wrapper.emitted('update:theme')).toBeUndefined()
    expect(wrapper.find('[data-testid="theme-heading-levels"]').attributes('open')).toBeUndefined()
    wrapper.unmount()
  })

  it('the header rule switch writes header.rule only', async () => {
    const wrapper = await mount(legacy())
    const sw = wrapper.find('[data-testid="theme-header-rule"]')
    await (sw.element.tagName === 'BUTTON' ? sw : sw.find('button')).trigger('click')
    await flushPromises()
    const next = lastTheme(wrapper)
    expect(next?.header.rule).toBe(true)
    expect(next?.footer.rule).toBeUndefined()
    expect(next?.headings.levels).toBeUndefined()
    expect(next?.cover.titleWeight).toBeUndefined()
    wrapper.unmount()
  })

  it('a level size writes that level only; "Use defaults" removes it again', async () => {
    const wrapper = await mount(legacy())
    // UInputNumber passes the test id through to its <input>.
    const input = wrapper.find('input[data-testid="theme-heading-level-h1-size"]')
    await input.setValue('1.2')
    await input.trigger('blur')
    await flushPromises()
    expect(lastTheme(wrapper)?.headings.levels).toEqual({ h1: { size: 1.2 } })
    expect(lastTheme(wrapper)?.header.rule).toBeUndefined()

    await wrapper.setProps({ theme: lastTheme(wrapper) })
    await wrapper.find('[data-testid="theme-heading-level-h1-reset"]').trigger('click')
    await flushPromises()
    expect(lastTheme(wrapper)?.headings.levels).toEqual({})
    wrapper.unmount()
  })

  it('a theme with level overrides opens the per-level section', async () => {
    const t = legacy()
    t.headings.levels = { h2: { style: 'italic' } }
    const wrapper = await mount(t)
    expect(wrapper.find('[data-testid="theme-heading-levels"]').attributes('open')).toBeDefined()
    expect(wrapper.emitted('update:theme')).toBeUndefined()
    wrapper.unmount()
  })
})
