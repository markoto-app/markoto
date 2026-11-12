// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentThemeEditorPanel } from '#components'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import type { DocTheme } from '~~/shared/types/theme'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'

// Theme panel ↔ the engine-batch-2 fields: `{section}` options, the drop
// cap on every chapter. Opening the panel on a theme stored before them
// writes nothing; a control writes only its own field.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(false),
  user: ref(null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
registerEndpoint('/api/themes', () => ({ themes: [] }))

function legacy(edit: (t: DocTheme) => void = () => {}): DocTheme {
  const t = structuredClone(defaultTheme)
  delete t.header.sectionNumber
  delete t.header.sectionMode
  delete t.headings.numberingDepth
  delete t.headings.chapterLabel
  delete t.headings.chapterWord
  delete t.blocks.captionNumbering
  delete t.blocks.captionLabelStyle
  delete t.cover.dateFormat
  delete t.cover.repeatTitle
  delete t.page.mirrorMargins
  edit(t)
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

async function toggle(wrapper: Awaited<ReturnType<typeof mount>>, testid: string) {
  const sw = wrapper.find(`[data-testid="${testid}"]`)
  await (sw.element.tagName === 'BUTTON' ? sw : sw.find('button')).trigger('click')
  await flushPromises()
}

describe('theme panel: {section} options, drop cap per chapter', () => {
  it('opening the panel on a legacy theme emits nothing', async () => {
    const wrapper = await mount(legacy((t) => {
      t.header.left = '{section}'
    }))
    expect(wrapper.emitted('update:theme')).toBeUndefined()
    wrapper.unmount()
  })

  it('the {section} options show only while a slot uses the token; the switch writes header.sectionNumber only', async () => {
    const none = await mount(legacy())
    expect(none.find('[data-testid="theme-header-section-number"]').exists()).toBe(false)
    none.unmount()
    const wrapper = await mount(legacy((t) => {
      t.footer.center = '{section}'
    }))
    await toggle(wrapper, 'theme-header-section-number')
    const next = lastTheme(wrapper)
    expect(next?.header.sectionNumber).toBe(true)
    expect(next?.header.sectionMode).toBeUndefined()
    expect(next?.cover.repeatTitle).toBeUndefined()
    wrapper.unmount()
  })

  it('drop cap: "every chapter" appears with the cap on and writes body.dropCap', async () => {
    const wrapper = await mount(legacy((t) => {
      t.body.dropCap = true
    }))
    await toggle(wrapper, 'theme-body-drop-cap-every-chapter')
    expect(lastTheme(wrapper)?.body.dropCap).toBe('every-chapter')
    await wrapper.setProps({ theme: lastTheme(wrapper) })
    await toggle(wrapper, 'theme-body-drop-cap-switch')
    expect(lastTheme(wrapper)?.body.dropCap).toBe(false)
    wrapper.unmount()
  })
})
