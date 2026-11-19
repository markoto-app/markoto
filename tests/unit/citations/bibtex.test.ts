import { describe, it, expect } from 'vitest'
import { latexToUnicode, parseBibtex, parseBibtexName } from '../../../shared/utils/citations/bibtex'
import { parseBibliographyText } from '../../../shared/utils/citations/bibImport'

describe('parseBibtex', () => {
  it('reads a typical Zotero / Google Scholar entry', () => {
    const { items, skipped } = parseBibtex(`
@article{smith2020,
  title = {A Study of {Things}},
  author = {Smith, John Adam and Jones, Kate},
  journal = {Journal of Testing},
  volume = {12},
  number = {3},
  pages = {45--67},
  year = {2020},
  month = may,
  doi = {10.1000/xyz123},
  publisher = {Test Press}
}`)
    expect(skipped).toBe(0)
    expect(items).toEqual([{
      'id': 'smith2020',
      'type': 'article-journal',
      'title': 'A Study of Things',
      'container-title': 'Journal of Testing',
      'publisher': 'Test Press',
      'volume': '12',
      'issue': '3',
      'page': '45-67',
      'DOI': '10.1000/xyz123',
      'author': [{ family: 'Smith', given: 'John Adam' }, { family: 'Jones', given: 'Kate' }],
      'issued': { 'date-parts': [[2020, 5]] }
    }])
  })

  it('maps entry types and BibLaTeX fields', () => {
    const { items } = parseBibtex(`
@inproceedings{a, title={T}, author={A, B}, booktitle={Proc. X}, year=2021}
@phdthesis{b, title={T}, author={A, B}, school={ETH Z{\\"u}rich}, year=2018}
@online{c, title={T}, author={{World Health Organization}}, url={https://who.int}, urldate={2024-03-05}, date={2021-02}}
@misc{d, title={T}, howpublished={https://example.com}}
@techreport{e, title={T}, institution={NIST}, number={800-53}, year=2020}`)
    expect(items.map(i => i.type)).toEqual(['paper-conference', 'thesis', 'webpage', 'document', 'report'])
    expect(items[0]?.['container-title']).toBe('Proc. X')
    expect(items[1]?.publisher).toBe('ETH Zürich')
    expect(items[1]?.genre).toBe('PhD thesis')
    expect(items[2]?.author).toEqual([{ literal: 'World Health Organization' }])
    expect(items[2]?.accessed).toEqual({ 'date-parts': [[2024, 3, 5]] })
    expect(items[2]?.issued).toEqual({ 'date-parts': [[2021, 2]] })
    expect(items[3]?.URL).toBe('https://example.com')
    expect(items[4]?.number).toBe('800-53')
  })

  it('expands @string macros and # concatenation, skips comments', () => {
    const { items } = parseBibtex(`
@comment{ignored @article{x, title={no}} }
@string{jt = "Journal of Tests"}
@article{k, title = "Part " # "One", journal = jt, year = 1999}`)
    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('Part One')
    expect(items[0]?.['container-title']).toBe('Journal of Tests')
  })

  it('recovers after a broken entry', () => {
    const { items, skipped } = parseBibtex('@article{bad, title = {unterminated\n@book{good, title={Fine}, year=2000}')
    expect(items.map(i => i.id)).toEqual(['good'])
    expect(skipped).toBe(1)
  })

  it('skips entries without a usable key or content', () => {
    const { items, skipped } = parseBibtex('@misc{, title={No key}}\n@misc{nokey2}')
    expect(items).toEqual([])
    expect(skipped).toBe(2)
  })
})

describe('parseBibtexName', () => {
  it.each([
    ['Smith, John', { family: 'Smith', given: 'John' }],
    ['John Smith', { family: 'Smith', given: 'John' }],
    ['van der Berg, Anna', { 'family': 'Berg', 'given': 'Anna', 'non-dropping-particle': 'van der' }],
    ['Anna van der Berg', { 'family': 'Berg', 'given': 'Anna', 'non-dropping-particle': 'van der' }],
    ['King, Jr, Martin Luther', { family: 'King', given: 'Martin Luther', suffix: 'Jr' }],
    ['{Barnes and Noble}', { literal: 'Barnes and Noble' }],
    ['M{\\"u}ller, J{\\"o}rg', { family: 'Müller', given: 'Jörg' }]
  ])('%s', (raw, expected) => {
    expect(parseBibtexName(raw)).toEqual(expected)
  })
})

describe('latexToUnicode', () => {
  it.each([
    ['M{\\"u}ller', 'Müller'],
    ['\\\'{e}t\\\'e', 'été'],
    ['Fran\\c{c}ois', 'François'],
    ['Stra{\\ss}e', 'Straße'],
    ['\\v{S}koda', 'Škoda'],
    ['{\\o}re', 'øre'],
    ['R\\&D 10\\%', 'R&D 10%'],
    ['\\emph{Very} \\textbf{bold}', 'Very bold'],
    ['pp. 1--2', 'pp. 1–2'],
    ['{DNA} {\\TeX}book', 'DNA TeXbook']
  ])('%s', (raw, expected) => {
    expect(latexToUnicode(raw)).toBe(expected)
  })
})

describe('parseBibliographyText', () => {
  it('detects CSL JSON (Zotero export)', () => {
    const r = parseBibliographyText(JSON.stringify([{ id: 'doe2020', type: 'book', title: 'Book', author: [{ family: 'Doe', given: 'J.' }], issued: { 'date-parts': [[2020]] } }]))
    expect(r.format).toBe('csl-json')
    expect(r.items[0]?.id).toBe('doe2020')
  })

  it('detects CSL YAML (Pandoc references)', () => {
    const r = parseBibliographyText('references:\n  - id: roe2019\n    type: book\n    title: A Book\n    issued: 2019\n')
    expect(r.format).toBe('csl-yaml')
    expect(r.items[0]?.issued).toEqual({ 'date-parts': [[2019]] })
  })

  it('detects BibTeX and keeps the last duplicate', () => {
    const r = parseBibliographyText('@book{k, title={One}}\n@book{k, title={Two}}')
    expect(r.format).toBe('bibtex')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]?.title).toBe('Two')
  })

  it('returns nothing for plain text', () => {
    expect(parseBibliographyText('just some words').items).toEqual([])
  })
})
