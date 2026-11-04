import { describe, it, expect } from 'vitest'
import { titleFromMarkdown, tryItErrorKey } from '../../app/utils/tryIt'

// Pure helpers of the marketing `::try-it` block.

describe('titleFromMarkdown', () => {
  it('takes the first ATX heading, any level, without closing hashes', () => {
    expect(titleFromMarkdown('# Field notes\n\nBody')).toBe('Field notes')
    expect(titleFromMarkdown('intro\n\n## Second level ##\n# Later')).toBe('Second level')
    expect(titleFromMarkdown('   ### Indented   ')).toBe('Indented')
  })

  it('ignores headings inside code fences and hashes without a space', () => {
    expect(titleFromMarkdown('```\n# not a heading\n```\n#hashtag\n# Real')).toBe('Real')
  })

  it('is empty without a heading and caps the length', () => {
    expect(titleFromMarkdown('Just a paragraph.')).toBe('')
    expect(titleFromMarkdown(`# ${'a'.repeat(400)}`)).toHaveLength(255)
  })
})

function fetchError(statusCode: number, code?: string) {
  return { statusCode, data: code ? { statusCode, data: { code } } : { statusCode } }
}

describe('tryItErrorKey', () => {
  it('names the gate refusals when creating the document', () => {
    expect(tryItErrorKey(fetchError(403, 'anon-gate/terms-required'), 'create')).toBe('anonGate.errors.termsRequired')
    expect(tryItErrorKey(fetchError(403, 'anon-gate/bot-check-failed'), 'create')).toBe('anonGate.errors.botCheck')
    expect(tryItErrorKey(fetchError(503, 'anon-gate/unavailable'), 'create')).toBe('anonGate.errors.unavailable')
    expect(tryItErrorKey(fetchError(429, 'docs/rate-limited'), 'create')).toBe('anonGate.errors.rateLimited')
    expect(tryItErrorKey(fetchError(400, 'docs/content-too-long'), 'create')).toBe('marketing.tryIt.errors.tooLong')
    expect(tryItErrorKey(new Error('offline'), 'create')).toBe('marketing.tryIt.errors.create')
  })

  it('separates the PDF rate limit from other PDF failures', () => {
    expect(tryItErrorKey(fetchError(429), 'pdf')).toBe('marketing.tryIt.errors.pdfRateLimited')
    expect(tryItErrorKey(fetchError(502), 'pdf')).toBe('marketing.tryIt.errors.pdf')
    expect(tryItErrorKey(null, 'pdf')).toBe('marketing.tryIt.errors.pdf')
  })
})
