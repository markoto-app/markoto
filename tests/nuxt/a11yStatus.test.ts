// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { EditorLayoutA11yStatus } from '#components'

// The status-bar entry of the editor's accessibility check: nothing while
// the document is clean, a count of the issues otherwise.

async function settle(): Promise<void> {
  // The check runs on a debounced copy of the text.
  await new Promise(r => setTimeout(r, 700))
}

describe('EditorLayoutA11yStatus', () => {
  it('stays hidden for a document without issues', async () => {
    const w = await mountSuspended(EditorLayoutA11yStatus, { props: { text: '# Title\n\n![A chart](/a.png)\n' } })
    await settle()
    expect(w.find('[data-testid="a11y-check-status"]').exists()).toBe(false)
  })

  it('shows the number of issues', async () => {
    const w = await mountSuspended(EditorLayoutA11yStatus, { props: { text: '# Title\n\n### Skipped\n\n![](/a.png) [](https://x.test)\n' } })
    await settle()
    const status = w.find('[data-testid="a11y-check-status"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain('3')
  })
})
