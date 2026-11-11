// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { DocumentNewDocumentDialog, WorkspaceSettingsPanel } from '#components'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'

// User-saved themes carry an optional description (migration 0025). Every
// place a saved theme is picked shows it under the name, like built-in
// presets show theirs; an empty description falls back to the font
// pairing (`theme.saved.fallbackDescription`, same as the Theme panel).

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

const baseTheme = THEME_PRESETS[0]?.theme
if (!baseTheme) throw new Error('no built-in theme preset')

registerEndpoint('/api/themes', () => ({
  themes: [
    {
      themeId: 'described',
      name: 'Quarterly report',
      description: 'Board-ready: serif headings, wide margins',
      theme: baseTheme,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z'
    },
    {
      themeId: 'plain',
      name: 'No description',
      description: '',
      theme: baseTheme,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z'
    }
  ]
}))

const fallback = `${baseTheme.headings.font} headings, ${baseTheme.body.font} body text`

function textOf(selector: string): string | undefined {
  return document.body.querySelector(selector)?.textContent?.trim()
}

describe('saved-theme descriptions in theme pickers', () => {
  it('workspace default-theme picker shows the description (or the font fallback)', async () => {
    const wrapper = await mountSuspended(WorkspaceSettingsPanel, {
      props: { workspaceId: 'ws1', defaultTheme: null }
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="workspace-default-theme-saved-description-described"]').text())
      .toBe('Board-ready: serif headings, wide margins')
    expect(wrapper.find('[data-testid="workspace-default-theme-saved-description-plain"]').text())
      .toBe(fallback)
    wrapper.unmount()
  })

  it('new-document dialog shows the description (or the font fallback)', async () => {
    const wrapper = await mountSuspended(DocumentNewDocumentDialog, {
      props: { open: false, workspaceId: null }
    })
    await wrapper.setProps({ open: true })
    // Saved designs are "Blank in <design>" cards in the collapsed
    // "Template" row; the modal is teleported.
    await vi.waitFor(() => expect(document.body.querySelector('[data-testid="newdoc-section-template"]')).not.toBeNull())
    const row = document.body.querySelector('[data-testid="newdoc-section-template"]')
    if (row instanceof HTMLElement) row.click()
    // The dialog fetches saved themes on open.
    await vi.waitFor(() => {
      expect(textOf('[data-testid="newdoc-template-card-saved-description-described"]'))
        .toBe('Board-ready: serif headings, wide margins')
    })
    expect(textOf('[data-testid="newdoc-template-card-saved-description-plain"]'))
      .toBe(fallback)
    expect(textOf('[data-testid="newdoc-template-card-saved-described"]')).toContain('Blank in Quarterly report')
    wrapper.unmount()
  })
})
