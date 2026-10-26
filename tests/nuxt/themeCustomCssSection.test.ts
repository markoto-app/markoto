// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { DocumentThemeCustomCssSection } from '#components'

// Theme panel → "Custom CSS" section. Contract with the panel:
//   - valid CSS is emitted upstream (→ ymeta.theme, live preview),
//   - CSS with any issue is NOT emitted; the issues are listed with
//     line/column so the author can fix them,
//   - a remote change (collaborator / AI) replaces the local text.
// The CodeMirror editor itself mounts on intersection, so these tests
// drive the section through its example buttons and props.

async function mount(modelValue?: string) {
  return mountSuspended(DocumentThemeCustomCssSection, {
    props: { modelValue, docId: 'doc1' }
  })
}

describe('ThemeCustomCssSection', () => {
  it('inserting an example emits the valid CSS and shows it as applied', async () => {
    const wrapper = await mount(undefined)
    await wrapper.find('[data-testid="theme-custom-css-example-pageNumber"]').trigger('click')

    await vi.waitFor(() => {
      const emitted = wrapper.emitted('update:modelValue')
      expect(emitted?.at(-1)?.[0]).toContain('@bottom-center')
    }, { timeout: 3000 })
    expect(wrapper.find('[data-testid="theme-custom-css-status"]').text()).toBe('applied')
    expect(wrapper.find('[data-testid="theme-custom-css-issues"]').exists()).toBe(false)
  })

  it('invalid CSS is listed with its position and never emitted', async () => {
    const wrapper = await mount('')
    await wrapper.setProps({ modelValue: 'p { color: red }\n@import "http://evil.test/x.css";' })

    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="theme-custom-css-issues"]').exists()).toBe(true)
    }, { timeout: 3000 })
    const issues = wrapper.find('[data-testid="theme-custom-css-issues"]').text()
    expect(issues).toContain('line 2, col 1')
    expect(issues).toContain('@import is not allowed in custom CSS.')
    expect(wrapper.find('[data-testid="theme-custom-css-status"]').text()).toContain('not applied')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('shows the byte counter against the 64 KB limit', async () => {
    const wrapper = await mount('p{}')
    expect(wrapper.find('[data-testid="theme-custom-css-bytes"]').text()).toMatch(/^3 \/ 65,536 bytes$/)
  })
})
