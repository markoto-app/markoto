// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { DocumentDesignFromDocumentDialog } from '#components'

// Making a design from a document takes minutes. While it runs the dialog
// says so: the AI line with the seal, what markoto is doing right now, a
// running clock and a note that it may take a few minutes.

mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
mockNuxtImport('useAiAvailability', () => () => ({
  availability: ref(null),
  refresh: vi.fn()
}))

registerEndpoint('/api/themes/from-document/upload-request', {
  method: 'POST',
  handler: () => ({ uploadId: 'u1', uploadUrl: '/_test/design-put', mimeType: 'application/pdf' })
})
registerEndpoint('/_test/design-put', { method: 'PUT', handler: () => 'ok' })
registerEndpoint('/api/themes/from-document/start', { method: 'POST', handler: () => ({ jobId: 'j1' }) })
registerEndpoint('/api/themes/from-document/jobs/j1', () => ({
  phase: 'designing',
  round: 2,
  maxRounds: 3,
  format: 'pdf'
}))

function byTestid(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`)
}

describe('design-from-document progress', () => {
  it('shows the AI line, the clock and the duration note while working', async () => {
    const wrapper = await mountSuspended(DocumentDesignFromDocumentDialog, {
      props: { open: true, canApply: true },
      attachTo: document.body
    })
    await vi.waitFor(() => expect(byTestid('design-import-file')).not.toBeNull())
    const input = byTestid('design-import-file')
    if (!(input instanceof HTMLInputElement)) throw new Error('file input missing')
    const file = new File(['%PDF-1.7'], 'brand.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))

    await vi.waitFor(() => expect(byTestid('design-import-thinking')).not.toBeNull())
    expect(byTestid('design-import-thinking')?.getAttribute('role')).toBe('status')
    expect(byTestid('design-import-thinking')?.querySelector('.mk-ai-thinking__seal')).not.toBeNull()
    expect(byTestid('design-import-elapsed')?.textContent?.trim()).toMatch(/^0:\d\d$/)
    expect(byTestid('design-import-progress')?.textContent).toContain('two to five minutes')

    // After the first poll the line names the comparison round.
    await vi.waitFor(
      () => expect(byTestid('design-import-thinking')?.textContent).toContain('round 2 of 3'),
      { timeout: 4000 }
    )
    expect(byTestid('design-import-elapsed')?.textContent?.trim()).not.toBe('0:00')
    wrapper.unmount()
  })
})
