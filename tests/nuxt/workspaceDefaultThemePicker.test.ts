// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { WorkspaceSettingsPanel } from '#components'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { themeThumbnailUrl } from '~~/shared/utils/themeThumbnails'
import { isValidTheme } from '~~/shared/utils/themeValidation'

// The workspace's default design is picked with the same picker as the
// new-document dialog and the theme panel: a picture of each design's
// first page in audience tabs. The current default is highlighted even
// though the stored theme (a jsonb column) has a different key order.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
registerEndpoint('/api/themes', () => ({ themes: [] }))

const saved = vi.hoisted(() => ({ bodies: [] as unknown[] }))
registerEndpoint('/api/workspaces/ws1', {
  method: 'PUT',
  handler: async (event) => {
    const { readBody } = await import('h3')
    saved.bodies.push(await readBody(event))
    return { ok: true }
  }
})

/** Same values, keys in reverse order — like a theme read back from jsonb. */
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reordered(v)]))
  }
  return value
}

describe('workspace default-design picker', () => {
  it('shows every design as a picture card', async () => {
    const wrapper = await mountSuspended(WorkspaceSettingsPanel, { props: { workspaceId: 'ws1', defaultTheme: null } })
    await flushPromises()
    for (const preset of THEME_PRESETS) {
      const card = wrapper.find(`[data-testid="workspace-default-theme-preset-${preset.id}"]`)
      expect(card.exists(), preset.id).toBe(true)
      const url = themeThumbnailUrl(preset.id)
      if (url) expect(card.find('img').attributes('src')).toBe(url)
    }
    wrapper.unmount()
  })

  it('highlights the current default even with a different key order', async () => {
    const target = THEME_PRESETS.find(p => p.id === 'business-report')
    if (!target) throw new Error('business-report preset missing')
    const stored = reordered(structuredClone(target.theme))
    if (!isValidTheme(stored)) throw new Error('reordered theme no longer valid')
    const wrapper = await mountSuspended(WorkspaceSettingsPanel, { props: { workspaceId: 'ws1', defaultTheme: stored } })
    await flushPromises()
    expect(wrapper.find('[data-testid="workspace-default-theme-preset-business-report"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-testid="workspace-default-theme-preset-markoto"]').attributes('aria-pressed')).toBe('false')
    wrapper.unmount()
  })

  it('a click makes the design the workspace default', async () => {
    saved.bodies = []
    const wrapper = await mountSuspended(WorkspaceSettingsPanel, { props: { workspaceId: 'ws1', defaultTheme: null } })
    await flushPromises()
    await wrapper.find('[data-testid="workspace-default-theme-preset-arxiv"]').trigger('click')
    await vi.waitFor(() => expect(saved.bodies).toHaveLength(1))
    const arxiv = THEME_PRESETS.find(p => p.id === 'arxiv')
    expect(saved.bodies[0]).toEqual({ defaultTheme: arxiv?.theme })
    expect(wrapper.emitted('updated')?.[0]?.[0]).toEqual(arxiv?.theme)
    wrapper.unmount()
  })
})
