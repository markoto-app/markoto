import { describe, it, expect, vi } from 'vitest'

// Regression: the print path and the server render page used to call the
// render-time sanitize without a guard, so input that made the sanitizer
// throw failed the whole render. The loader now fails closed (no custom
// CSS) instead.
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
