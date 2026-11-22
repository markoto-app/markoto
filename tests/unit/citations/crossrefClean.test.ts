import { describe, it, expect } from 'vitest'
import { cleanCrossrefRecord, isAllCaps, recaseName, recaseTitle, stripNumeralPrefix } from '../../../shared/utils/citations/crossrefClean'
import { normalizeCslItem } from '../../../shared/utils/citations/cslItem'

// What Crossref's CSL JSON transform returns for 10.1093/mind/LIX.236.433.
const TURING = {
  'DOI': '10.1093/mind/lix.236.433',
  'id': 'x',
  'type': 'article-journal',
  'title': 'I.\u2014COMPUTING MACHINERY AND INTELLIGENCE',
  'author': [{ family: 'TURING', given: 'A. M.' }],
  'container-title': 'Mind',
  'publisher': 'Oxford University Press (OUP)',
  'volume': 'LIX',
  'issue': '236',
  'page': '433-460',
  'issued': { 'date-parts': [[1950, 10, 1]] }
}

describe('cleanCrossrefRecord', () => {
  it('fixes the Turing record from Crossref', () => {
    const out = cleanCrossrefRecord(TURING)
    expect(out.title).toBe('Computing Machinery and Intelligence')
    expect(out.author).toEqual([{ family: 'Turing', given: 'A. M.' }])
    expect(out['container-title']).toBe('Mind')
    expect(out.publisher).toBeUndefined()
    expect(out.volume).toBe('LIX')
    expect(out.issue).toBe('236')
    expect(out.page).toBe('433-460')
    const item = normalizeCslItem({ ...out, id: 'turing1950computing' })
    expect(item?.['container-title']).toBe('Mind')
    expect(item?.page).toBe('433-460')
  })

  it('takes the journal from a list or the short form, never from the publisher', () => {
    expect(cleanCrossrefRecord({ 'type': 'article-journal', 'title': 'T', 'container-title': ['Nature'], 'publisher': 'Springer' })['container-title']).toBe('Nature')
    expect(cleanCrossrefRecord({ 'type': 'article-journal', 'title': 'T', 'container-title': [], 'short-container-title': ['Nat.'] })['container-title']).toBe('Nat.')
    const none = cleanCrossrefRecord({ 'type': 'book', 'title': 'T', 'container-title': '', 'publisher': 'MIT Press' })
    expect(none['container-title']).toBeUndefined()
    expect(none.publisher).toBe('MIT Press')
  })

  it('keeps the publisher of a non-journal entry that has a container', () => {
    expect(cleanCrossrefRecord({ 'type': 'chapter', 'title': 'T', 'container-title': 'Book', 'publisher': 'Springer' }).publisher).toBe('Springer')
  })

  it('uses the article number where there are no pages', () => {
    expect(cleanCrossrefRecord({ 'type': 'article-journal', 'title': 'T', 'article-number': 'e1234' }).page).toBe('e1234')
    expect(cleanCrossrefRecord({ 'type': 'article-journal', 'title': 'T', 'article-number': 'e1', 'page': '5-9' }).page).toBe('5-9')
  })

  it('leaves mixed-case titles, names and untyped fields alone', () => {
    const out = cleanCrossrefRecord({ title: 'Attention Is All You Need', author: [{ family: 'Vaswani', given: 'Ashish' }, 'plain', { literal: 'WHO TEAM' }, null], editor: [] })
    expect(out.title).toBe('Attention Is All You Need')
    expect(out.author).toEqual([{ family: 'Vaswani', given: 'Ashish' }, 'plain', { literal: 'Who Team' }, null])
  })
})

describe('recaseTitle', () => {
  it('sets an all-caps title in title case with small words low', () => {
    expect(recaseTitle('THE ORIGIN OF SPECIES BY MEANS OF NATURAL SELECTION')).toBe('The Origin of Species by Means of Natural Selection')
  })

  it('keeps acronyms, dotted abbreviations and words with digits', () => {
    expect(recaseTitle('DNA REPAIR IN THE U.S. AND THE EU')).toBe('DNA Repair in the U.S. and the EU')
    expect(recaseTitle('A 3D VIEW OF AI')).toBe('A 3D View of AI')
  })

  it('capitalises after a colon and inside hyphenated words', () => {
    expect(recaseTitle('STATE-OF-THE-ART: THE END')).toBe('State-of-the-Art: The End')
  })

  it('leaves text that has lower case letters alone', () => {
    expect(recaseTitle('Of Mice and MEN')).toBe('Of Mice and MEN')
    expect(isAllCaps('1234')).toBe(false)
    expect(recaseTitle('1950')).toBe('1950')
  })
})

describe('recaseName', () => {
  it('recases family names and keeps initials', () => {
    expect(recaseName('TURING')).toBe('Turing')
    expect(recaseName('A. M.')).toBe('A. M.')
    expect(recaseName('J')).toBe('J')
    expect(recaseName('SMITH-JONES')).toBe('Smith-Jones')
    expect(recaseName('O\'BRIEN')).toBe('O\'Brien')
    expect(recaseName('VAN DER BERG')).toBe('Van der Berg')
    expect(recaseName('McDonald')).toBe('McDonald')
  })
})

describe('stripNumeralPrefix', () => {
  it('removes section numerals with a dot or dash', () => {
    expect(stripNumeralPrefix('I.\u2014COMPUTING')).toBe('COMPUTING')
    expect(stripNumeralPrefix('II. Methods')).toBe('Methods')
    expect(stripNumeralPrefix('IV.-Notes')).toBe('Notes')
    expect(stripNumeralPrefix('V–Notes')).toBe('Notes')
  })

  it('keeps titles that merely start with those letters', () => {
    expect(stripNumeralPrefix('I Am Legend')).toBe('I Am Legend')
    expect(stripNumeralPrefix('X-Ray Diffraction')).toBe('X-Ray Diffraction')
    expect(stripNumeralPrefix('Civil War')).toBe('Civil War')
    expect(stripNumeralPrefix('I.')).toBe('I.')
  })
})
