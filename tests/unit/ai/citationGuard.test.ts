import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { ungroundedCitationError, ungroundedCitations } from '../../../server/utils/ai/citationGuard'
import { titleMatch } from '../../../server/utils/ai/tools/citationTools'
import { BIBLIOGRAPHY_ROOT } from '../../../shared/utils/citations/docBibliography'

function docWith(keys: string[]): Y.Doc {
  const doc = new Y.Doc()
  const map = doc.getMap(BIBLIOGRAPHY_ROOT)
  for (const k of keys) map.set(k, JSON.stringify({ id: k, type: 'book', title: k }))
  return doc
}

describe('grounded citing', () => {
  const doc = docWith(['smith2020'])

  it('lets keys from the bibliography through', () => {
    expect(ungroundedCitations('As shown [@smith2020, p. 4] and @smith2020.', '', doc)).toEqual([])
  })

  it('refuses invented keys, bracketed or key-like bare ones', () => {
    expect(ungroundedCitations('Known [@smith2020; @doe2019]. Also @lee2021 found.', '', doc)).toEqual(['doe2019', 'lee2021'])
    expect(ungroundedCitationError('[@made2024up]', '', doc)).toContain('@made2024up')
  })

  it('ignores cross-references, mentions and code', () => {
    expect(ungroundedCitations('See @fig:x, ask @team, `[@nope2020]`.', '', doc)).toEqual([])
  })

  it('keeps keys the replaced text already cited', () => {
    expect(ungroundedCitations('Rephrased [@old2019].', 'Original [@old2019].', doc)).toEqual([])
  })
})

describe('DOI title check', () => {
  it('matches the same work, refuses another', () => {
    expect(titleMatch('Attention is all you need', 'Attention Is All You Need')).toBe(1)
    expect(titleMatch('Attention is all you need', 'Deep residual learning for image recognition')).toBeLessThan(0.6)
  })
})
