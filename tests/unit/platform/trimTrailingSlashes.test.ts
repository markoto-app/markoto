import { describe, it, expect } from 'vitest'
import { trimTrailingSlashes } from '../../../shared/utils/trimTrailingSlashes'

// Replacement for the `.replace(/\/+$/, '')` pattern that SonarQube
// flags as super-linear (S8786). Must behave identically.

describe('trimTrailingSlashes', () => {
  it('strips a single trailing slash', () => {
    expect(trimTrailingSlashes('http://litellm:4000/')).toBe('http://litellm:4000')
  })

  it('strips runs of trailing slashes', () => {
    expect(trimTrailingSlashes('http://litellm:4000///')).toBe('http://litellm:4000')
  })

  it('leaves slash-free strings untouched', () => {
    expect(trimTrailingSlashes('http://litellm:4000')).toBe('http://litellm:4000')
  })

  it('keeps interior slashes', () => {
    expect(trimTrailingSlashes('http://host/api/v1/')).toBe('http://host/api/v1')
  })

  it('handles empty and all-slash strings', () => {
    expect(trimTrailingSlashes('')).toBe('')
    expect(trimTrailingSlashes('///')).toBe('')
  })

  it('matches the old regex across a corpus', () => {
    const corpus = ['', '/', '//', 'a', 'a/', 'a//b//', '/a/', 'http://x//', '/'.repeat(1000)]
    for (const input of corpus) {
      expect(trimTrailingSlashes(input), JSON.stringify(input)).toBe(input.replace(/\/+$/, ''))
    }
  })
})
