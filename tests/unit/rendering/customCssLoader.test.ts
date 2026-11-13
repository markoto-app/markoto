import { describe, it, expect, vi } from 'vitest'

// The print path and the server render page must call the render-time sanitize with a guard: input that makes
// the sanitizer throw must not fail the whole render. The loader fails closed (no custom CSS) instead.
vi.mock('../../../shared/utils/theme/customCss', () => ({
  sanitizeCustomCss: () => {
    throw new RangeError('Maximum call stack size exceeded')
  }
}))

describe('sanitizeCustomCssForRender', () => {
  it('returns no custom CSS when the sanitizer throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sanitizeCustomCssForRender } = await import('../../../app/utils/preview/customCssLoader')
    await expect(sanitizeCustomCssForRender('p { color: red }', { docId: 'doc1' })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
