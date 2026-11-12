// @vitest-environment jsdom
//
// Text the user controls (headings, titles, URLs, style values, pasted
// documents) reaches these helpers. Each used a `x+$` or lookbehind shape that
// backtracks quadratically on a long run that does not end where the pattern
// needs it; the rewrites must stay linear. A pathological input at 200k
// characters would take minutes with the old patterns.
import { describe, expect, test } from 'vitest'
import { headingKey, trimTrailing } from '../../app/utils/markdown/trimTrailing'
import { titleFromMarkdown } from '../../app/utils/marketing/tryIt'
import { keepCompoundsTogether, keepNumbersTogether } from '../../app/utils/preview/coverHtml'
import { sanitizeRenderedHtml } from '../../app/utils/markdown/sanitizeHtml'

const LONG = 200_000
const BUDGET_MS = 1_000

function timed<T>(run: () => T): { result: T, ms: number } {
  const start = performance.now()
  const result = run()
  return { result, ms: performance.now() - start }
}

describe('trimTrailing', () => {
  test('trims only the trailing run', () => {
    expect(trimTrailing('abc///', '/')).toBe('abc')
    expect(trimTrailing('///abc', '/')).toBe('///abc')
    expect(trimTrailing('/', '/')).toBe('')
    expect(trimTrailing('abc', '/')).toBe('abc')
  })

  test('a long run that is not at the end stays linear', () => {
    const { result, ms } = timed(() => trimTrailing(`${'/'.repeat(LONG)}x`, '/'))
    expect(result.length).toBe(LONG + 1)
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})

describe('headingKey', () => {
  test('lowercases and drops the closing colon or full stop', () => {
    const el = document.createElement('h2')
    el.textContent = '  References: '
    expect(headingKey(el)).toBe('references')
    el.textContent = '参考文献。'
    expect(headingKey(el)).toBe('参考文献')
  })

  test('a heading made of punctuation stays linear', () => {
    const el = document.createElement('h2')
    el.textContent = `${'.'.repeat(LONG)}a`
    const { ms } = timed(() => headingKey(el))
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})

describe('titleFromMarkdown', () => {
  test('reads the first heading, with or without closing hashes', () => {
    expect(titleFromMarkdown('# Hello world')).toBe('Hello world')
    expect(titleFromMarkdown('## Hello world ##')).toBe('Hello world')
    expect(titleFromMarkdown('# C#')).toBe('C#')
    expect(titleFromMarkdown('# Issue #12 ###')).toBe('Issue #12')
    expect(titleFromMarkdown('```\n# not a title\n```\n# real')).toBe('real')
    expect(titleFromMarkdown('no heading here')).toBe('')
  })

  test('a heading line of spaces and hashes stays linear', () => {
    const { ms } = timed(() => titleFromMarkdown(`# a${' #'.repeat(LONG / 2)}x`))
    expect(ms).toBeLessThan(BUDGET_MS)
    const spaces = timed(() => titleFromMarkdown(`# a${' '.repeat(LONG)}x`))
    expect(spaces.ms).toBeLessThan(BUDGET_MS)
  })
})

describe('cover title helpers', () => {
  test('keepNumbersTogether joins neighbouring words that both carry a digit', () => {
    expect(keepNumbersTogether('Q3 2026 Report')).toBe('Q3 2026 Report')
    expect(keepNumbersTogether('ISO 9001 2015 audit')).toBe('ISO 9001 2015 audit')
    expect(keepNumbersTogether('Chapter 3 \u2014 Learning')).toBe('Chapter 3 \u2014 Learning')
    expect(keepNumbersTogether('a  1 1')).toBe('a  1 1')
  })

  test('long titles stay linear', () => {
    const words = timed(() => keepNumbersTogether(`${'a1'.repeat(LONG / 2)} `))
    expect(words.ms).toBeLessThan(BUDGET_MS)
    const compound = timed(() => keepCompoundsTogether('a'.repeat(LONG)))
    expect(compound.ms).toBeLessThan(BUDGET_MS)
    expect(keepCompoundsTogether('field-service reports')).toBe('<span class="markoto-nobreak">field-service</span> reports')
  })
})

describe('style function scan', () => {
  test('a long dashed word without a parenthesis stays linear', () => {
    const { ms } = timed(() => sanitizeRenderedHtml(`<span style="color: ${'a-'.repeat(LONG / 2)}">x</span>`))
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  test('functions are still checked against the allowlist', () => {
    expect(sanitizeRenderedHtml('<span style="color: rgb(1, 2, 3)">x</span>')).toContain('rgb(1, 2, 3)')
    expect(sanitizeRenderedHtml('<span style="color: url(x)">x</span>')).not.toContain('url(')
  })
})
