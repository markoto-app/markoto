// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentThemeEditorPanel } from '#components'
import { defaultTheme } from '~~/shared/utils/theme/defaultTheme'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { themeThumbnailUrl } from '~~/shared/utils/theme/themeThumbnails'
import { isValidTheme } from '~~/shared/utils/theme/themeValidation'

// The theme panel shows the same design picker as the new-document dialog
// (DocumentThemePresetGrid): audience tabs over a picture of each preset's
// first page. A click applies the preset to the document.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(false),
  user: ref(null),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
registerEndpoint('/api/themes', () => ({ themes: [] }))

async function mount() {
  const wrapper = await mountSuspended(DocumentThemeEditorPanel, {
    props: { theme: structuredClone(defaultTheme), docId: 'doc1', canEdit: true }
  })
  await flushPromises()
  return wrapper
}

describe('theme panel: design picker', () => {
  it('shows every preset as a card with its first-page picture', async () => {
    const wrapper = await mount()
    for (const preset of THEME_PRESETS) {
      const card = wrapper.find(`[data-testid="theme-preset-${preset.id}"]`)
      expect(card.exists(), preset.id).toBe(true)
      const url = themeThumbnailUrl(preset.id)
      const img = card.find('img')
      expect(img.exists() ? img.attributes('src') : null).toBe(url || null)
    }
    wrapper.unmount()
  })

  it('filters by audience tab', async () => {
    const wrapper = await mount()
    const academic = wrapper.findAll('[data-testid="theme-preset-tabs"] button').find(b => b.text() === 'Academic')
    if (!academic) throw new Error('no Academic tab')
    // Reka tabs activate on mousedown, not click.
    await academic.trigger('mousedown', { button: 0 })
    await flushPromises()
    for (const preset of THEME_PRESETS) {
      expect(wrapper.find(`[data-testid="theme-preset-${preset.id}"]`).exists(), preset.id).toBe(preset.category === 'academic')
    }
    wrapper.unmount()
  })

  it('applies the clicked preset to the document', async () => {
    const wrapper = await mount()
    const target = THEME_PRESETS.find(p => p.id !== 'markoto')
    if (!target) throw new Error('need a second preset')
    await wrapper.find(`[data-testid="theme-preset-${target.id}"]`).trigger('click')
    await flushPromises()
    const value: unknown = wrapper.emitted('update:theme')?.at(-1)?.[0]
    expect(isValidTheme(value)).toBe(true)
    expect(isValidTheme(value) ? value.headings.font : null).toBe(target.theme.headings.font)
    wrapper.unmount()
  })
})
