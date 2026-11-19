import { describe, it, expect } from 'vitest'
import { crossrefKind, findCitations, maskCode, parseBracketCluster, parseSuffix } from '../../../shared/utils/citations/citeSyntax'
import { citationKeyFor, normalizeDoi } from '../../../shared/utils/citations/citationKey'
import { crossrefText } from '../../../shared/utils/citations/crossrefTerms'
import { normalizeCslItem, readStoredBibliography } from '../../../shared/utils/citations/cslItem'

describe('parseBracketCluster', () => {
  it('reads prefixes, locators, suffixes and suppressed authors', () => {
    expect(parseBracketCluster('see @smith2020, pp. 33-35, emphasis added; -@doe99')).toEqual([
      { key: 'smith2020', prefix: 'see', suffix: 'emphasis added', locator: { label: 'page', value: '33–35' }, suppressAuthor: false },
      { key: 'doe99', prefix: '', suffix: '', suppressAuthor: true }
    ])
  })

  it('is not a citation without a key in every part', () => {
    expect(parseBracketCluster('just text')).toBeNull()
    expect(parseBracketCluster('@a; no key here')).toBeNull()
    expect(parseBracketCluster('mail joel@example.com')).toBeNull()
  })

  it('keys end in a word character', () => {
    expect(parseBracketCluster('@smith2020.')?.[0]?.key).toBe('smith2020')
    expect(parseBracketCluster('@fig:overview')?.[0]?.key).toBe('fig:overview')
  })
})

describe('parseSuffix', () => {
  it.each([
    [', 12', { locator: { label: 'page', value: '12' }, suffix: '' }],
    [', S. 4f.', { locator: { label: 'page', value: '4f.' }, suffix: '' }],
    [', chap. 3', { locator: { label: 'chapter', value: '3' }, suffix: '' }],
    [', § 12', { locator: { label: 'section', value: '12' }, suffix: '' }],
    [', and elsewhere', { suffix: 'and elsewhere' }]
  ])('%s', (raw, expected) => {
    expect(parseSuffix(raw)).toEqual(expected)
  })
})

describe('findCitations', () => {
  it('finds bracketed and bare keys outside code and math', () => {
    const src = 'A [@a; @b]. B @c. `@d` $x@e$\n\n```\n@f\n```\nmail x@g.com'
    expect(findCitations(src).map(c => [c.key, c.bracketed])).toEqual([['a', true], ['b', true], ['c', false]])
  })

  it('masks without moving offsets', () => {
    const src = 'x `code` y'
    expect(maskCode(src)).toHaveLength(src.length)
  })
})

describe('cross-reference helpers', () => {
  it('kinds', () => {
    expect(crossrefKind('fig:a')).toBe('fig')
    expect(crossrefKind('tbl:x')).toBe('tbl')
    expect(crossrefKind('smith2020')).toBeNull()
    expect(crossrefKind('fig:')).toBeNull()
  })

  it('text per language', () => {
    expect(crossrefText('fig', ['3'], 'en')).toBe('Figure 3')
    expect(crossrefText('tbl', ['1', '2'], 'de')).toBe('Tabellen 1 und 2')
    expect(crossrefText('eq', ['(1)', '(2)', '(3)'], 'fr')).toBe('Équations (1), (2) et (3)')
    expect(crossrefText('fig', ['2'], 'pl', 'Rysunek')).toBe('Rysunek 2')
    expect(crossrefText('fig', ['2'], 'ja')).toBe('図2')
  })
})

describe('keys, DOIs and stored entries', () => {
  it('generates readable unique keys', () => {
    const item = { title: 'The Art of Computer Programming', author: [{ family: 'Knüth' }], issued: { 'date-parts': [[1968]] } }
    expect(citationKeyFor(item)).toBe('knuth1968art')
    expect(citationKeyFor(item, k => k === 'knuth1968art')).toBe('knuth1968arta')
  })

  it('normalises DOIs', () => {
    expect(normalizeDoi('https://doi.org/10.1000/XYZ.1')).toBe('10.1000/XYZ.1')
    expect(normalizeDoi('doi: 10.1234/abc')).toBe('10.1234/abc')
    expect(normalizeDoi('not a doi')).toBeNull()
  })

  it('validates stored entries', () => {
    const good = JSON.stringify({ id: 'k', type: 'book', title: 'T' })
    const items = readStoredBibliography([['k', good], ['bad key!', good], ['x', '{oops'], ['y', 42], ['z', JSON.stringify({ type: 'book' })]])
    expect(items.map(i => i.id)).toEqual(['k'])
  })

  it('drops unknown fields and bounds text', () => {
    const item = normalizeCslItem({ id: 'k', type: 'weird', title: 'x'.repeat(5000), evil: '<script>', author: [{ family: 'A' }, 'B Literal', 3] })
    expect(item?.type).toBe('document')
    expect(item?.title).toHaveLength(2000)
    expect(item && 'evil' in item).toBe(false)
    expect(item?.author).toEqual([{ family: 'A' }, { literal: 'B Literal' }])
  })
})
