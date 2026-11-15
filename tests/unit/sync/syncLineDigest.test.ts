import { describe, it, expect } from 'vitest'
import { LINE_DIFF_MAX_LINES, lineDiff, lineDiffDigests, lineDigest } from '../../../sync-server/src/activity-logger'

// The diff baseline in Valkey is a line digest, not the text: these pin
// that the counts match a plain line LCS and that a baseline stays small.

describe('line digests', () => {
  it('counts added and removed lines like a line LCS', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 })
    expect(lineDiff('a\nb\nc', 'a\nx\nb\nc')).toEqual({ added: 1, removed: 0 })
    expect(lineDiff('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 })
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 })
    expect(lineDiff('', '# Title\n\nbody')).toEqual({ added: 2, removed: 0 })
  })

  it('diffs two stored digests the same way', () => {
    const before = lineDigest('one\ntwo\nthree')
    const after = lineDigest('one\n2\nthree\nfour')
    expect(lineDiffDigests(before, after)).toEqual({ added: 2, removed: 1 })
  })

  it('stores 8 characters per line, far less than the text', () => {
    const text = Array.from({ length: 250 }, (_, i) => `Line ${i} of a fairly ordinary markdown paragraph, about sixty characters.`).join('\n')
    const digest = lineDigest(text)
    expect(digest).toMatch(/^250:[A-Za-z0-9+/]{2000}$/)
    expect(digest.length).toBeLessThan(text.length / 5)
  })

  it('keeps only the line count above the LCS cap and diffs by the count delta', () => {
    const big = Array.from({ length: LINE_DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n')
    expect(lineDigest(big)).toBe(String(LINE_DIFF_MAX_LINES + 1))
    expect(lineDiff(big, `${big}\nmore\nlines`)).toEqual({ added: 2, removed: 0 })
    expect(lineDiff(big, 'short')).toEqual({ added: 0, removed: LINE_DIFF_MAX_LINES })
  })

  it('treats a value that is not a digest as no change', () => {
    expect(lineDiffDigests('# some old text', lineDigest('x'))).toEqual({ added: 0, removed: 0 })
    expect(lineDiffDigests('3:short', lineDigest('x'))).toEqual({ added: 0, removed: 0 })
  })
})
