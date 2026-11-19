import { describe, it, expect } from 'vitest'
import { parseBibtex } from '../../../shared/utils/citations/bibtex'
import { CITATION_STYLE_IDS, formatBibliography, formatCluster, htmlToText, planBibliography, type CitationStyleId } from '../../../shared/utils/citations/citationStyles'
import { parseBracketCluster } from '../../../shared/utils/citations/citeSyntax'
import type { CslItem } from '../../../shared/utils/citations/cslItem'

const { items } = parseBibtex(`
@article{smith2020,
  author = {Smith, John Adam and Jones, Kate and M{\\"u}ller, J{\\"o}rg},
  title = {A Study of Things},
  journal = {Journal of Testing},
  year = 2020, month = may, volume = {12}, number = {3}, pages = {45--67},
  doi = {10.1000/xyz123}
}
@book{knuth1984,
  author = {Donald E. Knuth}, title = {The {\\TeX}book},
  publisher = {Addison-Wesley}, address = {Reading, MA}, year = {1984}, edition = {2}
}
@incollection{berg2019,
  author = {van der Berg, Anna}, title = {Chapter Title}, booktitle = {Big Book},
  editor = {Miller, Tom and Lee, Sue}, publisher = {Springer}, address = {Berlin}, year = 2019, pages = {10-20}
}
@online{who2021,
  author = {{World Health Organization}}, title = {Fact sheet},
  url = {https://www.who.int/x}, urldate = {2024-03-05}, year = 2021
}
`)
const byId = new Map(items.map(i => [i.id, i]))
const get = (id: string): CslItem => {
  const item = byId.get(id)
  if (!item) throw new Error(id)
  return item
}

function bib(style: CitationStyleId, locale = 'en', cited: CslItem[] = items): string[] {
  const html = formatBibliography(planBibliography(cited, style, locale))
  return html.split(/<div class="csl-entry"[^>]*>/).slice(1).map(htmlToText)
}

function cite(style: CitationStyleId, cluster: string, narrative = false, locale = 'en'): string {
  const refs = parseBracketCluster(cluster)
  if (!refs) throw new Error(cluster)
  const plan = planBibliography(items, style, locale)
  return htmlToText(formatCluster(refs.map(ref => ({ ref, item: get(ref.key) })), plan.ctx, narrative))
}

describe('APA 7', () => {
  it('citations', () => {
    expect(cite('apa', '@smith2020, p. 12')).toBe('(Smith et al., 2020, p. 12)')
    expect(cite('apa', 'see @knuth1984; @berg2019, ch. 3')).toBe('(see Knuth, 1984; van der Berg, 2019, chap. 3)')
    expect(cite('apa', '-@knuth1984')).toBe('(1984)')
    expect(cite('apa', '@knuth1984', true)).toBe('Knuth (1984)')
  })

  it('bibliography', () => {
    expect(bib('apa')).toEqual([
      'van der Berg, A. (2019). Chapter Title. In T. Miller & S. Lee (Eds.), Big Book (pp. 10–20). Springer.',
      'Knuth, D. E. (1984). The TeXbook (2nd ed.). Addison-Wesley.',
      'Smith, J. A., Jones, K., & Müller, J. (2020). A Study of Things. Journal of Testing, 12(3), 45–67. https://doi.org/10.1000/xyz123',
      'World Health Organization. (2021). Fact sheet. https://www.who.int/x'
    ])
  })

  it('German terms', () => {
    expect(cite('apa', '@smith2020, S. 12', false, 'de')).toBe('(Smith et al., 2020, S. 12)')
    expect(bib('apa', 'de', [get('knuth1984')])).toEqual(['Knuth, D. E. (1984). The TeXbook (2. Aufl.). Addison-Wesley.'])
  })
})

describe('Chicago author-date', () => {
  it('citations and bibliography', () => {
    expect(cite('chicago-author-date', '@smith2020, p. 12')).toBe('(Smith, Jones, and Müller 2020, 12)')
    expect(bib('chicago-author-date', 'en', [get('smith2020')])).toEqual([
      'Smith, John Adam, Kate Jones, and Jörg Müller. 2020. “A Study of Things.” Journal of Testing 12 (3): 45–67. https://doi.org/10.1000/xyz123.'
    ])
  })
})

describe('Harvard', () => {
  it('citations and bibliography', () => {
    expect(cite('harvard', '@knuth1984, p. 3')).toBe('(Knuth, 1984, p. 3)')
    expect(bib('harvard', 'en', [get('knuth1984')])).toEqual(['Knuth, D. E. (1984) The TeXbook. 2nd edn. Reading, MA: Addison-Wesley.'])
  })
})

describe('IEEE', () => {
  it('numbers by first citation', () => {
    const plan = planBibliography([get('knuth1984'), get('smith2020')], 'ieee', 'en')
    expect(plan.ctx.numbers.get('knuth1984')).toBe(1)
    const refs = parseBracketCluster('@smith2020, pp. 3-4; @knuth1984') ?? []
    expect(htmlToText(formatCluster(refs.map(ref => ({ ref, item: get(ref.key) })), plan.ctx, false))).toBe('[2, pp. 3–4], [1]')
    expect(bib('ieee', 'en', [get('smith2020')])).toEqual([
      '[1]J. A. Smith, K. Jones, and J. Müller, “A Study of Things,” Journal of Testing, vol. 12, no. 3, pp. 45–67, May 2020, doi: 10.1000/xyz123.'
    ])
  })
})

describe('Vancouver', () => {
  it('bibliography', () => {
    expect(bib('vancouver', 'en', [get('smith2020')])).toEqual([
      '1.Smith JA, Jones K, Müller J. A Study of Things. Journal of Testing. 2020;12(3):45–67. doi:10.1000/xyz123'
    ])
  })
})

describe('DIN 1505-2', () => {
  it('uses German terms and small caps names', () => {
    expect(cite('din-1505-2', '@smith2020, p. 12')).toBe('(Smith u. a. 2020, S. 12)')
    const html = formatBibliography(planBibliography([get('knuth1984')], 'din-1505-2', 'en'))
    expect(html).toContain('<span class="csl-sc">Knuth</span>')
    expect(htmlToText(html)).toBe('Knuth, Donald E.: The TeXbook. 2. Aufl. Reading, MA : Addison-Wesley, 1984')
  })
})

describe('every style', () => {
  it.each(CITATION_STYLE_IDS)('%s formats every item type without empty parts', (style) => {
    for (const line of bib(style)) {
      expect(line).not.toMatch(/undefined|null|\(\)|, ,|\.\./)
      expect(line.length).toBeGreaterThan(10)
    }
  })

  it('disambiguates same author and year', () => {
    const a: CslItem = { id: 'a', type: 'book', title: 'Alpha', author: [{ family: 'Roe', given: 'A' }], issued: { 'date-parts': [[2020]] } }
    const b: CslItem = { ...a, id: 'b', title: 'Beta' }
    const plan = planBibliography([b, a], 'apa', 'en')
    expect(plan.ctx.yearSuffix.get('a')).toBe('a')
    expect(plan.ctx.yearSuffix.get('b')).toBe('b')
  })

  it('escapes HTML in entry fields', () => {
    const x: CslItem = { id: 'x', type: 'book', title: '<img src=x onerror=alert(1)>', author: [{ family: '<b>' }] }
    const html = formatBibliography(planBibliography([x], 'apa', 'en'))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>')
  })
})
