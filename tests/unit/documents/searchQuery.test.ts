import { describe, it, expect } from 'vitest'
import { prefixTsQuery, searchTerms, splitSnippet, SNIPPET_START, SNIPPET_STOP } from '../../../shared/utils/documents/searchQuery'

describe('searchTerms / prefixTsQuery', () => {
  it('turns every word into a lower-case prefix match, all required', () => {
    expect(prefixTsQuery('Quarterly Report')).toBe('quarterly:* & report:*')
  })

  it('returns null when nothing searchable is left', () => {
    expect(prefixTsQuery('')).toBeNull()
    expect(prefixTsQuery('  !!! ... ')).toBeNull()
  })

  it('strips every tsquery operator so user input can never form its own query', () => {
    expect(prefixTsQuery('a & b | !c <-> (d):* \'e\'')).toBe('a:* & b:* & c:* & d:* & e:*')
    expect(prefixTsQuery('foo:*&bar')).toBe('foo:* & bar:*')
  })

  it('keeps letters and digits of every script', () => {
    expect(searchTerms('Grüße 2026 東京 Ελλάδα')).toEqual(['grüße', '2026', '東京', 'ελλάδα'])
  })

  it('deduplicates, caps the number of terms and the term length', () => {
    expect(searchTerms('a A a b')).toEqual(['a', 'b'])
    expect(searchTerms('1 2 3 4 5 6 7 8 9 10')).toHaveLength(8)
    expect(searchTerms('x'.repeat(200))[0]).toHaveLength(64)
  })
})

describe('splitSnippet', () => {
  const m = (s: string) => `${SNIPPET_START}${s}${SNIPPET_STOP}`

  it('splits plain and matched parts in order', () => {
    expect(splitSnippet(`the ${m('quick')} brown ${m('fox')}`)).toEqual([
      { text: 'the ', match: false },
      { text: 'quick', match: true },
      { text: ' brown ', match: false },
      { text: 'fox', match: true }
    ])
  })

  it('returns one plain part for a snippet without matches, none for an empty one', () => {
    expect(splitSnippet('nothing here')).toEqual([{ text: 'nothing here', match: false }])
    expect(splitSnippet('')).toEqual([])
  })

  it('treats an unterminated mark as plain text', () => {
    expect(splitSnippet(`a ${SNIPPET_START}b`)).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: false }
    ])
  })

  it('drops empty parts and HTML tags (the text stays plain text)', () => {
    expect(splitSnippet(`${m('')}<b>x</b> 1 < 2`)).toEqual([{ text: 'x 1 < 2', match: false }])
  })

  it('shows link and image text without their targets, also with a match inside or a cut-off target', () => {
    const text = (s: string) => splitSnippet(s).map(p => p.text).join('')
    expect(text('see [Plan](/d/A-OazMp4f8) and ![logo](/api/files/x.png) now')).toBe('see Plan and logo now')
    expect(splitSnippet(`see [${m('Plan')}](/d/A-Oaz) now`)).toEqual([
      { text: 'see ', match: false },
      { text: 'Plan', match: true },
      { text: ' now', match: false }
    ])
    expect(text('lan](/d/A-Oaz) then [Next](/d/B-')).toBe('lan then Next')
  })

  it('drops heading, quote, list, emphasis and code markers but keeps a dash in prose', () => {
    const text = (s: string) => splitSnippet(s).map(p => p.text).join('')
    expect(text('## Goals\n- **ship** the `api`\n> quoted\n1. first')).toBe('Goals ship the api quoted first')
    expect(text('before - after')).toBe('before - after')
  })
})
